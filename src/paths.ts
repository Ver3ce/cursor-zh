/**
 * 运行时资源定位。两种模式：
 *  - SEA（单文件 exe）：APP_ROOT = exe 所在目录；内置资产通过 node:sea 读取；
 *    用户可编辑的文件（config.json、dict/zh-CN.json）放在 exe 旁，缺失时从内置资产释放。
 *  - 开发模式（node dist/index.js）：APP_ROOT = 项目根目录，直接读项目文件。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

interface SeaModule {
  isSea(): boolean;
  getAsset(key: string, encoding: "utf8"): string;
}

function loadSea(): SeaModule | undefined {
  try {
    const req = createRequire(import.meta.url);
    const m = req("node:sea") as SeaModule;
    return typeof m?.isSea === "function" ? m : undefined;
  } catch {
    return undefined;
  }
}

const sea = loadSea();
export const IS_SEA: boolean = !!sea && sea.isSea();

export const APP_ROOT: string = IS_SEA
  ? path.dirname(process.execPath)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 内置资产名 → 开发模式下的项目相对路径 */
const ASSET_FILES: Record<string, string> = {
  "translator.js": "inject/translator.js",
  "zh-CN.json": "dict/zh-CN.json",
  "config.default.json": "config.default.json",
};

export function resolveFromRoot(p: string): string {
  return path.isAbsolute(p) ? p : path.join(APP_ROOT, p);
}

/** 读取内置资产（SEA）或对应的项目文件（开发模式） */
export function readAsset(name: string): string {
  if (IS_SEA && sea) return sea.getAsset(name, "utf8");
  const rel = ASSET_FILES[name];
  if (!rel) throw new Error(`未知资产: ${name}`);
  return fs.readFileSync(path.join(APP_ROOT, rel), "utf8");
}

/**
 * 若外部文件不存在，则从内置资产释放一份到 APP_ROOT/rel。
 * 返回 true 表示本次进行了释放。
 */
export function ensureExternalFile(rel: string, assetName: string): boolean {
  const target = resolveFromRoot(rel);
  if (fs.existsSync(target)) return false;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, readAsset(assetName), "utf8");
  return true;
}

/** 用户主目录下的 Cursor 数据目录（argv.json、extensions 所在） */
export function cursorUserDataDir(): string {
  return path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".cursor");
}

export function logDir(): string {
  return path.join(APP_ROOT, "logs");
}
