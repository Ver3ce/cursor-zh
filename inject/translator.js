/*
 * cursor-zh 页面端翻译引擎
 * ------------------------------------------------------------
 * 由 CDP (Runtime.evaluate / Page.addScriptToEvaluateOnNewDocument) 注入到 Cursor 的每个渲染窗口。
 * 原理：遍历 DOM 文本节点与指定属性，按本地词典做精确/正则匹配并原地替换；
 *       用 MutationObserver 跟踪 React 的增量渲染。
 * 约束：
 *   - 只写 Text.nodeValue 与普通属性（title/aria-label/placeholder/alt），不触碰
 *     innerHTML / script / eval 等 Trusted Types 受控 sink，因而不受 workbench CSP 限制。
 *   - 幂等：重复注入时若版本一致直接复用现有实例；版本不同则先 dispose 旧实例。
 *   - 记录每个节点的 {原文, 译文}，词典热更新时可依据原文重译，也可在删词后还原。
 */
(function () {
  "use strict";
  if (typeof window === "undefined" || typeof document === "undefined") return;

  var NS = "__cursorZh";
  var VERSION = "0.1.6"; // 版本变化时，热更新会替换页面内已注入的旧实例
  var MAX_TEXT_LEN = 200;

  // 拆出首尾的空白与零宽字符（U+200B-200D / U+2060 / U+FEFF），保证 "Loading fonts...\u2060" 也能命中
  var EDGE_RE = /^([\s\u200B-\u200D\u2060\uFEFF]*)([\s\S]*?)([\s\u200B-\u200D\u2060\uFEFF]*)$/;
  function splitEdges(s) {
    var m = EDGE_RE.exec(s);
    return m ? { lead: m[1], core: m[2], trail: m[3] } : { lead: "", core: s, trail: "" };
  }

  var prev = window[NS];
  if (prev && prev.__version === VERSION) return; // 同版本已注入，等待外部 setDictionary
  if (prev && typeof prev.dispose === "function") {
    try { prev.dispose(); } catch (e) { /* ignore */ }
  }

  // ---------------- 状态 ----------------
  var exact = new Map();          // 原文 → 译文
  var lower = new Map();          // 小写原文 → 译文（无冲突时）
  var patterns = [];              // [{re, replace}]
  var suffixes = [];              // [{re, replace}] 可剥离的后缀，如 ". Open activity"
  var segmentSeps = [", "];       // 分段分隔符：各段独立翻译后用 segmentJoiner 拼接
  var segmentJoiner = "，";
  var skipSelector = "";          // 逗号拼接的选择器
  var attrNames = [];             // 需翻译的属性
  var textRec = new WeakMap();    // Text → {orig, out}
  var attrRec = new WeakMap();    // Element → {attr: {orig, out}}
  var missTexts = new Map();      // 未命中的文本 → 次数
  var missAttrs = new Map();
  var observers = [];
  var observedRoots = new WeakSet();
  var ready = false;
  var disposed = false;
  var stats = { translated: 0, scans: 0, trips: 0 };

  // ---------------- 词典查询 ----------------
  function lookupBase(key) {
    var v = exact.get(key);
    if (v !== undefined) return v;
    v = lower.get(key.toLowerCase());
    if (v !== undefined) return v;
    for (var i = 0; i < patterns.length; i++) {
      var p = patterns[i];
      p.re.lastIndex = 0;
      if (p.re.test(key)) {
        p.re.lastIndex = 0;
        return key.replace(p.re, p.replace);
      }
    }
    return undefined;
  }

  // 处理尾部标点：如 "Loading..." / "Settings:" / "Accept…"
  var TAIL_RE = /^(.*?)(\.\.\.|…|:|：)$/;
  function lookupSimple(key) {
    var v = lookupBase(key);
    if (v !== undefined) return v;
    var m = TAIL_RE.exec(key);
    if (m && m[1]) {
      var inner = lookupBase(m[1].replace(/\s+$/, ""));
      if (inner !== undefined) return inner + m[2];
    }
    return undefined;
  }

  // 不翻译也可原样放行的片段：文件名 / 路径 / 标识符（无空格且含 . 或 / 或 -）
  var PASSTHRU_RE = /^[\w@$][\w.\-\/\\:]*[.\-\/\\][\w.\-\/\\]*$/;

  /**
   * 组合查找：
   *   1. 直接命中
   *   2. 剥离可识别后缀（如 ". Open activity"、" +12 -3"），翻译前缀后再拼回
   *   3. 按 ", " 分段，各段独立翻译（段可为文件名放行），用 "，" 拼接
   * 递归深度限制为 3，避免病态输入。
   */
  function lookup(key, depth) {
    depth = depth || 0;
    var v = lookupSimple(key);
    if (v !== undefined) return v;
    if (depth >= 3) return undefined;

    for (var i = 0; i < suffixes.length; i++) {
      var s = suffixes[i];
      s.re.lastIndex = 0;
      var sm = s.re.exec(key);
      if (sm && sm.index > 0) {
        var prefix = key.slice(0, sm.index).replace(/\s+$/, "");
        var inner = lookup(prefix, depth + 1);
        if (inner !== undefined) return inner + sm[0].replace(s.re, s.replace);
      }
    }

    for (var j = 0; j < segmentSeps.length; j++) {
      var sep = segmentSeps[j];
      if (key.indexOf(sep) < 0) continue;
      var parts = key.split(sep);
      if (parts.length < 2 || parts.length > 8) continue;
      var out = [];
      var translatedAny = false;
      var ok = true;
      for (var k = 0; k < parts.length; k++) {
        var p = parts[k].trim();
        if (!p) { ok = false; break; }
        var t = lookup(p, depth + 1);
        if (t !== undefined) { out.push(t); translatedAny = true; }
        else if (PASSTHRU_RE.test(p) || !/[A-Za-z]/.test(p)) out.push(p);
        else { ok = false; break; }
      }
      if (ok && translatedAny) return out.join(segmentJoiner);
    }
    return undefined;
  }

  // ---------------- 未命中记录（供词典维护） ----------------
  // 常见英文虚词/碎片：出现在采集里几乎只可能来自被拆碎的 AI 回复正文
  var STOPWORDS = /^(a|an|the|to|of|in|on|at|by|for|and|or|but|so|if|is|are|was|were|be|been|it|its|it's|this|that|these|those|with|from|into|as|than|then|your|you|we|our|us|i|i'll|i'm|my|me|he|she|they|them|their|can|will|do|does|did|not|no|yes|up|down|out|over|under|about|after|before|while|until|between|across|through|via|per|vs|etc|use|used|uses|using|have|has|had|make|made|get|got|let|let's|like|just|also|more|most|less|very|own|same|only|first|last|now|here|there|when|where|how|what|which|who|why|all|any|each|both|some|such|other|another|new|old|one|two|three|work|works|run|runs|set|hit|turn|find|give|pick|move|keep|keeps|full|small|long|hard|best|better|great)$/i;
  function shouldRecord(key) {
    if (key.length < 2 || key.length > 60) return false;
    if (!/[A-Za-z]{2,}/.test(key)) return false;
    if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(key)) return false; // 含中文或全角标点
    if (STOPWORDS.test(key)) return false;
    if (/^[^A-Za-z0-9$@#+"'(\[]/.test(key)) return false;       // 以标点开头的句子碎片
    if (/^[a-z][a-z'\-]*[,.;:)]$/.test(key)) return false;      // 小写单词带尾标点："logs," "it."
    if (/^[a-z][a-z'\-]*$/.test(key) && key.length <= 4) return false; // 极短小写单词
    if (/[{}<>;=\\\/|`]/.test(key)) return false;               // 代码/路径特征
    if (/^[\w.@-]+\.[A-Za-z0-9]{1,5}$/.test(key)) return false; // 文件名
    if (/^https?:/i.test(key)) return false;
    if (key.split(/\s+/).length > 10) return false;
    // 键盘快捷键：Ctrl / Alt+Shift+P / Ctrl+, / F5 等
    if (/^(?:(?:Ctrl|Control|Alt|Shift|Cmd|Command|Win|Meta|Option|Esc|Escape|Del|Delete|Enter|Return|Tab|Space|Backspace|Home|End|PgUp|PgDn|PageUp|PageDown|Insert|Up|Down|Left|Right|F\d{1,2}|[A-Za-z0-9,.\-=\[\]\\;'`\/])\s*(?:\+\s*|$))+$/.test(key)) return false;
    // 文件状态片段："README.md, modified"
    if (/^[\w.\- ]+, (?:modified|added|deleted|renamed|untracked|conflict)$/i.test(key)) return false;
    // 允许列表 / 终端内容：shell 变量、PowerShell 动词-名词命令、"+ cmd" 建议项、常见 CLI 前缀
    if (/^\$/.test(key)) return false;
    if (/^(?:Remove |Add )?[A-Z][a-z]+-[A-Z][A-Za-z]+$/.test(key)) return false;
    if (/^\+ /.test(key)) return false;
    if (/^(?:npm|npx|pnpm|yarn|git|docker|node|python|pip|cargo|go|dotnet|curl|wget|ssh|netsh|choco|winget)\b/.test(key)) return false;
    // 代码 token（来自对话里的 diff / 代码视图被逐 token 渲染）：
    if (CODE_KEYWORDS.test(key)) return false;                                    // return / function / const …
    if (/^[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\.?$/.test(key)) return false;         // camelCase 标识符：nodeType / phStyle.
    if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(key)) return false;                 // 常量：PH_ATTR / BURST_LIMIT
    if (/^[a-z]+(?:_[a-z0-9]+)+$/.test(key)) return false;                         // snake_case
    if (/^["'].*["']$/.test(key)) return false;                                    // 字面量："placeholder"
    if (/^[(\[]?[\w$]+\.[\w$]*[(\[]?$|^[\w$]+\.$|^\([\w$.]+$/.test(key)) return false; // 成员访问碎片：(root. / textRec. / NodeFilter.
    if (/^[\w$]+\([\w$., ]*$/.test(key)) return false;                             // 调用碎片：translatePlaceholdersWithin(n
    return true;
  }
  var CODE_KEYWORDS = /^(?:return|function|const|let|var|if|else|for|while|do|switch|case|break|continue|default|try|catch|finally|throw|new|delete|typeof|instanceof|void|in|of|class|extends|super|this|null|undefined|true|false|import|export|from|async|await|yield|static|get|set|document|window|self|def|elif|pass|lambda|None|True|False|struct|enum|impl|fn|pub|mut|nil|func|package|interface|namespace|using|public|private|protected|override|virtual|string|int|bool|float|double|char|byte)$/;
  function recordMiss(map, key) {
    if (!shouldRecord(key)) return;
    map.set(key, (map.get(key) || 0) + 1);
  }

  // ---------------- 跳过区域 ----------------
  function matchesSkip(el) {
    if (!skipSelector) return false;
    try { return el.matches(skipSelector); } catch (e) { return false; }
  }
  function insideSkip(el) {
    if (!el || !skipSelector) return false;
    try { return !!el.closest(skipSelector); } catch (e) { return false; }
  }

  // ---------------- 文本节点 ----------------
  function translateText(node, force) {
    var raw = node.nodeValue;
    if (!raw) return;
    var parent = node.parentNode;
    if (parent && parent.nodeType === 1 && parent.tagName === "TEXTAREA") return;

    var rec = textRec.get(node);
    var orig;
    if (rec && raw === rec.out) {
      if (!force) return;           // 是我们自己写入的值
      orig = rec.orig;
    } else {
      orig = raw;                   // 外部（React）写入的新内容
    }

    var parts = splitEdges(orig);
    var key = parts.core;
    if (!key || key.length > MAX_TEXT_LEN || !/[A-Za-z]/.test(key)) return;

    var out = lookup(key);
    if (out === undefined) {
      recordMiss(missTexts, key);
      if (rec && raw !== orig) {    // 词典已删除该条，还原原文
        textRec.delete(node);
        noteWrite();
        node.nodeValue = orig;
      }
      return;
    }
    var val = parts.lead + out + parts.trail;
    if (val === raw) { textRec.set(node, { orig: orig, out: val }); return; }
    textRec.set(node, { orig: orig, out: val });
    noteWrite();
    node.nodeValue = val;
    stats.translated++;
  }

  // ---------------- 属性 ----------------
  function translateAttr(el, attr, force) {
    if (attr === PH_ATTR) { translatePlaceholderCss(el); return; }  // 永不改写，走 CSS
    if (!el.hasAttribute(attr)) return;
    var raw = el.getAttribute(attr);
    if (!raw) return;
    var recs = attrRec.get(el);
    var rec = recs && recs[attr];
    var orig;
    if (rec && raw === rec.out) {
      if (!force) return;
      orig = rec.orig;
    } else {
      orig = raw;
    }
    var parts = splitEdges(orig);
    var key = parts.core;
    if (!key || key.length > MAX_TEXT_LEN || !/[A-Za-z]/.test(key)) return;

    var out = lookup(key);
    if (out === undefined) {
      recordMiss(missAttrs, key);
      if (rec && raw !== orig) {
        delete recs[attr];
        noteWrite();
        el.setAttribute(attr, orig);
      }
      return;
    }
    var val = parts.lead + out + parts.trail;
    if (!recs) { recs = {}; attrRec.set(el, recs); }
    recs[attr] = { orig: orig, out: val };
    if (val !== raw) {
      noteWrite();
      el.setAttribute(attr, val);
      stats.translated++;
    }
  }
  function translateAttrs(el, force) {
    for (var i = 0; i < attrNames.length; i++) translateAttr(el, attrNames[i], force);
  }

  // ---------------- 富文本输入框的占位符（CSS 方案） ----------------
  // ProseMirror/tiptap 的占位符挂在编辑器内部 <p data-placeholder="…">，由 CSS `::before{content:attr(data-placeholder)}` 显示。
  // 绝不能对它 setAttribute：ProseMirror 自己也在观察编辑器内的属性变化并会改回去，两个 MutationObserver
  // 会在微任务里互相触发形成死循环，整个渲染进程假死（0.1.4 曾因此导致 Cursor 卡在"正在加载对话"）。
  // 改为注入一条 CSS 规则覆盖 ::before 的 content，不碰 DOM。
  var PH_ATTR = "data-placeholder";
  var phStyle = null;          // <style> 元素
  var phRules = new Set();     // 已注入的"属性值"，避免重复
  function phSheet() {
    if (phStyle && phStyle.isConnected) return phStyle.sheet;
    try {
      phStyle = document.createElement("style");
      phStyle.setAttribute("data-cursor-zh", "placeholder");
      (document.head || document.documentElement).appendChild(phStyle);
      return phStyle.sheet;
    } catch (e) { return null; }
  }
  function phClear() {
    phRules.clear();
    if (phStyle && phStyle.parentNode) phStyle.parentNode.removeChild(phStyle);
    phStyle = null;
  }
  function cssString(s) { return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\a ") + '"'; }
  function unquote(s) { return typeof s === "string" ? s.replace(/^["'](.*)["']$/, "$1") : s; }
  /** 某元素的 data-placeholder 若被 ::before/::after 用 attr() 显示，则为其值注入译文规则 */
  function translatePlaceholderCss(el) {
    if (!el || el.nodeType !== 1 || !el.hasAttribute(PH_ATTR)) return;
    var raw = el.getAttribute(PH_ATTR);
    if (!raw || phRules.has(raw)) return;
    var key = splitEdges(raw).core;
    if (!key || key.length > MAX_TEXT_LEN || !/[A-Za-z]/.test(key)) return;
    var out = lookup(key);
    if (out === undefined) { recordMiss(missAttrs, key); return; }
    var pseudo = null;
    try {
      if (unquote(getComputedStyle(el, "::before").content) === raw) pseudo = "::before";
      else if (unquote(getComputedStyle(el, "::after").content) === raw) pseudo = "::after";
    } catch (e) { /* ignore */ }
    if (!pseudo) return;  // 不是用 attr() 显示的，不知道显示机制，不动
    var sheet = phSheet();
    if (!sheet) return;
    try {
      sheet.insertRule("[" + PH_ATTR + "=" + cssString(raw) + "]" + pseudo + "{content:" + cssString(out) + " !important}", sheet.cssRules.length);
      phRules.add(raw);
      stats.translated++;
    } catch (e) { /* ignore */ }
  }
  function translatePlaceholdersWithin(root) {
    if (!root || root.nodeType !== 1) return;
    translatePlaceholderCss(root);
    var list = root.querySelectorAll("[" + PH_ATTR + "]");
    for (var i = 0; i < list.length; i++) translatePlaceholderCss(list[i]);
  }

  // ---------------- 写入风暴保护 ----------------
  // 若与页面框架（React/ProseMirror）互相触发，MutationObserver 回调会在同一轮微任务里无限往复，
  // 不会让出主线程。这里统计"未让出主线程期间"的 DOM 写入次数，超限即断开所有观察者，稍后再恢复。
  var BURST_LIMIT = 20000;
  var TRIP_COOLDOWN = 3000;
  var burst = 0, burstTimer = null, tripped = false, tripTimer = null;
  function noteWrite() {
    burst++;
    if (burstTimer === null) burstTimer = setTimeout(function () { burst = 0; burstTimer = null; }, 0);
    if (burst > BURST_LIMIT) { burst = 0; trip(); }
  }
  // 可重入：冷却期内若再次被触发（例如词典重载引起 rescan 又撞上同一个对抗者），再次断开并重新计时。
  // 冷却期内 observeRoot/reobserveAll 一律不接观察者，避免"被别处重新接上但不再触发保护"的窟窿。
  function trip() {
    tripped = true;
    stats.trips++;
    disconnectObservers();
    try { console.warn("[cursor-zh] 检测到 DOM 写入风暴（>" + BURST_LIMIT + " 次未让出主线程），已暂停翻译 " + (TRIP_COOLDOWN / 1000) + " 秒以保护页面"); } catch (e) { /* ignore */ }
    if (tripTimer !== null) clearTimeout(tripTimer);
    tripTimer = setTimeout(function () {
      tripTimer = null; tripped = false; burst = 0; burstTimer = null;
      if (!disposed && ready) { reobserveAll(); rescan(); }
    }, TRIP_COOLDOWN);
  }

  // ---------------- 扫描 ----------------
  function scan(root, force) {
    if (!root) return;
    var t = root.nodeType;
    if (t === 3) { translateText(root, force); return; }
    if (t === 1) {
      if (matchesSkip(root)) { translatePlaceholdersWithin(root); return; }
      translateAttrs(root, force);
      if (root.shadowRoot) { observeRoot(root.shadowRoot); scan(root.shadowRoot, force); }
    } else if (t !== 9 && t !== 11) {
      return;
    }
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (n.nodeType === 1) {
          if (!matchesSkip(n)) return NodeFilter.FILTER_ACCEPT;
          translatePlaceholdersWithin(n);  // 只读 + 注入 CSS，不写 DOM
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    var n;
    while ((n = walker.nextNode())) {
      if (n.nodeType === 3) {
        translateText(n, force);
      } else {
        translateAttrs(n, force);
        if (n.shadowRoot) { observeRoot(n.shadowRoot); scan(n.shadowRoot, force); }
      }
    }
    stats.scans++;
  }

  // ---------------- 变更监听 ----------------
  function onMutations(list) {
    if (disposed || !ready) return;
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      if (m.type === "characterData") {
        var tn = m.target;
        if (!insideSkip(tn.parentElement)) translateText(tn, false);
      } else if (m.type === "childList") {
        for (var j = 0; j < m.addedNodes.length; j++) {
          var node = m.addedNodes[j];
          var el = node.nodeType === 1 ? node : node.parentElement;
          if (insideSkip(el)) {
            // 可编辑区内新建的占位节点（tiptap 清空后重建 <p data-placeholder>）：只注入 CSS
            if (node.nodeType === 1) translatePlaceholdersWithin(node);
            continue;
          }
          scan(node, false);
        }
      } else if (m.type === "attributes") {
        if (m.attributeName === PH_ATTR) translatePlaceholderCss(m.target);
        else if (!insideSkip(m.target)) translateAttr(m.target, m.attributeName, false);
      }
    }
  }
  function observeRoot(root) {
    if (tripped || !root || observedRoots.has(root)) return;
    observedRoots.add(root);
    var mo = new MutationObserver(onMutations);
    var opts = { childList: true, subtree: true, characterData: true };
    if (attrNames.length) { opts.attributes = true; opts.attributeFilter = attrNames.slice(); }
    mo.observe(root, opts);
    observers.push(mo);
  }
  function disconnectObservers() {
    for (var i = 0; i < observers.length; i++) observers[i].disconnect();
    observers = [];
    observedRoots = new WeakSet();
  }
  function reobserveAll() {
    // 属性列表变化 / 风暴保护恢复时重建 observer；冷却期内只断不接
    disconnectObservers();
    if (!tripped) observeRoot(document);
  }

  // 捕获之后创建的 open shadow root
  var origAttachShadow = Element.prototype.attachShadow;
  var hooked = false;
  function hookAttachShadow() {
    if (hooked || typeof origAttachShadow !== "function") return;
    hooked = true;
    try {
      Element.prototype.attachShadow = function (init) {
        var root = origAttachShadow.call(this, init);
        try { if (init && init.mode === "open") { observeRoot(root); scan(root, false); } } catch (e) { /* ignore */ }
        return root;
      };
    } catch (e) { hooked = false; }
  }
  function unhookAttachShadow() {
    if (!hooked) return;
    try { Element.prototype.attachShadow = origAttachShadow; } catch (e) { /* ignore */ }
    hooked = false;
  }

  // ---------------- 公开 API ----------------
  function validSelector(sel) {
    try { document.createDocumentFragment().querySelector(sel); return true; } catch (e) { return false; }
  }

  function setDictionary(dict) {
    dict = dict || {};
    exact = new Map();
    lower = new Map();
    var lowerDup = new Set();
    var ex = dict.exact || {};
    for (var k in ex) {
      if (!Object.prototype.hasOwnProperty.call(ex, k)) continue;
      var v = ex[k];
      if (typeof v !== "string") continue;
      exact.set(k, v);
      var lk = k.toLowerCase();
      if (lower.has(lk) && lower.get(lk) !== v) lowerDup.add(lk);
      else lower.set(lk, v);
    }
    lowerDup.forEach(function (lk) { lower.delete(lk); });

    patterns = [];
    var ps = dict.patterns || [];
    for (var i = 0; i < ps.length; i++) {
      var p = ps[i];
      if (!p || typeof p.match !== "string" || typeof p.replace !== "string") continue;
      try {
        var flags = (p.flags || "").replace(/g/g, "");
        patterns.push({ re: new RegExp(p.match, flags), replace: p.replace });
      } catch (e) { /* 无效正则忽略 */ }
    }

    suffixes = [];
    var sf = dict.suffixes || [];
    for (var si = 0; si < sf.length; si++) {
      var sr = sf[si];
      if (!sr || typeof sr.match !== "string" || typeof sr.replace !== "string") continue;
      try {
        var src = /\$$/.test(sr.match) ? sr.match : sr.match + "$";
        suffixes.push({ re: new RegExp(src, (sr.flags || "").replace(/g/g, "")), replace: sr.replace });
      } catch (e) { /* ignore */ }
    }
    if (Array.isArray(dict.segmentSeparators)) {
      segmentSeps = dict.segmentSeparators.filter(function (s) { return typeof s === "string" && s.length; });
    }
    if (typeof dict.segmentJoiner === "string") segmentJoiner = dict.segmentJoiner;

    var sels = (dict.skipSelectors || []).filter(function (s) { return typeof s === "string" && validSelector(s); });
    skipSelector = sels.join(",");

    var newAttrs = (dict.attributes || []).filter(function (s) { return typeof s === "string" && /^[a-zA-Z_:][-a-zA-Z0-9_:.]*$/.test(s); });
    var attrsChanged = newAttrs.join("|") !== attrNames.join("|");
    attrNames = newAttrs;

    ready = true;
    phClear();  // 词典变化后占位符译文可能不同，重新生成 CSS 规则
    hookAttachShadow();
    if (attrsChanged || observers.length === 0) reobserveAll();
    rescan();
  }

  function rescan() {
    if (!ready) return;
    scan(document, true);
  }

  function collect() {
    scan(document, false);
    var t = {}, a = {};
    missTexts.forEach(function (n, k) { t[k] = n; });
    missAttrs.forEach(function (n, k) { a[k] = n; });
    return { texts: t, attrs: a, url: location.href, stats: { translated: stats.translated, scans: stats.scans } };
  }

  function clearMisses() { missTexts.clear(); missAttrs.clear(); }

  function dispose() {
    disposed = true;
    if (tripTimer !== null) { clearTimeout(tripTimer); tripTimer = null; }
    disconnectObservers();
    phClear();
    unhookAttachShadow();
    if (window[NS] === api) { try { delete window[NS]; } catch (e) { window[NS] = undefined; } }
  }

  var api = {
    __version: VERSION,
    setDictionary: setDictionary,
    rescan: rescan,
    collect: collect,
    clearMisses: clearMisses,
    dispose: dispose,
    stats: function () { return { translated: stats.translated, scans: stats.scans, trips: stats.trips, exact: exact.size, patterns: patterns.length }; },
  };
  try {
    Object.defineProperty(window, NS, { value: api, configurable: true, writable: true, enumerable: false });
  } catch (e) {
    window[NS] = api;
  }
})();
