import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Edge,
  MiniMap,
  NodeTypes,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { TableNode } from "./graph/TableNode";
import { buildEdges, buildNodes, layout, LineageNode, statusColor } from "./graph/layout";
import {
  AnalyzeResult,
  DIALECTS,
  STATUS_META,
  TRANSFORM_META,
  dialectById,
  GraphNode,
} from "./shared/types";
import type { HostMessage, WebviewMessage } from "../protocol";

declare function acquireVsCodeApi(): {
  postMessage: (message: WebviewMessage) => void;
  getState: () => unknown;
  setState: (state: unknown) => void;
};

const vscode = acquireVsCodeApi();
const nodeTypes: NodeTypes = { table: TableNode };

function FitViewOnChange({ signal, nodeCount }: { signal: string; nodeCount: number }) {
  const { fitView } = useReactFlow();
  const lastSignal = useRef("");

  useEffect(() => {
    if (!signal || nodeCount === 0 || lastSignal.current === signal) return;
    lastSignal.current = signal;
    let inner = 0;
    const outer = window.requestAnimationFrame(() => {
      inner = window.requestAnimationFrame(() => {
        void fitView({ padding: 0.16, duration: 280 });
      });
    });
    return () => {
      window.cancelAnimationFrame(outer);
      if (inner) window.cancelAnimationFrame(inner);
    };
  }, [signal, nodeCount, fitView]);

  return null;
}

function Workspace() {
  const [result, setResult] = useState<AnalyzeResult | null>(null);
  const [fileName, setFileName] = useState("");
  const [dialectId, setDialectId] = useState("hive");
  const [dialectOrigin, setDialectOrigin] = useState<"override" | "header" | "setting">("setting");
  const [engineStatus, setEngineStatus] = useState("正在启动血缘引擎…");
  const [engineState, setEngineState] = useState<"loading" | "ready" | "error">("loading");
  const [busy, setBusy] = useState(false);
  const [emptyReason, setEmptyReason] = useState<string | null>(null);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);

  const [nodes, setNodes, onNodesChange] = useNodesState<LineageNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  const toggleNode = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  useEffect(() => {
    const handler = (event: MessageEvent<HostMessage>) => {
      const message = event.data;
      switch (message.type) {
        case "status":
          setEngineStatus(message.detail);
          setEngineState(message.state);
          break;
        case "busy":
          setBusy(message.busy);
          break;
        case "empty":
          setResult(null);
          setEmptyReason(message.reason);
          setFileName(message.fileName);
          setSelectedNode(null);
          break;
        case "result":
          setResult(message.result);
          setEmptyReason(null);
          setFileName(message.fileName);
          setDialectId(message.dialect.id);
          setDialectOrigin(message.dialectOrigin);
          setExpanded(new Set());
          setFocusedId(null);
          setSelectedNode(null);
          break;
      }
    };
    window.addEventListener("message", handler);
    vscode.postMessage({ type: "ready" });
    return () => window.removeEventListener("message", handler);
  }, []);

  const graphNodes = result?.graph.nodes ?? [];
  const columnEdges = result?.graph.columnEdges ?? [];
  const stats = result?.stats;

  const fitSignal = useMemo(() => {
    if (!result) return "";
    return [
      result.graph.nodes.map((n) => n.id).join("|"),
      result.graph.edges.map((e) => e.id).join("|"),
      result.statements.map((s) => s.status).join("|"),
      stats?.wallMs ?? stats?.parseMs ?? 0,
    ].join("#");
  }, [result, stats]);

  useEffect(() => {
    if (!result) {
      setNodes([]);
      setEdges([]);
      return;
    }
    const baseNodes = buildNodes(graphNodes, columnEdges, expanded, focusedId, toggleNode);
    const baseEdges = buildEdges(result.graph.edges, columnEdges, focusedId, expanded);
    setNodes(layout(baseNodes, baseEdges));
    setEdges(baseEdges);
  }, [result, expanded, focusedId, toggleNode, setNodes, setEdges]);

  const issueCount = useMemo(() => {
    if (!result) return 0;
    return result.statements.reduce(
      (sum, s) => sum + (s.status === "ok" ? 0 : 1) + s.warnings.length,
      0,
    );
  }, [result]);

  const dialect = dialectById(dialectId);
  const originLabel =
    dialectOrigin === "header" ? "来自文件头" : dialectOrigin === "override" ? "已手动切换" : "工作区默认";

  return (
    <div className="app app--webview">
      <header className="topbar">
        <div className="brand">
          <span className="brand__mark">血</span>
          <div>
            <div className="brand__title">{fileName || "SQL 血缘"}</div>
            <div className="brand__sub">{busy ? "分析中…" : engineStatus}</div>
          </div>
        </div>

        <div className="dialect-picker">
          <button
            className="dialect-chip is-active"
            onClick={() => vscode.postMessage({ type: "pickDialect" })}
            style={{ ["--chip" as string]: dialect.accent }}
            title={`${dialect.note} · ${originLabel}（点击切换）`}
          >
            {dialect.label} ▾
          </button>
          <span className="dialect-origin">{originLabel}</span>
        </div>

        <div className="topbar__status">
          <span className={`engine-dot engine-dot--${engineState}`} />
          {stats && (
            <span className="stat-group">
              <span className="stat">
                <b>{stats.tableCount}</b> 表
              </span>
              <span className="stat">
                <b>{stats.columnEdgeCount}</b> 列边
              </span>
              <span className="stat">
                <b>{stats.wallMs ?? stats.parseMs}</b> ms
              </span>
            </span>
          )}
          <button className="icon-btn" onClick={() => vscode.postMessage({ type: "refresh" })} title="重新分析">
            ↻
          </button>
        </div>
      </header>

      <div className="graph-pane">
        <div className="graph-canvas">
          {!result && (
            <div className="empty-state">
              <div className="empty-state__icon">∅</div>
              <div>{emptyReason ?? "暂无血缘数据"}</div>
              <div className="empty-state__hint">
                {emptyReason
                  ? ""
                  : "在 SQL 文件中写入 INSERT / CREATE AS SELECT 语句，血缘图会自动出现"}
              </div>
            </div>
          )}
          {result && graphNodes.length === 0 && (
            <div className="empty-state">
              <div className="empty-state__icon">∅</div>
              <div>没有识别到血缘关系</div>
              <div className="empty-state__hint">
                检查方言是否选对，或语句是否包含 INSERT / CREATE AS SELECT
              </div>
            </div>
          )}

          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={(_, node) => {
              setFocusedId(node.id);
              const found = graphNodes.find((n) => n.id === node.id) ?? null;
              setSelectedNode(found);
              if (found) {
                vscode.postMessage({
                  type: "revealNode",
                  nodeId: found.id,
                  line: found.line ?? null,
                  charRange: found.charRange ?? null,
                });
              }
            }}
            onPaneClick={() => {
              setFocusedId(null);
              setSelectedNode(null);
            }}
            fitView
            minZoom={0.15}
            maxZoom={2}
            proOptions={{ hideAttribution: true }}
            defaultEdgeOptions={{ type: "smoothstep" }}
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#1e293b" />
            <Controls showInteractive={false} />
            <FitViewOnChange signal={fitSignal} nodeCount={nodes.length} />
            <MiniMap
              pannable
              zoomable
              nodeColor={(n) => statusColor((n.data as any).node.status)}
              maskColor="rgba(2, 6, 23, 0.72)"
              style={{ background: "#0b1220" }}
            />
          </ReactFlow>
        </div>

        <div className="detail-panel">
          <div className="detail-panel__head">
            <span>语句</span>
            <span className="detail-panel__count">{result?.statements.length ?? 0} 条</span>
            {issueCount > 0 && <span className="detail-panel__issues">⚠ {issueCount} 个提示</span>}
          </div>
          <ul className="stmt-list">
            {(result?.statements ?? []).map((statement) => {
              const meta = STATUS_META[statement.status];
              return (
                <li key={statement.index} className={`stmt-item stmt-item--${statement.status}`}>
                  <div className="stmt-item__head">
                    <span className="stmt-item__index">#{statement.index + 1}</span>
                    <span className="stmt-item__kind">{statement.kind}</span>
                    <span
                      className="stmt-item__status"
                      style={{ color: meta.color, borderColor: meta.color }}
                      title={meta.hint}
                    >
                      {meta.label}
                    </span>
                    <span className="stmt-item__line">L{statement.slice.startLine}</span>
                  </div>
                  <div className="stmt-item__body">
                    <span className="muted">目标：</span>
                    {
                      <button
                        className="link-btn"
                        onClick={() =>
                          statement.target &&
                          vscode.postMessage({
                            type: "revealNode",
                            nodeId: statement.target,
                            line: statement.slice.startLine,
                            charRange: null,
                          })
                        }
                      >
                        {statement.target ?? "—"}
                      </button>
                    }
                  </div>
                  <div className="stmt-item__body">
                    <span className="muted">源表：</span>
                    {statement.sources.map((s) => s.name).join(", ") || "—"}
                  </div>
                  {statement.columns.length > 0 && (
                    <details className="stmt-item__columns">
                      <summary>{statement.columns.length} 个输出列</summary>
                      <ul>
                        {statement.columns.map((column) => (
                          <li key={column.name}>
                            <code>{column.name}</code>
                            {column.edges.length > 0 ? (
                              <span className="muted">
                                {" ← "}
                                {column.edges
                                  .map((e) => `${e.sourceTable}.${e.sourceColumn}`)
                                  .join(" , ")}
                              </span>
                            ) : (
                              <span className="muted"> ← 常量/无来源</span>
                            )}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                  {statement.warnings.length > 0 && (
                    <ul className="stmt-item__warnings">
                      {statement.warnings.map((warning, i) => (
                        <li key={i}>{warning}</li>
                      ))}
                    </ul>
                  )}
                  {(statement.notes?.length ?? 0) > 0 && (
                    <ul className="stmt-item__notes">
                      {statement.notes!.map((note, i) => (
                        <li key={i}>{note}</li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>

          <div className="legend">
            <div className="legend__title">图例</div>
            <div className="legend__row">
              {(["direct", "aggregate", "function", "case"] as const).map((key) => {
                const meta = TRANSFORM_META[key];
                return (
                  <span key={key} className="legend__item">
                    <span
                      className="legend__line"
                      style={{
                        background: meta.color,
                        height: 2,
                        ...(meta.dash
                          ? {
                              backgroundImage: `repeating-linear-gradient(90deg, ${meta.color} 0 6px, transparent 6px 9px)`,
                              background: "none",
                            }
                          : {}),
                      }}
                    />
                    {meta.label}
                  </span>
                );
              })}
            </div>
            <div className="legend__row">
              {(Object.keys(STATUS_META) as Array<keyof typeof STATUS_META>).map((key) => (
                <span key={key} className="legend__item">
                  <span className="legend__dot" style={{ background: STATUS_META[key].color }} />
                  {STATUS_META[key].label}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      {selectedNode && (
        <div className="node-hint">
          <span className="node-hint__name">{selectedNode.id}</span>
          <span className="node-hint__meta">
            {selectedNode.roles
              .map((role) => (role === "source" ? "源表" : "目标表"))
              .join(" / ")}
            {typeof selectedNode.line === "number" ? ` · 第 ${selectedNode.line} 行` : ""}
          </span>
          <button
            className="ghost-btn"
            onClick={() => vscode.postMessage({ type: "copyNodeName", name: selectedNode.id })}
          >
            复制表名
          </button>
          <button
            className="ghost-btn"
            onClick={() =>
              vscode.postMessage({
                type: "revealNode",
                nodeId: selectedNode.id,
                line: selectedNode.line ?? 1,
                charRange: selectedNode.charRange ?? null,
              })
            }
          >
            定位
          </button>
        </div>
      )}
    </div>
  );
}

export default function App() {
  return (
    <ReactFlowProvider>
      <Workspace />
    </ReactFlowProvider>
  );
}

// Re-exported so the bundler keeps the dialect table reachable for tooling.
export { DIALECTS };
