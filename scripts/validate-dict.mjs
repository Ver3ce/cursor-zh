/**
 * 校验词典文件（默认 dict/zh-CN.json）。供 CI 与词典贡献者本地使用。
 *   node scripts/validate-dict.mjs [path]
 * 需先 npm run build（复用 dist/validate.js 的规则，与运行时 update-dict 完全一致）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = path.resolve(process.argv[2] ?? path.join(ROOT, "dict", "zh-CN.json"));
const { validateDictionaryText } = await import(pathToFileURL(path.join(ROOT, "dist", "validate.js")).href);

const text = fs.readFileSync(file, "utf8");
const r = validateDictionaryText(text);
console.log(`词典: ${path.relative(ROOT, file)}`);
console.log(`精确词条: ${r.stats.exact}   正则模板: ${r.stats.patterns}`);
for (const w of r.warnings) console.log(`警告: ${w}`);
for (const e of r.errors) console.log(`错误: ${e}`);

// 额外检查：文件必须是 UTF-8 且以换行结尾（便于 diff）
if (!text.endsWith("\n")) console.log("警告: 文件末尾缺少换行");

console.log(r.ok ? "校验通过" : `校验失败（${r.errors.length} 个错误）`);
process.exit(r.ok ? 0 : 1);
