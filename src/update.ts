/**
 * update-dict：手动从远程拉取最新词典。默认不会自动执行，只有用户显式运行该命令才联网。
 * 流程：下载 → 校验（validateDictionaryText）→ 备份旧文件 → 覆盖。校验失败不改动本地文件。
 */
import fs from "node:fs";
import https from "node:https";
import http from "node:http";
import path from "node:path";
import { resolveFromRoot } from "./paths.js";
import { validateDictionaryText } from "./validate.js";

function download(url: string, redirects = 3): Promise<string> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("http:") ? http : https;
    const req = mod.get(url, { headers: { "User-Agent": "cursor-zh" }, timeout: 20_000 }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).href, redirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve(body));
    });
    req.on("timeout", () => req.destroy(new Error("下载超时")));
    req.on("error", reject);
  });
}

export interface UpdateResult {
  changed: boolean;
  backup?: string;
  stats: { exact: number; patterns: number };
  warnings: string[];
}

export async function updateDictionary(url: string, relPath: string): Promise<UpdateResult> {
  const text = await download(url);
  const v = validateDictionaryText(text);
  if (!v.ok) throw new Error(`远程词典校验失败，未改动本地文件:\n  ${v.errors.slice(0, 10).join("\n  ")}`);

  const target = resolveFromRoot(relPath);
  const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : undefined;
  if (current === text) return { changed: false, stats: v.stats, warnings: v.warnings };

  let backup: string | undefined;
  if (current !== undefined) {
    backup = target + ".bak";
    fs.copyFileSync(target, backup);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text, "utf8");
  return { changed: true, backup, stats: v.stats, warnings: v.warnings };
}
