import fs from "node:fs";
import path from "node:path";
import { APP_ROOT, readAsset, resolveFromRoot } from "./paths.js";

export { APP_ROOT as PROJECT_ROOT, resolveFromRoot };

export interface AppConfig {
  /** Cursor.exe 的完整路径；空字符串表示自动探测 */
  cursorPath: string;
  /** CDP 调试端口（仅 127.0.0.1） */
  port: number;
  /** 词典文件路径（相对 APP_ROOT） */
  dictionary: string;
  /** 是否监听词典文件变化并热更新 */
  watchDictionary: boolean;
  /** 透传给 Cursor 的额外启动参数 */
  extraCursorArgs: string[];
  /** update-dict 使用的远程词典地址 */
  dictUrl: string;
}

const DEFAULTS: AppConfig = {
  cursorPath: "",
  port: 9333,
  dictionary: "dict/zh-CN.json",
  watchDictionary: true,
  extraCursorArgs: [],
  dictUrl: "https://raw.githubusercontent.com/Ver3ce/cursor-zh/main/dict/zh-CN.json",
};

export const CONFIG_FILE = path.join(APP_ROOT, "config.json");

export function hasConfig(): boolean {
  return fs.existsSync(CONFIG_FILE);
}

function parseConfig(text: string, source: string): AppConfig {
  const raw = JSON.parse(text) as Partial<AppConfig>;
  const merged: AppConfig = { ...DEFAULTS, ...raw };
  if (!Number.isInteger(merged.port) || merged.port <= 0 || merged.port > 65535) {
    throw new Error(`${source} 中 port 无效: ${String(raw.port)}`);
  }
  if (!Array.isArray(merged.extraCursorArgs)) merged.extraCursorArgs = [];
  if (typeof merged.cursorPath !== "string") merged.cursorPath = "";
  return merged;
}

export function loadConfig(): AppConfig {
  if (!hasConfig()) {
    // 没有用户配置时使用内置默认（不报错，便于首次运行向导之前的命令如 detect/help）
    try {
      return parseConfig(readAsset("config.default.json"), "config.default.json");
    } catch {
      return { ...DEFAULTS };
    }
  }
  try {
    return parseConfig(fs.readFileSync(CONFIG_FILE, "utf8"), "config.json");
  } catch (err) {
    throw new Error(`读取 config.json 失败: ${(err as Error).message}`);
  }
}

/** 写入 config.json（保留注释键 _comment） */
export function saveConfig(cfg: Partial<AppConfig>): void {
  let base: Record<string, unknown> = {};
  try {
    base = JSON.parse(readAsset("config.default.json")) as Record<string, unknown>;
  } catch {
    /* ignore */
  }
  if (hasConfig()) {
    try {
      base = { ...base, ...(JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as Record<string, unknown>) };
    } catch {
      /* 损坏的配置被覆盖 */
    }
  }
  const out = { ...base, ...cfg };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(out, null, 2) + "\n", "utf8");
}
