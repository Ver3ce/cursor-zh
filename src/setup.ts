/**
 * 首次运行向导：把"下载 → 双击"之后的所有准备工作做完。
 *   1. 定位 Cursor.exe（自动探测 → 文件选择框 → 手动输入）
 *   2. 写 config.json，释放 dict/zh-CN.json 到程序旁
 *   3. 可选：安装官方中文语言包 + 设置显示语言 zh-cn（VS Code 底座汉化）
 *   4. 可选：创建桌面快捷方式 "Cursor (中文)"
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { saveConfig, loadConfig } from "./config.js";
import { installLangPack, isLangPackInstalled, currentLocale, setLocale, LANG_PACK_ID } from "./langpack.js";
import { cursorCliPath, detectCursorPaths, isCursorRunning } from "./launcher.js";
import { APP_ROOT, IS_SEA, ensureExternalFile } from "./paths.js";
import { createShortcut, desktopDir, pickCursorExe } from "./platform/win.js";

export interface SetupOptions {
  /** 全部采用默认答案，不提问 */
  yes: boolean;
  langpack: boolean;
  locale: boolean;
  shortcut: boolean;
  log: (msg: string) => void;
}

export const SHORTCUT_NAME = "Cursor (中文).lnk";

class Prompter {
  private rl?: readline.Interface;
  constructor(private auto: boolean) {}
  private get iface(): readline.Interface {
    if (!this.rl) this.rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return this.rl;
  }
  async confirm(question: string, def = true): Promise<boolean> {
    if (this.auto || !process.stdin.isTTY) return def;
    const hint = def ? "[Y/n]" : "[y/N]";
    const a = (await this.iface.question(`${question} ${hint} `)).trim().toLowerCase();
    if (!a) return def;
    return a === "y" || a === "yes" || a === "是";
  }
  async text(question: string): Promise<string> {
    if (this.auto || !process.stdin.isTTY) return "";
    return (await this.iface.question(`${question} `)).trim().replace(/^"|"$/g, "");
  }
  close(): void {
    this.rl?.close();
  }
}

async function locateCursor(p: Prompter, log: (m: string) => void): Promise<string> {
  const cfg = loadConfig();
  if (cfg.cursorPath && fs.existsSync(cfg.cursorPath)) {
    log(`使用 config.json 中的 Cursor 路径: ${cfg.cursorPath}`);
    return cfg.cursorPath;
  }
  const found = detectCursorPaths();
  if (found.length === 1) {
    log(`已自动探测到 Cursor: ${found[0]}`);
    return found[0];
  }
  if (found.length > 1) {
    log(`探测到多个 Cursor 安装:`);
    found.forEach((f, i) => log(`  [${i + 1}] ${f}`));
    const a = await p.text(`请输入编号选择（默认 1）:`);
    const idx = Number(a) >= 1 && Number(a) <= found.length ? Number(a) - 1 : 0;
    return found[idx];
  }
  log("未能自动找到 Cursor.exe，请在弹出的窗口中选择它……");
  const picked = pickCursorExe();
  if (picked && fs.existsSync(picked)) return picked;
  for (let i = 0; i < 3; i++) {
    const typed = await p.text("请粘贴 Cursor.exe 的完整路径:");
    if (typed && fs.existsSync(typed) && /cursor\.exe$/i.test(typed)) return typed;
    if (!typed) break;
    log("路径无效，请重试。");
  }
  throw new Error("未能确定 Cursor.exe 位置。请把路径填入 config.json 的 cursorPath 后重新运行。");
}

export async function runSetup(opts: SetupOptions): Promise<{ cursorPath: string }> {
  const { log } = opts;
  const p = new Prompter(opts.yes);
  try {
    log("======== cursor-zh 首次运行向导 ========");
    log(`程序目录: ${APP_ROOT}`);

    // 1. Cursor 位置
    const cursorPath = await locateCursor(p, log);

    // 2. 配置与词典
    saveConfig({ cursorPath });
    log("已写入 config.json");
    if (ensureExternalFile("dict/zh-CN.json", "zh-CN.json")) log("已释放词典 dict/zh-CN.json（可自行编辑，保存即热更新）");
    else log("词典 dict/zh-CN.json 已存在，保留你的版本");

    // 3. 官方语言包（VS Code 底座）
    if (opts.langpack) {
      if (isLangPackInstalled()) {
        log(`官方中文语言包已安装（${LANG_PACK_ID}）`);
      } else if (await p.confirm("安装 VS Code 官方简体中文语言包？（汉化菜单、设置等 VS Code 底座界面）")) {
        const cli = cursorCliPath(cursorPath);
        if (!cli) {
          log("未找到 Cursor 命令行入口（resources\\app\\bin\\cursor.cmd），请在 Cursor 扩展市场手动搜索 Chinese 安装。");
        } else {
          log("正在安装语言包，可能需要几十秒……");
          try {
            const out = installLangPack(cli);
            log(out.split(/\r?\n/).filter(Boolean).slice(-2).join(" | ") || "安装完成");
          } catch (e) {
            log(`语言包安装失败: ${(e as Error).message}。可稍后在扩展市场手动安装。`);
          }
        }
      }
    }

    // 3b. 显示语言
    if (opts.locale) {
      const cur = currentLocale();
      if (cur === "zh-cn") {
        log("显示语言已是 zh-cn");
      } else if (
        await p.confirm(
          `把 Cursor 显示语言设为中文？（写入用户配置 ${path.join("~", ".cursor", "argv.json")} 的 locale 字段，会先备份）`,
        )
      ) {
        const r = setLocale("zh-cn");
        log(r === "unchanged" ? "显示语言无需修改" : r === "created" ? "已创建 argv.json 并设置 locale=zh-cn" : "已更新 argv.json 的 locale=zh-cn（原文件已备份为 argv.json.cursor-zh.bak）");
      }
    }

    // 4. 快捷方式
    if (opts.shortcut && (await p.confirm(`在桌面创建快捷方式「${SHORTCUT_NAME.replace(/\.lnk$/, "")}」？`))) {
      const lnk = path.join(desktopDir(), SHORTCUT_NAME);
      const target = IS_SEA ? process.execPath : path.join(APP_ROOT, "cursor-zh.cmd");
      createShortcut({
        lnkPath: lnk,
        target,
        args: IS_SEA ? "start" : "",
        workingDir: APP_ROOT,
        iconPath: cursorPath,
        description: "以中文界面启动 Cursor（cursor-zh 运行时翻译）",
        windowStyle: 1,
      });
      log(`已创建: ${lnk}`);
    }

    log("======== 向导完成 ========");
    if (isCursorRunning()) {
      log("注意：Cursor 正在运行。请先完全退出 Cursor（任务管理器中无 Cursor.exe），再双击快捷方式或本程序启动。");
    }
    return { cursorPath };
  } finally {
    p.close();
  }
}
