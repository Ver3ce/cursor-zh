/**
 * 官方 VS Code 简体中文语言包：检测 / 安装 / 设置显示语言。
 *
 * - 安装走 Cursor 自带 CLI：cursor.cmd --install-extension MS-CEINTL.vscode-language-pack-zh-hans
 * - 显示语言写在用户配置 %USERPROFILE%\.cursor\argv.json 的 "locale" 字段（JSONC）。
 *   这是用户配置文件，不是 Cursor 安装文件；修改前备份为 argv.json.cursor-zh.bak。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { cursorUserDataDir } from "./paths.js";

export const LANG_PACK_ID = "MS-CEINTL.vscode-language-pack-zh-hans";

export function argvJsonPath(): string {
  return path.join(cursorUserDataDir(), "argv.json");
}

export function argvBackupPath(): string {
  return argvJsonPath() + ".cursor-zh.bak";
}

/** 通过扩展目录判断语言包是否已安装 */
export function isLangPackInstalled(): boolean {
  const extDir = path.join(cursorUserDataDir(), "extensions");
  try {
    return fs.readdirSync(extDir).some((n) => n.toLowerCase().startsWith(LANG_PACK_ID.toLowerCase()));
  } catch {
    return false;
  }
}

/** 调用 Cursor CLI 安装语言包；返回 CLI 输出 */
export function installLangPack(cursorCli: string): string {
  return execFileSync("cmd.exe", ["/d", "/c", cursorCli, "--install-extension", LANG_PACK_ID, "--force"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    timeout: 3 * 60_000,
  });
}

/** 去掉 JSONC 注释后判断对象是否为空（无任何键） */
function jsoncHasKeys(text: string): boolean {
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1");
  const m = /\{([\s\S]*)\}/.exec(stripped);
  return !!m && /"/.test(m[1]);
}

export function currentLocale(): string | undefined {
  const file = argvJsonPath();
  if (!fs.existsSync(file)) return undefined;
  const m = /^\s*"locale"\s*:\s*"([^"]*)"/m.exec(fs.readFileSync(file, "utf8"));
  return m?.[1];
}

/**
 * 设置 argv.json 的 locale。返回 "unchanged" | "updated" | "created"。
 */
export function setLocale(locale: string): "unchanged" | "updated" | "created" {
  const file = argvJsonPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });

  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `{\n\t"locale": "${locale}"\n}\n`, "utf8");
    return "created";
  }

  const text = fs.readFileSync(file, "utf8");
  if (currentLocale() === locale) return "unchanged";

  if (!fs.existsSync(argvBackupPath())) fs.copyFileSync(file, argvBackupPath());

  let out: string;
  if (/^\s*"locale"\s*:\s*"[^"]*"/m.test(text)) {
    out = text.replace(/^(\s*"locale"\s*:\s*)"[^"]*"/m, `$1"${locale}"`);
  } else if (!jsoncHasKeys(text)) {
    // 只有注释或为空对象：重写为最小合法内容（保留原注释放在前面）
    const comments = text.replace(/[{}]/g, "").trim();
    out = `{\n${comments ? comments.split(/\r?\n/).map((l) => (l.trim() ? "\t" + l.trim() : "")).join("\n") + "\n" : ""}\t"locale": "${locale}"\n}\n`;
  } else {
    // 在左花括号后插入，避免受末尾注释行影响
    out = text.replace(/\{/, `{\n\t"locale": "${locale}",`);
  }
  fs.writeFileSync(file, out, "utf8");
  return "updated";
}

/** 还原：优先用备份，其次删除 locale 行 */
export function restoreLocale(): "restored" | "removed" | "none" {
  const file = argvJsonPath();
  if (fs.existsSync(argvBackupPath())) {
    fs.copyFileSync(argvBackupPath(), file);
    fs.unlinkSync(argvBackupPath());
    return "restored";
  }
  if (!fs.existsSync(file)) return "none";
  const text = fs.readFileSync(file, "utf8");
  if (!/^\s*"locale"\s*:/m.test(text)) return "none";
  const out = text
    .replace(/^\s*"locale"\s*:\s*"[^"]*"\s*,?\s*\r?\n/m, "")
    // 删除后若留下悬挂逗号（前一行以逗号结尾且紧跟 }），一并清理
    .replace(/,(\s*)\}/, "$1}");
  fs.writeFileSync(file, out, "utf8");
  return "removed";
}
