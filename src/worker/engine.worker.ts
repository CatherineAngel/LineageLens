/// <reference lib="webworker" />

// Bundled as text so the engine can never drift from a stale copy in public/.
import engineSource from "../../engine/lineage_engine.py?raw";

export interface AnalyzePayload {
  dialectId: string;
  sqlglotDialect: string;
  sql: string;
  schema?: Record<string, Record<string, string>>;
  options?: { includeColumnLineage?: boolean; maxStatements?: number };
}

export type WorkerRequest =
  | { type: "init" }
  | { type: "analyze"; requestId: string; payload: AnalyzePayload };

export type WorkerResponse =
  | { type: "status"; stage: "loading-pyodide" | "loading-wheels" | "loading-sqlglot" | "ready"; detail?: string }
  | { type: "result"; requestId: string; result: unknown }
  | { type: "error"; requestId?: string; message: string };

let engineFn: ((payload: string) => string) | null = null;
let bootPromise: Promise<void> | null = null;

function post(message: WorkerResponse) {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(message);
}

async function boot() {
  post({ type: "status", stage: "loading-pyodide", detail: "正在加载 Python 运行时…" });

  const { loadPyodide } = await import("pyodide");
  const pyodide = await loadPyodide({
    indexURL: `${self.location.origin}/pyodide/`,
  });

  post({ type: "status", stage: "loading-wheels", detail: "正在装载 sqlglot…" });

  // A wheel is just a zip: unpack it into site-packages instead of pulling in
  // micropip (which would need its own network fetch and dependency resolution).
  const wheelUrl = `${self.location.origin}/wheels/sqlglot-30.33.0-py3-none-any.whl`;
  const response = await fetch(wheelUrl);
  if (!response.ok) throw new Error(`无法下载 sqlglot wheel: ${response.status}`);
  const buffer = await response.arrayBuffer();
  pyodide.unpackArchive(buffer, "zip", { extractDir: "/tmp/sqlglot-wheel" });

  pyodide.runPython(`
import sys
sys.path.insert(0, "/tmp/sqlglot-wheel")
`);

  post({ type: "status", stage: "loading-sqlglot", detail: "正在初始化血缘引擎…" });

  pyodide.FS.writeFile("/tmp/lineage_engine.py", engineSource);
  pyodide.runPython(`
import sys
sys.path.insert(0, "/tmp")
from lineage_engine import analyze as _analyze
`);

  engineFn = pyodide.globals.get("_analyze") as (payload: string) => string;
  post({ type: "status", stage: "ready", detail: "血缘引擎就绪" });
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;

  if (message.type === "init") {
    if (!bootPromise) bootPromise = boot().catch((err) => {
      post({ type: "error", message: `引擎启动失败: ${String(err)}` });
      throw err;
    });
    await bootPromise;
    return;
  }

  if (message.type === "analyze") {
    try {
      if (!bootPromise) {
        bootPromise = boot();
      }
      await bootPromise;
      if (!engineFn) throw new Error("引擎尚未就绪");
      const raw = engineFn(JSON.stringify(message.payload));
      const result = typeof raw === "string" ? JSON.parse(raw) : raw;
      post({ type: "result", requestId: message.requestId, result });
    } catch (err) {
      post({ type: "error", requestId: message.requestId, message: String(err) });
    }
  }
};
