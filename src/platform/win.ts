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

const WIN32_HELPER = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class CzWin {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr p);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
'@ -ErrorAction SilentlyContinue
`;

/** 把 Cursor 主窗口还原并切到前台。窗口还没创建时返回 missing。 */
export function focusCursorWindow(): "ok" | "missing" | "failed" {
  try {
    const out = runPowerShell(
      WIN32_HELPER +
        `
$procs = @(Get-Process -Name Cursor -ErrorAction SilentlyContinue)
foreach ($proc in $procs) { $proc.Refresh() }
$wins = @($procs | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero })
if ($wins.Count -eq 0) { 'missing'; return }
foreach ($w in $wins) {
  $wh = $w.MainWindowHandle
  if ([CzWin]::IsIconic($wh)) { [CzWin]::ShowWindow($wh, 9) | Out-Null } else { [CzWin]::ShowWindow($wh, 5) | Out-Null }
}
$p = $wins | Sort-Object { $_.MainWindowTitle.Length } -Descending | Select-Object -First 1
$h = $p.MainWindowHandle
# 后台进程直接 SetForegroundWindow 会被系统拒绝。先发一次 Alt，再激活。
[CzWin]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
[CzWin]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
$shell = New-Object -ComObject WScript.Shell
$activated = $shell.AppActivate($p.Id)
[CzWin]::BringWindowToTop($h) | Out-Null
$set = [CzWin]::SetForegroundWindow($h)
if ($activated -or $set) { 'ok' } else { 'failed' }
`,
      { timeoutMs: 8000 },
    );
    if (out === "ok" || out === "missing" || out === "failed") return out;
    return "failed";
  } catch {
    return "failed";
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

/** 最小化本工具所在的控制台。从别人的终端里启动时没有控制台，返回 false。 */
export function minimizeConsole(): boolean {
  try {
    const out = runPowerShell(
      WIN32_HELPER +
        `
$h = [CzWin]::GetConsoleWindow()
if ($h -eq [IntPtr]::Zero) { 'none'; return }
[CzWin]::ShowWindow($h, 6) | Out-Null
'ok'
`,
      { timeoutMs: 8000 },
    );
    return out === "ok";
  } catch {
    return false;
  }
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
