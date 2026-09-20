import fs from "node:fs";
import path from "node:path";
import { IS_SEA, APP_ROOT, readAsset, resolveFromRoot } from "./paths.js";

export interface PatternRule {
  /** 正则源码（不含分隔符），整段文本匹配 */
  match: string;
  /** 替换串，支持 $1 等捕获组引用 */
  replace: string;
  flags?: string;
}

export interface Dictionary {
  /** 精确匹配：英文原文 → 中文 */
  exact: Record<string, string>;
  /** 正则模板（用于含数字/变量的文案） */
  patterns: PatternRule[];
  /** 这些选择器（含其后代）内的文本不翻译 */
  skipSelectors: string[];
  /** 需翻译的属性名 */
  attributes: string[];
  /** 可剥离的后缀（翻译前缀后拼回），如 ". Open activity" */
  suffixes: PatternRule[];
  /** 分段分隔符（各段独立翻译后拼接） */
  segmentSeparators: string[];
  /** 分段拼接符 */
  segmentJoiner: string;
}

const DEFAULT_SKIP = [
  "head",
  "script",
  "style",
  "textarea",
  "input",
  "pre",
  "code",
  "[contenteditable='true']",
  "[contenteditable='plaintext-only']",
  ".monaco-editor",
  ".xterm",
];

const DEFAULT_ATTRS = ["title", "aria-label", "placeholder", "alt"];

export function parseDictionary(text: string): Dictionary {
  const raw = JSON.parse(text) as Partial<Dictionary> & Record<string, unknown>;
  const exact: Record<string, string> = {};
  if (raw.exact && typeof raw.exact === "object") {
    for (const [k, v] of Object.entries(raw.exact)) {
      if (k.startsWith("_")) continue; // 允许 _comment 之类的注释键
      if (typeof v === "string" && k.trim()) exact[k] = v;
    }
  }
  const readRules = (list: unknown, label: string): PatternRule[] => {
    const out: PatternRule[] = [];
    if (!Array.isArray(list)) return out;
    for (const p of list as Array<Partial<PatternRule>>) {
      if (!p || typeof p.match !== "string" || typeof p.replace !== "string") continue;
      try {
        new RegExp(p.match, p.flags ?? "");
        out.push({ match: p.match, replace: p.replace, flags: p.flags });
      } catch (e) {
        console.warn(`[词典] 忽略 ${label} 中的无效正则 ${JSON.stringify(p.match)}: ${(e as Error).message}`);
      }
    }
    return out;
  };
  return {
    exact,
    patterns: readRules(raw.patterns, "patterns"),
    suffixes: readRules(raw.suffixes, "suffixes"),
    skipSelectors: Array.isArray(raw.skipSelectors) ? raw.skipSelectors.filter((s) => typeof s === "string") : DEFAULT_SKIP,
    attributes: Array.isArray(raw.attributes) ? raw.attributes.filter((s) => typeof s === "string") : DEFAULT_ATTRS,
    segmentSeparators: Array.isArray(raw.segmentSeparators)
      ? raw.segmentSeparators.filter((s) => typeof s === "string" && s.length > 0)
      : [", "],
    segmentJoiner: typeof raw.segmentJoiner === "string" ? raw.segmentJoiner : "，",
  };
}

/** 词典文本来源：外部文件优先，否则内置资产 */
export function readDictionaryText(relPath: string): { text: string; source: string } {
  const file = resolveFromRoot(relPath);
  if (fs.existsSync(file)) return { text: fs.readFileSync(file, "utf8"), source: file };
  return { text: readAsset("zh-CN.json"), source: "(内置词典)" };
}

export function loadDictionary(relPath: string): Dictionary {
  return parseDictionary(readDictionaryText(relPath).text);
}

/** 读取注入脚本源码：SEA 用内置资产，开发模式读 inject/translator.js */
export function loadTranslatorSource(): string {
  if (IS_SEA) return readAsset("translator.js");
  return fs.readFileSync(path.join(APP_ROOT, "inject", "translator.js"), "utf8");
}

/**
 * 组装最终注入代码：先定义 window.__cursorZh，再装载词典。
 * 该脚本必须幂等——同一页面可能被多次注入。
 */
export function buildInjectSource(translator: string, dict: Dictionary): string {
  return `${translator}\n;(function(){try{window.__cursorZh.setDictionary(${JSON.stringify(dict)});}catch(e){console.warn('[cursor-zh] setDictionary failed',e);}})();`;
}

/** 监听词典文件变化（带去抖）。文件不存在时返回空操作。 */
export function watchDictionary(relPath: string, onChange: () => void): () => void {
  const file = resolveFromRoot(relPath);
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) return () => undefined;
  let timer: NodeJS.Timeout | undefined;
  const watcher = fs.watch(dir, (_evt, name) => {
    if (name && path.basename(file) !== name.toString()) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, 300);
  });
  return () => watcher.close();
}
