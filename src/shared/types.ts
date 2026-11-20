export type ParseStatus = "ok" | "degraded" | "unsupported" | "failed";

export interface SourceRange {
  start: number;
  end: number;
  line?: number;
  col?: number;
}

export interface SourceTable {
  name: string;
  db: string;
  table: string;
  alias: string;
  range?: SourceRange;
}

export interface ColumnEdge {
  sourceTable: string;
  sourceColumn: string;
  targetTable: string;
  targetColumn: string;
  transform: TransformType;
  expression?: string | null;
}

export type TransformType = "direct" | "aggregate" | "function" | "case";

export interface OutputColumn {
  name: string;
  expression?: string | null;
  transform: TransformType;
  edges: ColumnEdge[];
}

export interface StatementSlice {
  index: number;
  start: number;
  end: number;
  startLine: number;
  text?: string;
}

export interface StatementResult {
  index: number;
  slice: StatementSlice;
  kind: string;
  status: ParseStatus;
  target: string | null;
  sources: SourceTable[];
  edges: { source: string; target: string; kind: string }[];
  columns: OutputColumn[];
  warnings: string[];
  /** Lossless rewrites (parameter masking, dialect syntax stripping). */
  notes?: string[];
}

export interface GraphNode {
  id: string;
  label: string;
  db: string;
  table: string;
  roles: ("source" | "target")[];
  status: ParseStatus;
  statements: number[];
  /** True for synthetic nodes such as the result set of a bare SELECT. */
  synthetic?: boolean;
  /** 1-based line to reveal in the editor when this node is clicked. */
  line?: number | null;
  /** UTF-16 character offsets within that line, for precise placement. */
  charRange?: { start: number; end: number } | null;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: string;
  statements: number[];
  status: ParseStatus;
}

export interface Stats {
  parseMs: number;
  statementCount: number;
  failedCount: number;
  degradedCount: number;
  tableCount: number;
  edgeCount: number;
  columnEdgeCount: number;
  /** End-to-end time measured by the extension host. */
  wallMs?: number;
}

export interface AnalyzeResult {
  ok: boolean;
  error?: string;
  statements: StatementResult[];
  graph: {
    nodes: GraphNode[];
    edges: GraphEdge[];
    columnEdges: ColumnEdge[];
    /** External input tables of this file, grouped by schema. */
    sourceInventory?: SourceInventory;
  };
  stats: Stats;
}

export interface SourceTableRef {
  table: string;
  /** Schema-qualified name as written, e.g. `${Schema}.ods_order`. */
  fullName: string;
  status: ParseStatus;
  line?: number | null;
  charRange?: { start: number; end: number } | null;
  statements: number[];
}

export interface SourceSchemaGroup {
  /** Schema exactly as written in SQL, including `${Schema}` templates. */
  schema: string;
  /** True when the schema is a template parameter rather than a real name. */
  isParameter: boolean;
  count: number;
  tables: SourceTableRef[];
}

export interface SourceInventory {
  groups: SourceSchemaGroup[];
  totalTables: number;
  schemaCount: number;
}

export interface DialectSpec {
  id: string;
  label: string;
  sqlglotDialect: string;
  note: string;
  accent: string;
}

export const DIALECTS: DialectSpec[] = [
  {
    id: "hive",
    label: "Hive SQL",
    sqlglotDialect: "hive",
    note: "原生支持，无预处理",
    accent: "#f59e0b",
  },
  {
    id: "gaussdb",
    label: "GaussDB (DWS)",
    sqlglotDialect: "postgres",
    note: "剥离 DISTRIBUTE BY",
    accent: "#3b82f6",
  },
  {
    id: "oceanbase-mysql",
    label: "OceanBase · MySQL",
    sqlglotDialect: "mysql",
    note: "改写 REPLACE INTO",
    accent: "#10b981",
  },
  {
    id: "oceanbase-oracle",
    label: "OceanBase · Oracle",
    sqlglotDialect: "oracle",
    note: "跳过 PL/SQL 块",
    accent: "#ef4444",
  },
  {
    id: "goldendb",
    label: "GoldenDB",
    sqlglotDialect: "mysql",
    note: "MySQL 兼容",
    accent: "#8b5cf6",
  },
  {
    id: "mysql",
    label: "MySQL",
    sqlglotDialect: "mysql",
    note: "改写 REPLACE INTO",
    accent: "#06b6d4",
  },
];

export function dialectById(id: string): DialectSpec {
  return DIALECTS.find((d) => d.id === id) ?? DIALECTS[0];
}

export const STATUS_META: Record<ParseStatus, { label: string; color: string; hint: string }> = {
  ok: { label: "正常", color: "#10b981", hint: "AST 完整，血缘可信" },
  degraded: { label: "降级", color: "#f59e0b", hint: "已做预处理或正则兜底，信息可能不完整" },
  unsupported: { label: "不支持", color: "#94a3b8", hint: "该语句类型无法做静态分析" },
  failed: { label: "失败", color: "#ef4444", hint: "无法解析" },
};

export const TRANSFORM_META: Record<TransformType, { label: string; color: string; dash?: string }> = {
  direct: { label: "直接映射", color: "#64748b" },
  aggregate: { label: "聚合", color: "#8b5cf6" },
  function: { label: "函数", color: "#0ea5e9", dash: "6 3" },
  case: { label: "条件", color: "#f59e0b", dash: "2 3" },
};
