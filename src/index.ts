#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { CdpClient, fetchBrowserWsUrl, waitForDebugPort } from "./cdp.js";
import { hasConfig, loadConfig, type AppConfig } from "./config.js";
import {
  buildInjectSource,
  loadDictionary,
  loadTranslatorSource,
  readDictionaryText,
  watchDictionary,
  type Dictionary,
} from "./dictionary.js";
import { Injector } from "./injector.js";
import { closeCursor, detectCursorPaths, isCursorRunning, launchCursor } from "./launcher.js";
import { restoreLocale, currentLocale } from "./langpack.js";
import { APP_ROOT, IS_SEA, logDir, resolveFromRoot } from "./paths.js";
import { desktopDir, focusCursorWindow, isWindows, minimizeConsole } from "./platform/win.js";
import { runSetup, SHORTCUT_NAME } from "./setup.js";
import { updateDictionary } from "./update.js";

// exe 构建时由 esbuild define 注入；开发模式读取 package.json
declare const __CZ_VERSION__: string | undefined;
function readVersion(): string {
  if (typeof __CZ_VERSION__ === "string") return __CZ_VERSION__;
  try {
    return (JSON.parse(fs.readFileSync(path.join(APP_ROOT, "package.json"), "utf8")) as { version: string }).version;
  } catch {
    return "dev";
  }
}
const VERSION = readVersion();

// ---------- 日志 ----------
let logStream: fs.WriteStream | undefined;
function log(msg: string): void {
  const line = `[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] ${msg}`;
  console.log(line);
  try {
    if (!logStream) {
      fs.mkdirSync(logDir(), { recursive: true });
      logStream = fs.createWriteStream(path.join(logDir(), "cursor-zh.log"), { flags: "a" });
    }
    logStream.write(line + "\n");
  } catch {
    /* 日志写盘失败不影响主流程 */
  }
}

/** 由双击 exe 或 cursor-zh.cmd 拉起时（窗口会随进程关闭），出错后暂停，避免窗口一闪而过 */
function isOwnWindow(): boolean {
  return (IS_SEA || process.env.CZ_LAUNCHER === "cmd") && !!process.stdin.isTTY;
}

async function pauseIfDoubleClicked(): Promise<void> {
  if (!isOwnWindow()) return;
  await new Promise<void>((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("\n按回车键退出…", () => {
      rl.close();
      resolve();
    });
  });
}

/** 控制台询问是/否；非交互环境直接返回 fallback */
async function confirm(question: string, fallback: boolean): Promise<boolean> {
  if (!process.stdin.isTTY) return fallback;
  return new Promise<boolean>((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} ${fallback ? "[Y/n]" : "[y/N]"} `, (ans) => {
      rl.close();
      const a = ans.trim().toLowerCase();
      resolve(a === "" ? fallback : a === "y" || a === "yes");
    });
  });
}

/** 退出前把日志写盘；否则 process.exit 会丢掉尚未 flush 的最后几行（尤其是错误行） */
function flushLog(): Promise<void> {
  return new Promise((resolve) => {
    const s = logStream;
    if (!s) return resolve();
    logStream = undefined;
    s.end(() => resolve());
  });
}

async function fail(msg: string, code = 1): Promise<never> {
  log(`错误: ${msg}`);
  log(`日志文件: ${path.join(logDir(), "cursor-zh.log")}`);
  await flushLog();
  await pauseIfDoubleClicked();
  process.exit(code);
}

// ---------- 参数解析 ----------
interface Cli {
  command: string;
  flags: Set<string>;
  passthrough: string[];
}

function parseArgv(argv: string[]): Cli {
  const [first = "", ...rest0] = argv;
  // 允许 "cursor-zh.exe --yes"（无命令，只有 flag）
  const command = first.startsWith("--") ? "" : first;
  const rest = first.startsWith("--") ? argv : rest0;
  const flags = new Set<string>();
  const passthrough: string[] = [];
  let sawSeparator = false;
  for (const a of rest) {
    if (sawSeparator) passthrough.push(a);
    else if (a === "--") sawSeparator = true;
    else if (a.startsWith("--")) flags.add(a.slice(2));
    else passthrough.push(a);
  }
  return { command, flags, passthrough };
}

function printHelp(): void {
  console.log(`cursor-zh v${VERSION} — Cursor 界面运行时汉化（CDP 注入，不修改 Cursor 安装文件）

用法（exe 与 node dist/index.js 相同）:
  cursor-zh                 首次运行进入向导；之后等同于 start
  cursor-zh setup           重新运行向导  [--yes 全部默认] [--no-langpack] [--no-locale] [--no-shortcut]
  cursor-zh start [--restart] [--force] [-- <传给 Cursor 的参数>]
                            以调试端口启动 Cursor 并持续注入翻译。本工具留在后台（自己的窗口会最小化），
                            Cursor 切到前台。再次双击快捷方式不会新开一份：Cursor 在跑就把它放到前台，
                            没在跑就重新启动。Cursor 已在运行但没有调试端口时会询问是否关闭并重启
                            （--restart 跳过询问）。控制台内可输入:
                              r 重载词典  c 导出未翻译  s 会话数  n 前台重启 Cursor  q 退出本工具
  cursor-zh restart         请后台中的 cursor-zh 关闭并在前台重新启动 Cursor（没有后台实例时自己做）
  cursor-zh attach          连接到已用 --remote-debugging-port 启动的 Cursor，并同样留在后台
  cursor-zh collect         导出所有窗口中未翻译的英文文案到 dict/untranslated.json 后退出
  cursor-zh update-dict     从 GitHub 拉取最新词典（仅此命令会联网）
  cursor-zh detect          打印探测到的 Cursor.exe 路径
  cursor-zh uninstall       删除桌面快捷方式，可选还原显示语言 [--restore-locale]
  cursor-zh version | help
`);
}

// ---------- 词典装载 ----------
function loadSource(cfg: AppConfig): { source: string; dict: Dictionary } {
  const dict = loadDictionary(cfg.dictionary);
  return { source: buildInjectSource(loadTranslatorSource(), dict), dict };
}

// ---------- collect ----------
interface CollectResult {
  texts: Record<string, number>;
  attrs: Record<string, number>;
}

async function exportUntranslated(cfg: AppConfig, injector: Injector, dict: Dictionary): Promise<string> {
  const results = await injector.evaluateAll<CollectResult | null>(
    "(function(){try{return window.__cursorZh?window.__cursorZh.collect():null;}catch(e){return null;}})()",
  );
  const merged: Record<string, number> = {};
  for (const r of results) {
    if (!r.value) continue;
    for (const bucket of [r.value.texts, r.value.attrs]) {
      for (const [k, n] of Object.entries(bucket ?? {})) {
        if (dict.exact[k] !== undefined) continue;
        merged[k] = (merged[k] ?? 0) + n;
      }
    }
  }
  const sorted = Object.fromEntries(Object.entries(merged).sort((a, b) => b[1] - a[1]));
  const outFile = resolveFromRoot(path.join(path.dirname(cfg.dictionary), "untranslated.json"));
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const payload = {
    _comment: "由 collect 导出：键为页面中出现但词典未收录的英文文案，值为出现次数。翻译后加入 zh-CN.json 的 exact，或提交到 GitHub 仓库。",
    generatedAt: new Date().toISOString(),
    count: Object.keys(sorted).length,
    entries: sorted,
  };
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2), "utf8");
  return outFile;
}

// ---------- 主流程 ----------
async function connectAndInject(cfg: AppConfig, wsUrl: string): Promise<{ client: CdpClient; injector: Injector; getDict: () => Dictionary; reload: () => Promise<void> }> {
  const client = await CdpClient.connect(wsUrl);
  const injector = new Injector(client, log);
  let { source, dict } = loadSource(cfg);
  await injector.start(source);
  log(`已连接调试端口，词典: ${readDictionaryText(cfg.dictionary).source}（${Object.keys(dict.exact).length} 精确 / ${dict.patterns.length} 正则）`);

  const reload = async () => {
    ({ source, dict } = loadSource(cfg));
    await injector.updateSource(source);
    log(`词典已重载（${Object.keys(dict.exact).length} 条）`);
  };
  if (cfg.watchDictionary) {
    watchDictionary(cfg.dictionary, () => reload().catch((e) => log(`词典重载失败: ${(e as Error).message}`)));
  }
  return { client, injector, getDict: () => dict, reload };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 后台实例的控制端口：只监听本机，供第二次启动的快捷方式发命令。 */
function residentPort(cfg: AppConfig): number {
  return cfg.port + 1;
}

/** 向已在后台运行的 cursor-zh 发一条命令。没人在听时返回 undefined。 */
function askResident(port: number, command: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let buf = "";
    let settled = false;
    const done = (v: string | undefined) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(v);
    };
    socket.setTimeout(1500);
    socket.on("connect", () => socket.write(command + "\n"));
    socket.on("data", (d) => {
      buf += d.toString();
      if (buf.includes("\n")) done(buf.trim());
    });
    socket.on("timeout", () => done(undefined));
    socket.on("error", () => done(undefined));
  });
}

function listenResident(port: number, onCommand: (cmd: string) => Promise<string>): Promise<net.Server | undefined> {
  const server = net.createServer((socket) => {
    let buf = "";
    socket.on("data", (d) => {
      buf += d.toString();
      const line = buf.split(/\r?\n/, 1)[0]?.trim();
      if (!line) return;
      void onCommand(line).then(
        (msg) => socket.end(msg + "\n"),
        (e) => socket.end(`error ${(e as Error).message}\n`),
      );
    });
  });
  return new Promise((resolve) => {
    server.once("error", (e) => {
      log(`后台控制端口 ${port} 不可用（${(e as Error).message}），本次不会响应第二次快捷方式。`);
      resolve(undefined);
    });
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

interface LiveSession {
  client: CdpClient;
  injector: Injector;
  getDict: () => Dictionary;
  reload: () => Promise<void>;
}

/**
 * 常驻：Cursor 退出后本进程不退出。调试端口重新出现时自动接上。
 * n / 控制端口 restart：关掉 Cursor，再把它启动到前台。
 */
async function runResident(cfg: AppConfig, cursorPath: string, extra: string[], firstWs: string): Promise<void> {
  let current: LiveSession | null = null;
  let replacing = false;
  let restarting: Promise<void> | null = null;

  const attach = async (wsUrl: string) => {
    const conn = await connectAndInject(cfg, wsUrl);
    current = conn;
    conn.client.onClose(() => {
      if (replacing || current?.client !== conn.client) return;
      current = null;
      log("Cursor 已断开，cursor-zh 保持后台运行。它若带调试端口重新打开，会自动接上。");
      log("输入 n 在前台重新启动 Cursor，q 退出本工具。");
    });
    log("翻译已生效。新打开的窗口会自动注入。");
  };

  const bringToFront = async () => {
    let ok = false;
    for (let i = 0; i < 15; i++) {
      if (focusCursorWindow() === "ok") {
        ok = true;
        break;
      }
      await sleep(400);
    }
    // 先把 Cursor 放到前台，再收起本工具自己的控制台，避免 Cursor 跟着被最小化。
    if (isOwnWindow()) minimizeConsole();
    return ok;
  };

  const launchAndAttach = async () => {
    launchCursor({ cursorPath, port: cfg.port, extraArgs: extra });
    const ws = await waitForDebugPort(cfg.port, 30_000);
    await attach(ws);
    const focused = await bringToFront();
    log(focused ? "Cursor 已在前台打开，本工具继续在后台运行。" : "Cursor 已启动。没能把它切到前台，可手动点一下任务栏图标。");
  };

  const restart = async () => {
    if (restarting) return restarting;
    restarting = (async () => {
      replacing = true;
      try {
        current?.client.close();
        current = null;
        log("正在关闭 Cursor……");
        if (!(await closeCursor())) throw new Error("无法结束 Cursor.exe，请在任务管理器中手动结束后再试。");
        log("正在前台重新启动 Cursor……");
        await launchAndAttach();
      } finally {
        replacing = false;
        restarting = null;
      }
    })();
    return restarting;
  };

  const focusOrLaunch = async (): Promise<string> => {
    try {
      const ws = await fetchBrowserWsUrl(cfg.port, 800);
      if (!current) await attach(ws);
      const ok = await bringToFront();
      return ok ? "ok Cursor 已切到前台" : "ok 已连接，但未能把 Cursor 切到前台";
    } catch {
      if (isCursorRunning()) {
        await restart();
        return "ok Cursor 没有调试端口，已在前台重新启动";
      }
      await launchAndAttach();
      return "ok Cursor 已在前台启动";
    }
  };

  await listenResident(residentPort(cfg), async (cmd) => {
    if (cmd === "ping") return "ok";
    if (cmd === "focus") return focusOrLaunch();
    if (cmd === "restart") {
      await restart();
      return "ok Cursor 已在前台重新启动";
    }
    return "error 未知命令";
  });

  if (!process.stdin.isTTY) {
    /* 非交互环境只靠控制端口 */
  } else {
    const rl = readline.createInterface({ input: process.stdin });
    rl.on("line", async (line) => {
      const cmd = line.trim().toLowerCase();
      try {
        if (cmd === "r") {
          if (!current) log("当前没有连接，无法重载。");
          else await current.reload();
        } else if (cmd === "c") {
          if (!current) log("当前没有连接，无法导出。");
          else log(`已导出未翻译文案: ${await exportUntranslated(cfg, current.injector, current.getDict())}`);
        } else if (cmd === "s") log(`当前会话数: ${current?.injector.sessionCount ?? 0}`);
        else if (cmd === "n") await restart();
        else if (cmd === "q") {
          log("退出本工具，Cursor 继续运行。");
          await flushLog();
          process.exit(0);
        } else if (cmd) log("可用命令: r 重载词典 | c 导出未翻译 | s 会话数 | n 前台重启 Cursor | q 退出");
      } catch (e) {
        log(`执行失败: ${(e as Error).message}`);
      }
    });
  }

  await attach(firstWs);
  const focused = await bringToFront();
  log(focused ? "Cursor 已在前台。本工具在后台运行，关掉这个窗口才会停止翻译。" : "翻译已挂上。没能把 Cursor 切到前台。");
  log("Cursor 退出后本工具不退出。输入 n 可在前台重新启动它。");

  while (true) {
    await sleep(1500);
    if (current || replacing) continue;
    try {
      const ws = await fetchBrowserWsUrl(cfg.port, 800);
      if (current || replacing) continue;
      log("检测到 Cursor 已重新打开，正在附加。");
      await attach(ws);
    } catch {
      /* Cursor 还没回来 */
    }
  }
}

async function resolveCursorPath(cfg: AppConfig): Promise<string> {
  if (cfg.cursorPath) {
    if (!fs.existsSync(cfg.cursorPath)) await fail(`config.json 中的 cursorPath 不存在: ${cfg.cursorPath}。运行 setup 重新配置。`);
    return cfg.cursorPath;
  }
  const found = detectCursorPaths();
  if (found.length === 0) await fail("未找到 Cursor.exe。请运行 setup，或在 config.json 的 cursorPath 中填写完整路径。");
  if (found.length > 1) log(`探测到多个 Cursor，使用第一个: ${found.join(" | ")}`);
  return found[0];
}

async function cmdStart(cli: Cli, cfg: AppConfig): Promise<void> {
  const handed = await askResident(residentPort(cfg), cli.flags.has("restart") ? "restart" : "focus");
  if (handed) {
    log(handed.replace(/^ok\s?/, "") || "已交给后台中的 cursor-zh。");
    if (!handed.startsWith("ok")) await fail(handed);
    return;
  }

  const cursorPath = await resolveCursorPath(cfg);

  // 已有实例时，新进程只会把参数转交给旧实例然后退出，调试端口不会打开
  if (isCursorRunning() && !cli.flags.has("force")) {
    let ws: string | undefined;
    try {
      ws = await fetchBrowserWsUrl(cfg.port);
    } catch {
      ws = undefined;
    }
    if (ws && !cli.flags.has("restart")) {
      log("检测到 Cursor 已在运行且调试端口可用，改为直接附加。");
      return runResident(cfg, cursorPath, [...cfg.extraCursorArgs, ...cli.passthrough], ws);
    }
    if (!ws) log("Cursor 已在运行，但不是由本工具启动的（没有调试端口），无法注入翻译。");
    // 非交互环境（无 TTY）不自动关闭用户的编辑器，必须显式加 --restart
    const restart =
      cli.flags.has("restart") ||
      (process.stdin.isTTY ? await confirm("是否关闭当前 Cursor 并以中文界面重新启动？（未保存的编辑会由 Cursor 自动恢复）", true) : false);
    if (!restart) {
      await fail("已取消。请手动完全退出 Cursor（任务管理器中不再有 Cursor.exe）后再运行本程序，或加 --restart 参数自动重启。");
    }
    log("正在关闭 Cursor……");
    if (!(await closeCursor())) await fail("无法结束 Cursor.exe 进程，请在任务管理器中手动结束后重试。");
    log("Cursor 已退出。");
  }

  const extra = [...cfg.extraCursorArgs, ...cli.passthrough];
  log(`启动 Cursor: ${cursorPath} --remote-debugging-port=${cfg.port}${extra.length ? " " + extra.join(" ") : ""}`);
  launchCursor({ cursorPath, port: cfg.port, extraArgs: extra });
  const wsUrl = await waitForDebugPort(cfg.port, 30_000);
  await runResident(cfg, cursorPath, extra, wsUrl);
}

async function cmdAttach(cfg: AppConfig): Promise<void> {
  const handed = await askResident(residentPort(cfg), "focus");
  if (handed) {
    log(handed.replace(/^ok\s?/, "") || "已交给后台中的 cursor-zh。");
    if (!handed.startsWith("ok")) await fail(handed);
    return;
  }
  let wsUrl = "";
  try {
    wsUrl = await fetchBrowserWsUrl(cfg.port);
  } catch (e) {
    await fail(`无法连接 127.0.0.1:${cfg.port}：${(e as Error).message}。Cursor 是否以 --remote-debugging-port=${cfg.port} 启动？`);
  }
  await runResident(cfg, await resolveCursorPath(cfg), cfg.extraCursorArgs, wsUrl);
}

async function cmdRestart(cfg: AppConfig): Promise<void> {
  const handed = await askResident(residentPort(cfg), "restart");
  if (handed) {
    log(handed.replace(/^ok\s?/, "") || "已交给后台中的 cursor-zh。");
    if (!handed.startsWith("ok")) await fail(handed);
    return;
  }
  return cmdStart({ command: "start", flags: new Set(["restart"]), passthrough: [] }, cfg);
}

async function cmdCollect(cfg: AppConfig): Promise<void> {
  let wsUrl = "";
  try {
    wsUrl = await fetchBrowserWsUrl(cfg.port);
  } catch (e) {
    await fail(`无法连接 127.0.0.1:${cfg.port}：${(e as Error).message}`);
  }
  const { client, injector, getDict } = await connectAndInject(cfg, wsUrl);
  await new Promise((r) => setTimeout(r, 1500)); // 等待各 target 附加并完成首轮扫描
  log(`已导出: ${await exportUntranslated(cfg, injector, getDict())}`);
  client.close();
  process.exit(0);
}

function cmdDetect(cfg: AppConfig): void {
  const found = detectCursorPaths();
  console.log(`程序目录: ${APP_ROOT}${IS_SEA ? "（单文件 exe）" : "（开发模式）"}`);
  console.log(`config.json: ${hasConfig() ? "存在" : "不存在"}，cursorPath: ${cfg.cursorPath || "(空，自动探测)"}`);
  console.log(found.length ? `探测结果:\n  ${found.join("\n  ")}` : "未探测到 Cursor.exe");
  console.log(`Cursor 运行中: ${isCursorRunning() ? "是" : "否"}`);
  console.log(`显示语言(argv.json locale): ${currentLocale() ?? "(未设置)"}`);
}

async function cmdSetup(cli: Cli): Promise<void> {
  await runSetup({
    yes: cli.flags.has("yes"),
    langpack: !cli.flags.has("no-langpack"),
    locale: !cli.flags.has("no-locale"),
    shortcut: !cli.flags.has("no-shortcut"),
    log,
  });
}

async function cmdUpdateDict(cfg: AppConfig): Promise<void> {
  log(`正在下载: ${cfg.dictUrl}`);
  const r = await updateDictionary(cfg.dictUrl, cfg.dictionary);
  if (!r.changed) log(`本地词典已是最新（${r.stats.exact} 精确 / ${r.stats.patterns} 正则）`);
  else log(`词典已更新为 ${r.stats.exact} 精确 / ${r.stats.patterns} 正则${r.backup ? `，旧版本备份在 ${r.backup}` : ""}`);
  for (const w of r.warnings.slice(0, 5)) log(`提示: ${w}`);
  log("若 cursor-zh 正在运行，词典会自动热更新。");
}

async function cmdUninstall(cli: Cli): Promise<void> {
  const lnk = path.join(desktopDir(), SHORTCUT_NAME);
  if (fs.existsSync(lnk)) {
    fs.unlinkSync(lnk);
    log(`已删除快捷方式: ${lnk}`);
  } else log("桌面没有 cursor-zh 创建的快捷方式");
  if (cli.flags.has("restore-locale")) {
    const r = restoreLocale();
    log(r === "restored" ? "已用备份还原 argv.json" : r === "removed" ? "已移除 argv.json 中的 locale" : "argv.json 无需改动");
  } else {
    log("显示语言未改动；如需还原 VS Code 底座为英文，加 --restore-locale 或在 Cursor 中运行 Configure Display Language。");
  }
  log(`cursor-zh 从未修改 Cursor 安装文件。删除本程序所在目录 ${APP_ROOT} 即可彻底卸载。`);
}

async function main(): Promise<void> {
  if (!isWindows()) {
    console.error("cursor-zh 目前仅支持 Windows。");
    process.exit(1);
  }
  const cli = parseArgv(process.argv.slice(2));
  if (cli.flags.has("version") || cli.flags.has("v")) return void console.log(VERSION);
  if (cli.flags.has("help") || cli.flags.has("h")) return printHelp();

  switch (cli.command) {
    case "":
      // 双击 exe：无配置 → 向导；有配置 → start
      if (!hasConfig()) {
        await cmdSetup(cli);
        log("即将以中文界面启动 Cursor……");
      }
      return cmdStart(cli, loadConfig());
    case "start":
      return cmdStart(cli, loadConfig());
    case "setup":
      await cmdSetup(cli);
      await pauseIfDoubleClicked();
      return;
    case "attach":
      return cmdAttach(loadConfig());
    case "restart":
      return cmdRestart(loadConfig());
    case "collect":
      return cmdCollect(loadConfig());
    case "update-dict":
      await cmdUpdateDict(loadConfig());
      await pauseIfDoubleClicked();
      return;
    case "detect":
      cmdDetect(loadConfig());
      await pauseIfDoubleClicked();
      return;
    case "uninstall":
      await cmdUninstall(cli);
      await pauseIfDoubleClicked();
      return;
    case "version":
    case "--version":
    case "-v":
      console.log(VERSION);
      return;
    default:
      printHelp();
      await pauseIfDoubleClicked();
  }
}

process.on("unhandledRejection", (e) => void fail(`未处理的异常: ${(e as Error)?.stack ?? e}`));
main().catch((e) => fail((e as Error).stack ?? String(e)));
