/**
 * Engine host: Pyodide + sqlglot inside a worker thread.
 *
 * Mirrors the browser prototype, with two differences:
 *   - Pyodide is resolved from the extension bundle (offline, no network).
 *   - Sources are pushed into Pyodide's *virtual* FS; host paths are invisible.
 */
import { parentPort } from "node:worker_threads";
import fs from "node:fs";

// Static import so esbuild inlines pyodide into dist/engineWorker.js; a
// runtime createRequire("pyodide") would fail in a packaged VSIX that has no
// node_modules. pyodide.asm.js / .wasm / python_stdlib.zip are still loaded at
// runtime from `indexURL`, which is why vendor/pyodide ships alongside.
import { loadPyodide } from "pyodide";

// Bundled as text by esbuild (loader: { ".py": "text" }) so the engine can
// never drift from a stale copy on disk.
import engineSource from "../lineage_engine.py";

export interface AnalyzePayload {
  dialectId: string;
  sqlglotDialect: string;
  sql: string;
  schema?: Record<string, Record<string, string>>;
  options?: { includeColumnLineage?: boolean; maxStatements?: number };
}

type Request =
  | { type: "init"; vendorDir: string; wheelPath: string }
  | { type: "analyze"; requestId: number; payload: AnalyzePayload };

type Response =
  | { type: "ready" }
  | { type: "status"; detail: string }
  | { type: "result"; requestId: number; result: unknown }
  | { type: "error"; requestId?: number; message: string };

let engineFn: ((payload: string) => string) | null = null;
let bootPromise: Promise<void> | null = null;
let bootConfig: { vendorDir: string; wheelPath: string } | null = null;

function post(message: Response) {
  parentPort?.postMessage(message);
}

async function boot() {
  if (!bootConfig) throw new Error("引擎未配置 vendor 路径");

  post({ type: "status", detail: "正在加载 Python 运行时…" });
  const py = await loadPyodide({ indexURL: bootConfig.vendorDir });

  post({ type: "status", detail: "正在装载 sqlglot…" });
  const wheel = fs.readFileSync(bootConfig.wheelPath);
  py.unpackArchive(
    wheel.buffer.slice(wheel.byteOffset, wheel.byteOffset + wheel.byteLength),
    "zip",
    { extractDir: "/tmp/sqlglot-wheel" },
  );

  post({ type: "status", detail: "正在初始化血缘引擎…" });
  // Pyodide has its own virtual FS: the host path is not readable inside it.
  py.FS.writeFile("/tmp/lineage_engine.py", engineSource);
  py.runPython(`
import sys
sys.path.insert(0, "/tmp/sqlglot-wheel")
sys.path.insert(0, "/tmp")
from lineage_engine import analyze as _analyze
`);

  engineFn = py.globals.get("_analyze") as (payload: string) => string;
  post({ type: "ready" });
}

parentPort?.on("message", async (event: Request) => {
  if (event.type === "init") {
    bootConfig = { vendorDir: event.vendorDir, wheelPath: event.wheelPath };
    if (!bootPromise) {
      bootPromise = boot().catch((error) => {
        post({ type: "error", message: `引擎启动失败: ${String(error)}` });
        bootPromise = null;
        throw error;
      });
    }
    try {
      await bootPromise;
    } catch {
      /* already reported */
    }
    return;
  }

  if (event.type === "analyze") {
    try {
      if (!bootPromise) throw new Error("引擎尚未初始化");
      await bootPromise;
      if (!engineFn) throw new Error("引擎尚未就绪");
      const raw = engineFn(JSON.stringify(event.payload));
      const result = typeof raw === "string" ? JSON.parse(raw) : raw;
      post({ type: "result", requestId: event.requestId, result });
    } catch (error) {
      post({
        type: "error",
        requestId: event.requestId,
        message: `${String(error).split("\n")[0]}`,
      });
    }
  }
});
