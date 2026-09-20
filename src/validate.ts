/**
 * 词典校验：JSON 合法、无重复键、正则有效、无空译文/自映射。
 * 同时被 update-dict（运行时）与 scripts/validate-dict.mjs（CI）使用。
 */
export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  stats: { exact: number; patterns: number };
}

interface RawDict {
  exact?: Record<string, unknown>;
  patterns?: Array<{ match?: unknown; replace?: unknown; flags?: unknown }>;
  skipSelectors?: unknown;
  attributes?: unknown;
}

/**
 * 基于源文本扫描 exact 对象内的重复键（JSON.parse 会静默取最后一个）。
 * 简单的字符级扫描：进入 "exact": { 之后，记录深度为 1 且后接冒号的字符串字面量。
 */
function findDuplicateKeys(text: string): string[] {
  const start = /"exact"\s*:\s*\{/.exec(text);
  if (!start) return [];
  let i = start.index + start[0].length;
  let depth = 1;
  const seen = new Set<string>();
  const dup: string[] = [];
  while (i < text.length && depth > 0) {
    const ch = text[i];
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
    else if (ch === '"') {
      let j = i + 1;
      let raw = "";
      while (j < text.length && text[j] !== '"') {
        if (text[j] === "\\") raw += text[j] + text[j + 1], (j += 2);
        else raw += text[j++];
      }
      const after = text.slice(j + 1).match(/^\s*:/);
      if (depth === 1 && after) {
        let key: string;
        try {
          key = JSON.parse(`"${raw}"`) as string;
        } catch {
          key = raw;
        }
        if (!key.startsWith("_")) {
          if (seen.has(key)) dup.push(key);
          seen.add(key);
        }
      }
      i = j;
    }
    i++;
  }
  return dup;
}

export function validateDictionaryText(text: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  let d: RawDict;
  try {
    d = JSON.parse(text) as RawDict;
  } catch (e) {
    return { ok: false, errors: [`JSON 解析失败: ${(e as Error).message}`], warnings, stats: { exact: 0, patterns: 0 } };
  }
  if (!d || typeof d !== "object") errors.push("顶层必须是对象");
  const exact = d.exact && typeof d.exact === "object" ? d.exact : {};
  if (!d.exact) errors.push("缺少 exact 字段");

  let exactCount = 0;
  for (const [k, v] of Object.entries(exact)) {
    if (k.startsWith("_")) continue;
    exactCount++;
    if (typeof v !== "string") errors.push(`exact["${k}"] 的值不是字符串`);
    else if (v === "") errors.push(`exact["${k}"] 译文为空`);
    else if (v === k) warnings.push(`exact["${k}"] 译文与原文相同（无意义）`);
    if (!k.trim()) errors.push("exact 中存在空白键");
  }

  const dup = findDuplicateKeys(text);
  for (const k of dup) errors.push(`exact 重复键: "${k}"`);

  let patternCount = 0;
  const checkRules = (list: unknown, label: string): number => {
    let n = 0;
    if (list === undefined) return 0;
    if (!Array.isArray(list)) {
      errors.push(`${label} 必须是数组`);
      return 0;
    }
    (list as Array<{ match?: unknown; replace?: unknown; flags?: unknown }>).forEach((p, i) => {
      if (!p || typeof p.match !== "string" || typeof p.replace !== "string") {
        errors.push(`${label}[${i}] 缺少 match/replace 字符串`);
        return;
      }
      try {
        new RegExp(p.match, typeof p.flags === "string" ? p.flags.replace(/g/g, "") : "");
        n++;
      } catch (e) {
        errors.push(`${label}[${i}] 正则无效 ${JSON.stringify(p.match)}: ${(e as Error).message}`);
      }
    });
    return n;
  };
  patternCount = checkRules(d.patterns, "patterns");
  checkRules((d as Record<string, unknown>).suffixes, "suffixes");

  if (d.skipSelectors !== undefined && !Array.isArray(d.skipSelectors)) errors.push("skipSelectors 必须是数组");
  if (d.attributes !== undefined && !Array.isArray(d.attributes)) errors.push("attributes 必须是数组");

  return { ok: errors.length === 0, errors, warnings, stats: { exact: exactCount, patterns: patternCount } };
}
