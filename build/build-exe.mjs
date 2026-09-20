/**
 * 构建单文件 exe（Node Single Executable Application）
 *
 *   1. esbuild：src/index.ts → dist/cursor-zh.cjs（SEA 要求 CommonJS，把 ws 一并打入）
 *   2. node --experimental-sea-config build/sea-config.json → build/out/sea-prep.blob
 *   3. 复制当前 node.exe → build/out/cursor-zh.exe
 *   4. postject 把 blob 注入 exe
 *   5. rcedit 写入版本信息（可选，失败不致命）
 *
 * 用法：npm run build:exe   （需在 Windows 上、Node >= 20 运行）
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { inject } from "postject";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "build", "out");
const BUNDLE = path.join(ROOT, "dist", "cursor-zh.cjs");
const BLOB = path.join(OUT_DIR, "sea-prep.blob");
const EXE = path.join(OUT_DIR, "cursor-zh.exe");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

function step(msg) {
  console.log(`\n== ${msg}`);
}

if (process.platform !== "win32") {
  console.error("build-exe 目前仅支持在 Windows 上构建 Windows exe。");
  process.exit(1);
}
const major = Number(process.versions.node.split(".")[0]);
if (major < 20) {
  console.error(`需要 Node >= 20（当前 ${process.version}）`);
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

step("1/5 esbuild 打包为 CommonJS");
await build({
  entryPoints: [path.join(ROOT, "src", "index.ts")],
  bundle: true,
  platform: "node",
  target: `node${major}`,
  format: "cjs",
  outfile: BUNDLE,
  // ws 的可选原生加速模块，运行时 require 失败会被 ws 自行捕获
  external: ["bufferutil", "utf-8-validate"],
  // 源码里的 import.meta.url 在 CJS 中不可用：SEA 内 __filename === process.execPath
  define: { "import.meta.url": "__cz_import_meta_url", __CZ_VERSION__: JSON.stringify(pkg.version) },
  banner: { js: "const __cz_import_meta_url = require('node:url').pathToFileURL(__filename).href;" },
  legalComments: "none",
  logLevel: "warning",
});
console.log(`   ${path.relative(ROOT, BUNDLE)} (${(fs.statSync(BUNDLE).size / 1024).toFixed(0)} KB)`);

step("2/5 生成 SEA blob");
execFileSync(process.execPath, ["--experimental-sea-config", "build/sea-config.json"], { cwd: ROOT, stdio: "inherit" });

step("3/5 复制 node.exe");
fs.copyFileSync(process.execPath, EXE);

step("4/5 注入 blob（postject）");
await inject(EXE, "NODE_SEA_BLOB", fs.readFileSync(BLOB), {
  sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
});

step("5/5 写入版本信息（rcedit，可选）");
// rcedit 在部分环境下对 80MB+ 的 exe 会长时间挂起，因此默认跳过；设置 CZ_RCEDIT=1 启用，并带 60s 超时。
if (process.env.CZ_RCEDIT === "1") {
  try {
    const { default: rcedit } = await import("rcedit");
    const ver = /^\d+\.\d+\.\d+$/.test(pkg.version) ? `${pkg.version}.0` : "0.0.0.0";
    const work = rcedit(EXE, {
      "version-string": {
        ProductName: "cursor-zh",
        FileDescription: "Cursor 界面运行时汉化（CDP 注入，不修改安装文件）",
        CompanyName: pkg.author ?? "",
        LegalCopyright: "MIT License. https://github.com/Ver3ce/cursor-zh",
        OriginalFilename: "cursor-zh.exe",
      },
      "file-version": ver,
      "product-version": ver,
    });
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("rcedit 超时 60s")), 60_000));
    await Promise.race([work, timeout]);
    console.log("   已写入版本信息");
  } catch (e) {
    console.warn(`   rcedit 失败（不影响可用性）: ${e.message}`);
    try {
      execFileSync("taskkill", ["/F", "/IM", "rcedit-x64.exe"], { stdio: "ignore" });
    } catch {
      /* 无残留进程 */
    }
  }
} else {
  console.log("   跳过（设置 CZ_RCEDIT=1 可启用）");
}

// 便携包所需的附属文件：让用户即使没有 exe 也能看懂目录
fs.copyFileSync(path.join(ROOT, "config.default.json"), path.join(OUT_DIR, "config.default.json"));
fs.mkdirSync(path.join(OUT_DIR, "dict"), { recursive: true });
fs.copyFileSync(path.join(ROOT, "dict", "zh-CN.json"), path.join(OUT_DIR, "dict", "zh-CN.json"));

const mb = (fs.statSync(EXE).size / 1024 / 1024).toFixed(1);
console.log(`\n完成: ${path.relative(ROOT, EXE)} (${mb} MB)`);
