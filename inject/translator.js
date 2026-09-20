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
  var VERSION = "0.1.2"; // 版本变化时，热更新会替换页面内已注入的旧实例
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
  var stats = { translated: 0, scans: 0 };

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
  function lookup(key) {
    var v = lookupBase(key);
    if (v !== undefined) return v;
    var m = TAIL_RE.exec(key);
    if (m && m[1]) {
      var inner = lookupBase(m[1].replace(/\s+$/, ""));
      if (inner !== undefined) return inner + m[2];
    }
    return undefined;
  }

  // ---------------- 未命中记录（供词典维护） ----------------
  function shouldRecord(key) {
    if (key.length < 2 || key.length > 60) return false;
    if (!/[A-Za-z]{2,}/.test(key)) return false;
    if (/[\u4e00-\u9fff]/.test(key)) return false;            // 已含中文
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
    return true;
  }
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
        node.nodeValue = orig;
      }
      return;
    }
    var val = parts.lead + out + parts.trail;
    if (val === raw) { textRec.set(node, { orig: orig, out: val }); return; }
    textRec.set(node, { orig: orig, out: val });
    node.nodeValue = val;
    stats.translated++;
  }

  // ---------------- 属性 ----------------
  function translateAttr(el, attr, force) {
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
        el.setAttribute(attr, orig);
      }
      return;
    }
    var val = parts.lead + out + parts.trail;
    if (!recs) { recs = {}; attrRec.set(el, recs); }
    recs[attr] = { orig: orig, out: val };
    if (val !== raw) {
      el.setAttribute(attr, val);
      stats.translated++;
    }
  }
  function translateAttrs(el, force) {
    for (var i = 0; i < attrNames.length; i++) translateAttr(el, attrNames[i], force);
  }

  // ---------------- 扫描 ----------------
  function scan(root, force) {
    if (!root) return;
    var t = root.nodeType;
    if (t === 3) { translateText(root, force); return; }
    if (t === 1) {
      if (matchesSkip(root)) return;
      translateAttrs(root, force);
      if (root.shadowRoot) { observeRoot(root.shadowRoot); scan(root.shadowRoot, force); }
    } else if (t !== 9 && t !== 11) {
      return;
    }
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (n.nodeType === 1) return matchesSkip(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
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
          if (insideSkip(el)) continue;
          scan(node, false);
        }
      } else if (m.type === "attributes") {
        if (!insideSkip(m.target)) translateAttr(m.target, m.attributeName, false);
      }
    }
  }
  function observeRoot(root) {
    if (!root || observedRoots.has(root)) return;
    observedRoots.add(root);
    var mo = new MutationObserver(onMutations);
    var opts = { childList: true, subtree: true, characterData: true };
    if (attrNames.length) { opts.attributes = true; opts.attributeFilter = attrNames.slice(); }
    mo.observe(root, opts);
    observers.push(mo);
  }
  function reobserveAll() {
    // 属性列表变化时需要重建 observer
    for (var i = 0; i < observers.length; i++) observers[i].disconnect();
    observers = [];
    observedRoots = new WeakSet();
    observeRoot(document);
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

    var sels = (dict.skipSelectors || []).filter(function (s) { return typeof s === "string" && validSelector(s); });
    skipSelector = sels.join(",");

    var newAttrs = (dict.attributes || []).filter(function (s) { return typeof s === "string" && /^[a-zA-Z_:][-a-zA-Z0-9_:.]*$/.test(s); });
    var attrsChanged = newAttrs.join("|") !== attrNames.join("|");
    attrNames = newAttrs;

    ready = true;
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
    for (var i = 0; i < observers.length; i++) observers[i].disconnect();
    observers = [];
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
    stats: function () { return { translated: stats.translated, scans: stats.scans, exact: exact.size, patterns: patterns.length }; },
  };
  try {
    Object.defineProperty(window, NS, { value: api, configurable: true, writable: true, enumerable: false });
  } catch (e) {
    window[NS] = api;
  }
})();
