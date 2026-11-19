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
} from "./shared/types";
import { useEngine } from "./hooks/useEngine";
import { SAMPLES } from "./samples";
import { SyntaxSheet } from "./components/SyntaxSheet";

const nodeTypes: NodeTypes = { table: TableNode };

/** Re-fits the viewport whenever a new graph lands (fitView only runs on init). */
function FitViewOnChange({ signal, nodeCount }: { signal: string; nodeCount: number }) {
  const { fitView } = useReactFlow();
  const lastSignal = useRef("");

  useEffect(() => {
    if (!signal || nodeCount === 0 || lastSignal.current === signal) return;
    lastSignal.current = signal;
    // Two frames: one for the nodes to mount, one for their measured size.
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
  const [dialectId, setDialectId] = useState("hive");
  const [sql, setSql] = useState(SAMPLES[0].sql);
  const [result, setResult] = useState<AnalyzeResult | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [realtime, setRealtime] = useState(true);
  const [showPanel, setShowPanel] = useState(true);
  const [showSyntax, setShowSyntax] = useState(false);

  const { status, detail, ready, analyze } = useEngine();

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

  const requestSeq = useRef(0);

  const runAnalysis = useCallback(
    async (text: string, targetDialect: string) => {
      const seq = ++requestSeq.current;
      if (!text.trim()) {
        setResult(null);
        return;
      }
      const spec = dialectById(targetDialect);
      const response = (await analyze({
        dialectId: spec.id,
        sqlglotDialect: spec.sqlglotDialect,
        sql: text,
        schema: {},
        options: { includeColumnLineage: true, maxStatements: 500 },
      })) as AnalyzeResult | null;
      // Drop stale responses so fast dialect switching cannot show old graphs.
      if (seq !== requestSeq.current) return;
      if (response) setResult(response);
    },
    [analyze],
  );

  const timer = useRef<number | null>(null);
  const lastRun = useRef("");
  useEffect(() => {
    if (!ready) return;
    const key = `${dialectId}\u0000${sql}`;
    if (key === lastRun.current) return;
    if (timer.current) window.clearTimeout(timer.current);
    // First paint after the engine is ready should feel instant; later edits
    // wait for the user to stop typing.
    const delay = lastRun.current === "" ? 0 : realtime ? 400 : 0;
    timer.current = window.setTimeout(() => {
      lastRun.current = key;
      void runAnalysis(sql, dialectId);
    }, delay);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [sql, dialectId, realtime, ready, runAnalysis]);

  const graphNodes = result?.graph.nodes ?? [];
  const columnEdges = result?.graph.columnEdges ?? [];

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

  const stats = result?.stats;

  // Changes whenever the parsed graph changes -> drives a re-fit of the viewport.
  const fitSignal = useMemo(() => {
    if (!result) return "";
    return [
      result.graph.nodes.map((n) => n.id).join("|"),
      result.graph.edges.map((e) => e.id).join("|"),
      result.statements.map((s) => s.status).join("|"),
      stats?.parseMs ?? 0,
    ].join("#");
  }, [result, stats]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand__mark">血</span>
          <div>
            <div className="brand__title">LineageLens</div>
            <div className="brand__sub">原型预览 · 调整样式后再落 VSCode</div>
          </div>
        </div>

        <div className="dialect-picker">
          <span className="dialect-picker__label">方言</span>
          {DIALECTS.map((d) => (
            <button
              key={d.id}
              className={`dialect-chip ${d.id === dialectId ? "is-active" : ""}`}
              onClick={() => setDialectId(d.id)}
              style={{ ["--chip" as string]: d.accent }}
              title={d.note}
            >
              {d.label}
            </button>
          ))}
          <button
            className="syntax-trigger"
            onClick={() => setShowSyntax(true)}
            title={`查看 ${dialectById(dialectId).label} 语法速查（含建表/写入/删除模板），可下载 .sql`}
          >
            语法速查 ↓
          </button>
        </div>

        <div className="topbar__status">
          <span className={`engine-dot engine-dot--${status}`} />
          <span className="engine-text">{detail}</span>
        </div>
      </header>

      <div className="body">
        <section className="editor-pane">
          <div className="pane-head">
            <span className="pane-title">SQL 输入</span>
            <div className="pane-actions">
              {SAMPLES.map((sample) => (
                <button
                  key={sample.id}
                  className="ghost-btn"
                  onClick={() => {
                    setResult(null);
                    setSql(sample.sql);
                    setDialectId(sample.dialectId);
                    setExpanded(new Set());
                    setFocusedId(null);
                  }}
                >
                  {sample.label}
                </button>
              ))}
            </div>
          </div>

          <textarea
            className="sql-input"
            value={sql}
            spellCheck={false}
            onChange={(event) => setSql(event.target.value)}
          />

          <div className="pane-foot">
            <label className="switch">
              <input
                type="checkbox"
                checked={realtime}
                onChange={(event) => setRealtime(event.target.checked)}
              />
              <span>实时分析</span>
            </label>
            <button className="primary-btn" onClick={() => void runAnalysis(sql, dialectId)}>
              重新解析
            </button>
            <span className="pane-foot__meta">
              {sql.split("\n").length} 行 · {sql.length} 字符
            </span>
          </div>
        </section>

        <section className="graph-pane">
          <div className="graph-toolbar">
            <div className="graph-toolbar__left">
              <span className="toolbar-title">血缘图</span>
              {stats && (
                <span className="stat-group">
                  <span className="stat">
                    <b>{stats.tableCount}</b> 表
                  </span>
                  <span className="stat">
                    <b>{stats.columnEdgeCount}</b> 列边
                  </span>
                  <span className="stat">
                    <b>{stats.parseMs}</b> ms
                  </span>
                </span>
              )}
            </div>
            <div className="graph-toolbar__right">
              <button
                className="ghost-btn"
                onClick={() =>
                  setExpanded((prev) =>
                    prev.size === graphNodes.length
                      ? new Set()
                      : new Set(graphNodes.map((n) => n.id)),
                  )
                }
              >
                {expanded.size === graphNodes.length && graphNodes.length > 0
                  ? "全部收起"
                  : "全部展开"}
              </button>
              {focusedId && (
                <button className="ghost-btn" onClick={() => setFocusedId(null)}>
                  清除聚焦
                </button>
              )}
              <button className="ghost-btn" onClick={() => setShowPanel((v) => !v)}>
                {showPanel ? "隐藏详情" : "显示详情"}
              </button>
            </div>
          </div>

          <div className="graph-canvas">
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
              onNodeClick={(_, node) => setFocusedId(node.id)}
              onPaneClick={() => setFocusedId(null)}
              fitView
              minZoom={0.2}
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

          {showPanel && (
            <div className="detail-panel">
              <div className="detail-panel__head">
                <span>语句</span>
                <span className="detail-panel__count">{result?.statements.length ?? 0} 条</span>
                {issueCount > 0 && (
                  <span className="detail-panel__issues">⚠ {issueCount} 个提示</span>
                )}
              </div>
              <ul className="stmt-list">
                {(result?.statements ?? []).map((statement) => {
                  const meta = STATUS_META[statement.status];
                  return (
                    <li
                      key={statement.index}
                      className={`stmt-item stmt-item--${statement.status}`}
                    >
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
                        {statement.target ?? "—"}
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
                      <span
                        className="legend__dot"
                        style={{ background: STATUS_META[key].color }}
                      />
                      {STATUS_META[key].label}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          )}
        </section>
      </div>

      <SyntaxSheet
        dialectId={dialectId}
        open={showSyntax}
        onClose={() => setShowSyntax(false)}
        onUseSnippet={(sql) => {
          setSql(sql);
          setResult(null);
          setExpanded(new Set());
          setFocusedId(null);
        }}
      />
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
