import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { runningCursorPaths } from "./platform/win.js";

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

export interface LaunchOptions {
  cursorPath: string;
  port: number;
  extraArgs: string[];
}

/**
 * 以调试端口启动 Cursor。
 * detached + unref：本工具退出后 Cursor 继续运行。
 */
export function launchCursor(opts: LaunchOptions): number | undefined {
  // Chromium 在非 headless 模式下调试端口固定绑定 127.0.0.1，外部网络无法访问
  const args = [`--remote-debugging-port=${opts.port}`, ...opts.extraArgs];
  const child = spawn(opts.cursorPath, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
    cwd: path.dirname(opts.cursorPath),
  });
  child.unref();
  return child.pid;
}
