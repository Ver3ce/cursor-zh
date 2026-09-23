/**
 * Windows 平台能力：PowerShell 调用、快捷方式、文件选择对话框、特殊目录。
 * 所有 PowerShell 脚本通过 -EncodedCommand（UTF-16LE Base64）传入，规避引号与代码页问题。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function isWindows(): boolean {
  return process.platform === "win32";
}

/** 运行一段 PowerShell 脚本，返回 UTF-8 stdout（已 trim） */
export function runPowerShell(script: string, opts: { timeoutMs?: number; sta?: boolean } = {}): string {
  const full = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $ErrorActionPreference='Stop'; ${script}`;
  const encoded = Buffer.from(full, "utf16le").toString("base64");
  const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"];
  if (opts.sta) args.push("-STA");
  args.push("-EncodedCommand", encoded);
  return execFileSync("powershell", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    timeout: opts.timeoutMs ?? 30_000,
  }).trim();
}

function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** 桌面目录（尊重 OneDrive 重定向） */
export function desktopDir(): string {
  try {
    return runPowerShell("[Environment]::GetFolderPath('Desktop')");
  } catch {
    return path.join(process.env.USERPROFILE ?? "", "Desktop");
  }
}

export interface ShortcutSpec {
  lnkPath: string;
  target: string;
  args?: string;
  workingDir?: string;
  iconPath?: string;
  description?: string;
  /** 1 正常, 3 最大化, 7 最小化 */
  windowStyle?: 1 | 3 | 7;
}

export function createShortcut(spec: ShortcutSpec): void {
  fs.mkdirSync(path.dirname(spec.lnkPath), { recursive: true });
  const lines = [
    `$ws = New-Object -ComObject WScript.Shell`,
    `$sc = $ws.CreateShortcut(${psQuote(spec.lnkPath)})`,
    `$sc.TargetPath = ${psQuote(spec.target)}`,
    `$sc.Arguments = ${psQuote(spec.args ?? "")}`,
    `$sc.WorkingDirectory = ${psQuote(spec.workingDir ?? path.dirname(spec.target))}`,
    `$sc.Description = ${psQuote(spec.description ?? "")}`,
    `$sc.WindowStyle = ${spec.windowStyle ?? 1}`,
  ];
  if (spec.iconPath) lines.push(`$sc.IconLocation = ${psQuote(spec.iconPath + ",0")}`);
  lines.push(`$sc.Save()`);
  runPowerShell(lines.join("; "));
}

/** 弹出文件选择框让用户定位 Cursor.exe；取消返回空串 */
export function pickCursorExe(): string {
  try {
    return runPowerShell(
      [
        "Add-Type -AssemblyName System.Windows.Forms",
        "$d = New-Object System.Windows.Forms.OpenFileDialog",
        "$d.Title = '请选择 Cursor.exe'",
        "$d.Filter = 'Cursor.exe|Cursor.exe|可执行文件 (*.exe)|*.exe'",
        "$d.CheckFileExists = $true",
        "if ($d.ShowDialog() -eq 'OK') { $d.FileName }",
      ].join("; "),
      { sta: true, timeoutMs: 10 * 60_000 },
    );
  } catch {
    return "";
  }
}

/** 以普通窗口启动程序，不继承调用方的最小化状态。 */
export function startProcessNormal(exe: string, args: string[], cwd: string): void {
  const list = args.map((a) => psQuote(a)).join(", ");
  runPowerShell(
    `Start-Process -FilePath ${psQuote(exe)} -WorkingDirectory ${psQuote(cwd)} -WindowStyle Normal${list ? ` -ArgumentList ${list}` : ""}`,
    { timeoutMs: 15_000 },
  );
}

/** 从正在运行的 Cursor 进程获取路径 */
export function runningCursorPaths(): string[] {
  try {
    const out = runPowerShell(
      "Get-Process -Name Cursor -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path -Unique",
    );
    return out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && fs.existsSync(s));
  } catch {
    return [];
  }
}
