#!/usr/bin/env node
/**
 * Builds the extension in three passes:
 *
 *   1. extension host  -> dist/extension.js       (node, cjs, vscode external)
 *   2. engine worker   -> dist/engineWorker.js    (node, cjs, pyodide bundled in)
 *   3. webview         -> media/webview.js/.css   (browser, esm)
 *
 * It also stages vendor/pyodide + the sqlglot wheel so the shipped VSIX needs
 * no network access and no node_modules.
 */
import { build, context } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const watch = process.argv.includes("--watch");

const VENDOR_PYODIDE = [
  "pyodide.asm.js",
  "pyodide.asm.wasm",
  "pyodide.js",
  "pyodide.mjs",
  "python_stdlib.zip",
  "pyodide-lock.json",
];

const pyTextPlugin = {
  name: "py-text",
  setup(build) {
    build.onLoad({ filter: /\.py$/ }, async (args) => ({
      contents: await readFile(args.path, "utf8"),
      loader: "text",
    }));
  },
};

const shared = {
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  sourcemap: true,
  logLevel: "warning",
  plugins: [pyTextPlugin],
  // pyodide resolves its Node helpers through `import("node:...")`; those are
  // real builtins and must stay external rather than being bundled away.
  external: ["node:*", "ws"],
};

async function stageVendor() {
  const src = path.join(root, "node_modules", "pyodide");
  if (!existsSync(src)) throw new Error("缺少 node_modules/pyodide，请先 npm install");

  const dest = path.join(root, "vendor", "pyodide");
  await mkdir(dest, { recursive: true });
  for (const file of VENDOR_PYODIDE) {
    const from = path.join(src, file);
    if (!existsSync(from)) continue;
    await cp(from, path.join(dest, file));
  }

  const wheelDir = path.join(root, "vendor", "wheels");
  await mkdir(wheelDir, { recursive: true });
  const wheelSource = path.join(root, "..", "public", "wheels");
  const existing = path.join(wheelDir, "sqlglot-30.33.0-py3-none-any.whl");
  if (!existsSync(existing)) {
    const candidate = path.join(wheelSource, "sqlglot-30.33.0-py3-none-any.whl");
    if (existsSync(candidate)) {
      await cp(candidate, existing);
    } else {
      throw new Error(
        "找不到 sqlglot wheel。请先下载到 public/wheels/sqlglot-30.33.0-py3-none-any.whl",
      );
    }
  }
}

async function buildWebview() {
  const result = await build({
    entryPoints: [path.join(root, "src", "webview", "main.tsx")],
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2020",
    jsx: "automatic",
    outfile: path.join(root, "media", "webview.js"),
    minify: !watch,
    sourcemap: !watch,
    logLevel: "warning",
    define: { "process.env.NODE_ENV": watch ? '"development"' : '"production"' },
    loader: { ".css": "css" },
  });

  // esbuild emits webview.css next to the js; that is exactly what index.html loads.
  void result;
  return result;
}

async function main() {
  await rm(path.join(root, "dist"), { recursive: true, force: true });
  await mkdir(path.join(root, "dist"), { recursive: true });
  await mkdir(path.join(root, "media"), { recursive: true });

  await stageVendor();

  const hostOptions = {
    ...shared,
    entryPoints: [path.join(root, "src", "extension.ts")],
    outfile: path.join(root, "dist", "extension.js"),
    external: [...shared.external, "vscode"],
  };

  const workerOptions = {
    ...shared,
    entryPoints: [path.join(root, "src", "engineWorker.ts")],
    outfile: path.join(root, "dist", "engineWorker.js"),
  };

  if (watch) {
    const hostCtx = await context(hostOptions);
    const workerCtx = await context(workerOptions);
    await hostCtx.watch();
    await workerCtx.watch();
    await buildWebview();
    console.log("watching (extension / worker / webview)…");
    return;
  }

  await Promise.all([build(hostOptions), build(workerOptions), buildWebview()]);

  // index.html ships as-is; the host substitutes the CSP/script placeholders.
  const html = await readFile(path.join(root, "media", "index.html"), "utf8");
  if (!html.includes("{{script}}")) {
    throw new Error("media/index.html 缺少 {{script}} 占位符");
  }
  await writeFile(path.join(root, "media", "index.html"), html);

  const sizeOf = (file) => {
    const bytes = statSync(file).size;
    return bytes >= 1024 * 1024
      ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
      : `${Math.round(bytes / 1024)} KB`;
  };

  console.log(
    [
      "build ok:",
      `  extension.js    ${sizeOf(path.join(root, "dist", "extension.js"))}`,
      `  engineWorker.js ${sizeOf(path.join(root, "dist", "engineWorker.js"))}`,
      `  webview.js      ${sizeOf(path.join(root, "media", "webview.js"))}`,
    ].join("\n"),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
