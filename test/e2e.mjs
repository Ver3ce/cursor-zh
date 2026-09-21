/**
 * 端到端测试：用 headless Edge/Chrome 模拟 Cursor 渲染进程，
 * 通过项目的 CdpClient/Injector 注入真实词典，断言翻译结果。
 *
 *   node test/e2e.mjs                 使用 dist/ 的模块（需先 npm run build）
 *   node test/e2e.mjs --exe <path>    额外用打包好的 exe 跑一次 collect，验证 SEA 资产加载
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = pathToFileURL(path.join(ROOT, "test", "fixture.html")).href;
const exeArgIdx = process.argv.indexOf("--exe");
const EXE = exeArgIdx > -1 ? path.resolve(process.argv[exeArgIdx + 1]) : undefined;

function findBrowser() {
  const c = [
    process.env.CZ_TEST_BROWSER,
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    path.join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe"),
  ].filter(Boolean);
  const hit = c.find((p) => fs.existsSync(p));
  if (!hit) throw new Error("未找到 Edge/Chrome，可用 CZ_TEST_BROWSER 指定路径");
  return hit;
}

function freePort() {
  return new Promise((res) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
}

let fails = 0;
const expect = (name, actual, wanted) => {
  const ok = JSON.stringify(actual) === JSON.stringify(wanted);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${JSON.stringify(actual)}${ok ? "" : "  期望 " + JSON.stringify(wanted)}`);
  if (!ok) fails++;
};

const port = await freePort();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-zh-e2e-"));
const browser = spawn(
  findBrowser(),
  ["--headless=new", "--disable-gpu", "--no-first-run", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, FIXTURE],
  { stdio: "ignore" },
);
const cleanup = () => {
  try { browser.kill("SIGKILL"); } catch { /* ignore */ }
  setTimeout(() => fs.rmSync(profile, { recursive: true, force: true }), 500);
};
process.on("exit", cleanup);

try {
  const { CdpClient, waitForDebugPort } = await import(pathToFileURL(path.join(ROOT, "dist/cdp.js")).href);
  const { Injector } = await import(pathToFileURL(path.join(ROOT, "dist/injector.js")).href);
  const { loadDictionary, loadTranslatorSource, buildInjectSource } = await import(pathToFileURL(path.join(ROOT, "dist/dictionary.js")).href);

  const wsUrl = await waitForDebugPort(port, 20000);
  const client = await CdpClient.connect(wsUrl);
  const injector = new Injector(client, () => {});
  const dict = loadDictionary("dict/zh-CN.json");
  const translator = loadTranslatorSource();
  await injector.start(buildInjectSource(translator, dict));

  // CI runner 上 Edge 首次启动较慢：轮询直到 fixture 页面加载完成且已注入
  const deadline = Date.now() + 30_000;
  let lastSeen = [];
  for (;;) {
    const res = await injector.evaluateAll(
      "(function(){return {ready: !!window.__cursorZh, state: document.readyState, dyn: !!document.getElementById('dynBtn')};})()",
    );
    lastSeen = res.map((r) => `${r.type} ${r.url} ${JSON.stringify(r.value)}`);
    const hit = res.find((r) => /fixture\.html/.test(r.url) && r.value?.ready && r.value.state === "complete" && r.value.dyn);
    if (hit) break;
    if (Date.now() > deadline) throw new Error(`fixture 页面在 30s 内未就绪。当前 targets:\n  ${lastSeen.join("\n  ") || "(无)"}`);
    await new Promise((r) => setTimeout(r, 300));
  }
  await new Promise((r) => setTimeout(r, 500)); // 等 mode 文本被脚本改写（fixture 内 +200ms）

  const read = async () => {
    const res = await injector.evaluateAll(`(function(){
      var g=function(id){var e=document.getElementById(id);return e?e.textContent:null;};
      var host=document.getElementById('host');
      return {
        b1:g('b1'), b1title:document.getElementById('b1').getAttribute('title'),
        b2aria:document.getElementById('b2').getAttribute('aria-label'),
        mode:g('mode'), thought:g('thought'), files:g('files'), loading:g('loading'), unknown:g('unknown'),
        zw:g('zw'), worked:g('worked'), sum:g('sum'), rm:g('rm'), ran:g('ran'), ed:g('ed'),
        placeholder:document.getElementById('inp').placeholder, inputValue:document.getElementById('inp').value,
        editable:g('editor'),
        pmAttr:document.getElementById('pmph').getAttribute('data-placeholder'),
        pmShown:getComputedStyle(document.getElementById('pmph'),'::before').content,
        pmResets:window.__pmResets||0,
        pre:g('pre'), monaco:document.querySelector('.monaco-editor span').textContent,
        shadow: host && host.shadowRoot ? host.shadowRoot.getElementById('shadowText').textContent : null,
        dyn:g('dynBtn'),
        comp:g('comp'), suf:g('suf'), pass:g('pass'), nomatch:g('nomatch'), readsuf:g('readsuf'),
        aiProse:g('aiProse'), humanMsg:g('humanMsg'), aiMd:g('aiMd'), pickerMd:g('pickerMd'),
        misses: Object.keys(window.__cursorZh.collect().texts)
      };
    })()`);
    return res.find((r) => /fixture\.html/.test(r.url))?.value;
  };

  const v = await read();
  expect("按钮文本", v.b1, "发送");
  expect("title 属性", v.b1title, "发送消息");
  expect("aria-label 属性", v.b2aria, "停止生成");
  expect("React 改写文本后重译", v.mode, "计划");
  expect("正则模板", v.thought, "思考了 12 秒");
  expect("正则模板2", v.files, "3 个文件已更改");
  expect("尾部省略号", v.loading, "加载中...");
  expect("未收录保持英文", v.unknown, "Some Unknown Label");
  expect("零宽字符", v.zw, "正在加载字体...\u2060");
  expect("Worked for", v.worked, "工作了 5 分 16 秒");
  expect("摘要模板", v.sum, "2 个文件，运行了 2 条命令 +22 -1");
  expect("Remove 模板", v.rm, "移除 $d.city");
  expect("exact 优先于 pattern", v.ran, "已运行类型检查");
  expect("Editing 文件名", v.ed, "正在编辑 zh-CN.json");
  expect("placeholder 翻译", v.placeholder, "计划、搜索、构建任何内容");
  expect("input value 不动", v.inputValue, "Accept");
  expect("contenteditable 跳过", v.editable, "Accept all");
  expect("ProseMirror 占位符：属性不被改写", v.pmAttr, "Send follow-up");
  expect("ProseMirror 占位符：::before 显示译文", v.pmShown, '"发送追问"');
  expect("ProseMirror 占位符：未触发编辑器回写", v.pmResets, 0);
  expect("pre 跳过", v.pre, "Reject all");
  expect("monaco 跳过", v.monaco, "Keep all");
  expect("shadow DOM", v.shadow, "审查更改");
  expect("动态节点", v.dyn, "全部接受");
  expect("未命中已记录", v.misses.includes("Some Unknown Label"), true);
  expect("采集过滤 PowerShell 命令", v.misses.includes("Get-ChildItem"), false);
  expect("采集过滤 + cmd", v.misses.includes("+ git status"), false);
  expect("采集过滤 $var", v.misses.includes("$ProgressPreference"), false);
  expect("采集过滤快捷键", v.misses.includes("Ctrl+Shift+N"), false);
  expect("组合：分段 + 后缀", v.comp, "3 个文件，探索了 1 次搜索，运行了 2 条命令 +153 -30");
  expect("组合：后缀 Open activity", v.suf, "等待 shell 最多 1 分 47 秒。打开活动");
  expect("组合：文件名段放行", v.pass, "e2e.mjs，运行了 3 条命令 +15 -1");
  expect("组合：不可译段保持原文", v.nomatch, "Write-Host, gh, Select-Object");
  expect("组合：pattern + 后缀", v.readsuf, "正在读取 AAAI26_MPMA.pdf。打开活动");
  expect("AI 回复正文不翻译", v.aiProse, "Open the x file and Copy");
  expect("用户消息不翻译", v.humanMsg, "Send");
  expect("AI markdown-root 不翻译", v.aiMd, "Copy");
  expect("模型选择器 markdown 仍翻译", v.pickerMd, "明显更快，但消耗更多用量");
  expect("AI 正文碎片不进采集", v.misses.includes("Open the"), false);

  // 热更新：新增词条、删除词条
  const dict2 = structuredClone(dict);
  dict2.exact["Some Unknown Label"] = "某个未知标签";
  delete dict2.exact["Send"];
  await injector.updateSource(buildInjectSource(translator, dict2));
  await new Promise((r) => setTimeout(r, 300));
  const v2 = await read();
  expect("热更新新增词条", v2.unknown, "某个未知标签");
  expect("热更新删词还原原文", v2.b1, "Send");
  await injector.updateSource(buildInjectSource(translator, dict));
  await new Promise((r) => setTimeout(r, 300));
  expect("重复注入后恢复", (await read()).b1, "发送");

  // 写入风暴保护：模拟一个会把 title 改回英文的框架观察者，与翻译器互相触发。
  // 没有保护时页面会在微任务里死循环（evaluate 永不返回）；有保护时应在几毫秒内断开并保持页面可响应。
  const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);
  await withTimeout(injector.evaluateAll(`(function(){
    var b=document.createElement('button');b.id='fight';b.title='Send message';document.body.appendChild(b);
    new MutationObserver(function(){ if(b.title!=='Send message'){ window.__fightResets=(window.__fightResets||0)+1; b.title='Send message'; } })
      .observe(b,{attributes:true});
    return 'armed';
  })()`), 15000);
  await new Promise((r) => setTimeout(r, 400));
  const storm = await withTimeout(injector.evaluateAll(`(function(){return {trips:window.__cursorZh.stats().trips, resets:window.__fightResets||0};})()`), 15000);
  const s = storm?.find((r) => /fixture\.html/.test(r.url))?.value;
  expect("写入风暴：页面仍可响应", !!s, true);
  expect("写入风暴：保护已触发", (s?.trips ?? 0) >= 1, true);
  expect("写入风暴：往复次数被截断", (s?.resets ?? Infinity) <= 21000, true);
  client.close();

  // 可选：用打包好的 exe 跑 collect，验证 SEA 资产与外部词典加载
  if (EXE) {
    console.log(`\n== exe 验证: ${EXE}`);
    const exeDir = path.dirname(EXE);
    fs.writeFileSync(path.join(exeDir, "config.json"), JSON.stringify({ port, cursorPath: "C:/placeholder/Cursor.exe" }), "utf8");
    const out = execFileSync(EXE, ["collect"], { encoding: "utf8", cwd: exeDir, timeout: 30000 });
    const untranslated = path.join(exeDir, "dict", "untranslated.json");
    expect("exe collect 已连接", /已连接调试端口/.test(out), true);
    expect("exe collect 导出文件", fs.existsSync(untranslated), true);
    const u = JSON.parse(fs.readFileSync(untranslated, "utf8"));
    expect("exe collect 含未命中", "Some Unknown Label" in u.entries, true);
    fs.rmSync(untranslated, { force: true });
    fs.rmSync(path.join(exeDir, "config.json"), { force: true });
  }
} catch (e) {
  console.error("测试异常:", e);
  fails++;
} finally {
  cleanup();
}

console.log(fails ? `\n${fails} 项失败` : "\n全部通过");
process.exit(fails ? 1 : 0);
