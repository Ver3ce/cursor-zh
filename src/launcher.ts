import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { runningCursorPaths, startProcessNormal } from "./platform/win.js";

function exists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** 从注册表 Uninstall 项中查找 Cursor 的安装路径 */
function detectFromRegistry(): string[] {
  const roots = [
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  ];
  const found: string[] = [];
  for (const root of roots) {
    let out = "";
    try {
      out = execFileSync("reg", ["query", root, "/s", "/v", "DisplayIcon"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch {
      continue;
    }
    for (const line of out.split(/\r?\n/)) {
      const m = /DisplayIcon\s+REG_SZ\s+(.+)$/i.exec(line.trim());
      if (!m) continue;
      let p = m[1].trim().replace(/^"|"$/g, "");
      // 形如 C:\...\Cursor.exe,0
      p = p.replace(/,\d+$/, "");
      if (/cursor\.exe$/i.test(p) && exists(p)) found.push(p);
    }
  }
  return found;
}

/** 从 PATH 中的 cursor 命令（bin\cursor.cmd）上溯到 Cursor.exe */
function detectFromPath(): string[] {
  let out = "";
  try {
    out = execFileSync("where.exe", ["cursor"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const line of out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
    // 典型: <install>\resources\app\bin\cursor.cmd  或 <install>\bin\cursor.cmd
    const candidates = [
      path.resolve(path.dirname(line), "..", "..", "..", "Cursor.exe"),
      path.resolve(path.dirname(line), "..", "Cursor.exe"),
    ];
    for (const c of candidates) if (exists(c)) found.push(c);
  }
  return found;
}

function detectCommonDirs(): string[] {
  const local = process.env.LOCALAPPDATA ?? "";
  const pf = process.env.ProgramFiles ?? "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const candidates = [
    path.join(local, "Programs", "cursor", "Cursor.exe"),
    path.join(local, "Programs", "Cursor", "Cursor.exe"),
    path.join(pf, "Cursor", "Cursor.exe"),
    path.join(pf86, "Cursor", "Cursor.exe"),
  ];
  return candidates.filter(exists);
}

export function detectCursorPaths(): string[] {
  const all = [...detectFromRegistry(), ...detectFromPath(), ...detectCommonDirs(), ...runningCursorPaths()];
  return [...new Set(all.map((p) => path.normalize(p)))];
}

/** Cursor 自带的命令行入口（用于 --install-extension 等） */
export function cursorCliPath(cursorExe: string): string | undefined {
  const dir = path.dirname(cursorExe);
  const candidates = [
    path.join(dir, "resources", "app", "bin", "cursor.cmd"),
    path.join(dir, "bin", "cursor.cmd"),
  ];
  return candidates.find(exists);
}

export function isCursorRunning(): boolean {
  try {
    const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq Cursor.exe", "/FO", "CSV", "/NH"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    return /cursor\.exe/i.test(out);
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 关闭正在运行的 Cursor。先发 WM_CLOSE 让其正常退出（会触发热退出保存状态），
 * 超时仍未退出再强制结束进程树。返回是否已全部退出。
 */
export async function closeCursor(opts: { gracefulMs?: number; force?: boolean } = {}): Promise<boolean> {
  const gracefulMs = opts.gracefulMs ?? 15_000;
  const run = (args: string[]) => {
    try {
      execFileSync("taskkill", args, { stdio: "ignore", windowsHide: true });
    } catch {
      /* 进程可能已经不存在 */
    }
  };
  run(["/IM", "Cursor.exe"]);
  const deadline = Date.now() + gracefulMs;
  while (Date.now() < deadline) {
    if (!isCursorRunning()) return true;
    await sleep(500);
  }
  if (opts.force === false) return false;
  run(["/F", "/T", "/IM", "Cursor.exe"]);
  for (let i = 0; i < 10 && isCursorRunning(); i++) await sleep(300);
  return !isCursorRunning();
}

export interface LaunchOptions {
  cursorPath: string;
  port: number;
  extraArgs: string[];
}

/**
 * 以调试端口启动 Cursor。
 * detached + unref：本工具退出后 Cursor 继续运行。
 */
export function launchCursor(opts: LaunchOptions): void {
  // 快捷方式把本工具最小化启动时，直接 spawn 会让 Cursor 继承最小化状态。
  // Start-Process -WindowStyle Normal 强制普通前台窗口。调试端口仍只绑 127.0.0.1。
  startProcessNormal(
    opts.cursorPath,
    [`--remote-debugging-port=${opts.port}`, ...opts.extraArgs],
    path.dirname(opts.cursorPath),
  );
}
