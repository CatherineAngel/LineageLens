import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AnalyzePayload, WorkerRequest, WorkerResponse } from "../worker/engine.worker";

type EngineStatus = "idle" | "loading" | "ready" | "error";

export function useEngine() {
  const workerRef = useRef<Worker | null>(null);
  const pending = useRef(new Map<string, (value: unknown) => void>());
  const [status, setStatus] = useState<EngineStatus>("loading");
  const [detail, setDetail] = useState("正在启动血缘引擎…");

  useEffect(() => {
    const worker = new Worker(new URL("../worker/engine.worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (message.type === "status") {
        if (message.stage === "ready") {
          setStatus("ready");
          setDetail(message.detail ?? "血缘引擎就绪");
        } else {
          setStatus("loading");
          setDetail(message.detail ?? "加载中…");
        }
        return;
      }
      if (message.type === "result") {
        pending.current.get(message.requestId)?.(message.result);
        pending.current.delete(message.requestId);
        return;
      }
      if (message.type === "error") {
        setStatus("error");
        setDetail(message.message);
        if (message.requestId) {
          pending.current.get(message.requestId)?.(null);
          pending.current.delete(message.requestId);
        }
      }
    };

    worker.onerror = (event) => {
      setStatus("error");
      setDetail(`引擎错误: ${event.message}`);
    };

    const init: WorkerRequest = { type: "init" };
    worker.postMessage(init);

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  const analyze = useCallback((payload: AnalyzePayload) => {
    const worker = workerRef.current;
    if (!worker) return Promise.resolve(null);
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise<unknown>((resolve) => {
      pending.current.set(requestId, resolve);
      const message: WorkerRequest = { type: "analyze", requestId, payload };
      worker.postMessage(message);
    });
  }, []);

  return useMemo(
    () => ({ status, detail, ready: status === "ready", analyze }),
    [status, detail, analyze],
  );
}
