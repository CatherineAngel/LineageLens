import * as path from "node:path";
import { Worker } from "node:worker_threads";

export interface AnalyzePayload {
  dialectId: string;
  sqlglotDialect: string;
  sql: string;
  schema?: Record<string, Record<string, string>>;
  options?: { includeColumnLineage?: boolean; maxStatements?: number };
}

export type EngineState = "idle" | "loading" | "ready" | "error";

export interface EngineStatus {
  state: EngineState;
  detail: string;
}

/**
 * Owns the analysis worker. Booting Pyodide costs ~0.7s, so the worker is
 * started during activation rather than on first use, and all callers share
 * the same warm instance.
 */
export class EngineClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, (value: unknown) => void>();
  private status: EngineStatus = { state: "idle", detail: "未启动" };
  private listeners = new Set<(status: EngineStatus) => void>();

  constructor(
    private readonly extensionPath: string,
    private readonly workerFile: string,
    private readonly wheelFile: string,
  ) {}

  getStatus(): EngineStatus {
    return this.status;
  }

  onStatus(listener: (status: EngineStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  private setStatus(state: EngineState, detail: string) {
    this.status = { state, detail };
    for (const listener of this.listeners) listener(this.status);
  }

  start(): void {
    if (this.worker) return;

    const workerPath = path.join(this.extensionPath, this.workerFile);
    const vendorDir = path.join(this.extensionPath, "vendor", "pyodide");
    const wheelPath = path.join(this.extensionPath, "vendor", "wheels", this.wheelFile);

    this.setStatus("loading", "正在启动血缘引擎…");
    try {
      this.worker = new Worker(workerPath);
    } catch (error) {
      this.setStatus("error", `无法启动引擎进程: ${String(error)}`);
      return;
    }

    this.worker.on("message", (message: any) => {
      if (message.type === "ready") {
        this.setStatus("ready", "血缘引擎就绪");
        return;
      }
      if (message.type === "status") {
        this.setStatus("loading", message.detail);
        return;
      }
      if (message.type === "result") {
        const resolve = this.pending.get(message.requestId);
        this.pending.delete(message.requestId);
        resolve?.(message.result);
        return;
      }
      if (message.type === "error") {
        if (typeof message.requestId === "number") {
          const resolve = this.pending.get(message.requestId);
          this.pending.delete(message.requestId);
          resolve?.(null);
        } else {
          this.setStatus("error", message.message);
        }
      }
    });

    this.worker.on("error", (error) => {
      this.setStatus("error", `引擎进程异常: ${String(error)}`);
      this.failPending();
      this.worker = null;
    });

    this.worker.on("exit", (code) => {
      if (code !== 0 && this.status.state !== "error") {
        this.setStatus("error", `引擎进程退出 (code ${code})`);
      }
      // Callers must never be left awaiting a dead worker.
      this.failPending();
      this.worker = null;
    });

    this.worker.postMessage({ type: "init", vendorDir, wheelPath });
  }

  async analyze(payload: AnalyzePayload): Promise<unknown> {
    this.start();
    if (!this.worker) return null;

    // A wedged worker must not hang the editor forever; 30s is far beyond the
    // worst observed case (~1.4s including cold start).
    const timeoutMs = 30_000;
    const requestId = this.nextId++;

    return new Promise<unknown>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(requestId)) {
          this.setStatus("error", `引擎响应超时（${timeoutMs / 1000}s）`);
          resolve(null);
        }
      }, timeoutMs);
      timer.unref?.();

      this.pending.set(requestId, (value) => {
        clearTimeout(timer);
        resolve(value);
      });

      try {
        this.worker!.postMessage({ type: "analyze", requestId, payload });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        resolve(null);
      }
    });
  }

  /** Resolve every in-flight request with null so no caller awaits forever. */
  private failPending(): void {
    const resolvers = [...this.pending.values()];
    this.pending.clear();
    for (const resolve of resolvers) resolve(null);
  }

  dispose(): void {
    this.failPending();
    void this.worker?.terminate();
    this.worker = null;
  }
}
