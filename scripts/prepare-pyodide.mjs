#!/usr/bin/env node
/**
 * Copies the pyodide runtime into public/ so the browser prototype can run
 * fully offline (mirrors the packaged VSIX layout).
 *
 * The lineage engine itself is bundled through Vite's `?raw` import, so it is
 * intentionally NOT copied here - that would create a stale duplicate.
 */
import { mkdir, stat, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pyodideSrc = path.join(root, "node_modules/pyodide");
const pyodideDest = path.join(root, "public/pyodide");

const REQUIRED = [
  "pyodide.asm.js",
  "pyodide.asm.wasm",
  "pyodide.mjs",
  "pyodide.js",
  "python_stdlib.zip",
  "pyodide-lock.json",
];

async function main() {
  if (!existsSync(pyodideSrc)) {
    console.error("找不到 node_modules/pyodide，请先运行 npm install");
    process.exit(1);
  }

  await mkdir(pyodideDest, { recursive: true });
  let bytes = 0;
  for (const file of REQUIRED) {
    const from = path.join(pyodideSrc, file);
    if (!existsSync(from)) {
      console.warn(`  跳过缺失文件: ${file}`);
      continue;
    }
    await copyFile(from, path.join(pyodideDest, file));
    bytes += (await stat(from)).size;
  }

  console.log(`pyodide 运行时已复制 (${(bytes / 1024 / 1024).toFixed(1)} MB) -> public/pyodide`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
