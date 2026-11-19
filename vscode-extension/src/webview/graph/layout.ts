import dagre from "@dagrejs/dagre";
import {
  Edge,
  Node,
  Position,
} from "@xyflow/react";
import {
  ColumnEdge,
  GraphEdge,
  GraphNode,
  ParseStatus,
  STATUS_META,
  TRANSFORM_META,
  TransformType,
} from "../shared/types";

export const TABLE_WIDTH = 260;
/** Measured heights of the chrome around the column list (see styles.css). */
export const HEADER_HEIGHT = 42;
export const FOOTER_HEIGHT = 26;
export const COLUMN_ROW_HEIGHT = 22;
export const COLUMN_PADDING = 10;

export interface ColumnRow {
  name: string;
  direction: "source" | "target" | "both";
  transform: TransformType;
  expression?: string | null;
  peers: string[];
}

export interface TableNodeData extends Record<string, unknown> {
  node: GraphNode;
  columns: ColumnRow[];
  expanded: boolean;
  focused: boolean;
  dimmed: boolean;
  estimatedHeight: number;
  onToggle: (id: string) => void;
}

export type LineageNode = Node<TableNodeData, "table">;

function nodeHeight(columnCount: number, expanded: boolean) {
  if (!expanded || columnCount === 0) return HEADER_HEIGHT + FOOTER_HEIGHT;
  return (
    HEADER_HEIGHT +
    FOOTER_HEIGHT +
    COLUMN_PADDING * 2 +
    columnCount * COLUMN_ROW_HEIGHT
  );
}

export function buildNodes(
  graphNodes: GraphNode[],
  columnEdges: ColumnEdge[],
  expanded: Set<string>,
  focusedId: string | null,
  onToggle: (id: string) => void,
): LineageNode[] {
  const neighbors = neighborSet(graphNodes, columnEdges, focusedId);

  return graphNodes.map((node) => {
    const columns = collectColumns(node.id, columnEdges);
    const focused = focusedId === node.id;
    const expandedHere = expanded.has(node.id);
    return {
      id: node.id,
      type: "table",
      position: { x: 0, y: 0 },
      data: {
        node,
        columns,
        expanded: expandedHere,
        focused,
        dimmed: focusedId !== null && !focused && !neighbors.has(node.id),
        estimatedHeight: nodeHeight(columns.length, expandedHere),
        onToggle,
      },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
    } satisfies LineageNode;
  });
}

/** A node shows columns it produces (target side) and columns it feeds (source side). */
function collectColumns(nodeId: string, columnEdges: ColumnEdge[]): ColumnRow[] {
  const rows = new Map<string, ColumnRow>();

  const upsert = (
    name: string,
    direction: "source" | "target",
    transform: TransformType,
    expression: string | null | undefined,
    peer: string,
  ) => {
    const existing = rows.get(name);
    if (!existing) {
      rows.set(name, {
        name,
        direction,
        transform,
        expression,
        peers: [peer],
      });
      return;
    }
    if (existing.direction !== direction) existing.direction = "both";
    if (peer && !existing.peers.includes(peer)) existing.peers.push(peer);
    if (!existing.expression && expression) existing.expression = expression;
  };

  for (const edge of columnEdges) {
    if (edge.targetTable === nodeId) {
      upsert(
        edge.targetColumn,
        "target",
        edge.transform,
        edge.expression,
        `${edge.sourceTable}.${edge.sourceColumn}`,
      );
    }
    if (edge.sourceTable === nodeId) {
      upsert(edge.sourceColumn, "source", edge.transform, null, edge.targetColumn);
    }
  }

  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function neighborSet(
  graphNodes: GraphNode[],
  columnEdges: ColumnEdge[],
  focusedId: string | null,
): Set<string> {
  if (!focusedId) return new Set(graphNodes.map((n) => n.id));
  const set = new Set<string>([focusedId]);
  for (const edge of columnEdges) {
    if (edge.targetTable === focusedId) set.add(edge.sourceTable);
    if (edge.sourceTable === focusedId) set.add(edge.targetTable);
  }
  return set;
}

export function buildEdges(
  graphEdges: GraphEdge[],
  columnEdges: ColumnEdge[],
  focusedId: string | null,
  expanded: Set<string>,
): Edge[] {
  const edges: Edge[] = [];
  const connections = new Map<string, ColumnEdge[]>();

  for (const edge of columnEdges) {
    const key = `${edge.sourceTable}->${edge.targetTable}`;
    const list = connections.get(key) ?? [];
    list.push(edge);
    connections.set(key, list);
  }

  for (const edge of graphEdges) {
    const key = `${edge.source}->${edge.target}`;
    const colEdges = connections.get(key) ?? [];
    const transforms = new Set(colEdges.map((c) => c.transform));
    const dominant = pickDominantTransform(transforms);
    const meta = TRANSFORM_META[dominant];

    const related = colEdges.length > 0;
    const isFocused =
      focusedId === null || edge.source === focusedId || edge.target === focusedId;

    // Both ends expanded -> route individual column-to-column edges instead of
    // one table-level edge, so the graph reads like a real data flow.
    const drillDown =
      expanded.has(edge.source) && expanded.has(edge.target) && colEdges.length > 0;

    if (drillDown) {
      for (const colEdge of colEdges) {
        const colMeta = TRANSFORM_META[colEdge.transform];
        edges.push({
          id: `${colEdge.sourceTable}.${colEdge.sourceColumn}->${colEdge.targetTable}.${colEdge.targetColumn}`,
          source: colEdge.sourceTable,
          sourceHandle: columnHandleId("source", colEdge.sourceColumn),
          target: colEdge.targetTable,
          targetHandle: columnHandleId("target", colEdge.targetColumn),
          type: "smoothstep",
          animated: focusedId !== null && isFocused,
          style: {
            stroke: colMeta.color,
            strokeWidth: 2,
            strokeDasharray: colMeta.dash,
            opacity: isFocused ? 1 : 0.24,
          },
          data: { columns: 1, status: edge.status, column: colEdge },
        });
      }
      continue;
    }

    edges.push({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: "smoothstep",
      animated: focusedId !== null && isFocused,
      style: {
        stroke: meta.color,
        strokeWidth: focusedId !== null && isFocused ? 2.6 : 1.8,
        strokeDasharray: meta.dash,
        opacity: isFocused ? 1 : 0.24,
      },
      label: related ? undefined : "表级",
      labelStyle: { fontSize: 10, fill: "#94a3b8" },
      labelShowBg: true,
      labelBgStyle: { fill: "#0b1220", opacity: 0.9 },
      labelBgPadding: [4, 2] as [number, number],
      data: { columns: colEdges.length, status: edge.status },
    });
  }

  return edges;
}

export function columnHandleId(side: "source" | "target", column: string) {
  return `${side}:${column}`;
}

function pickDominantTransform(transforms: Set<string>): keyof typeof TRANSFORM_META {
  if (transforms.has("aggregate")) return "aggregate";
  if (transforms.has("function")) return "function";
  if (transforms.has("case")) return "case";
  return "direct";
}

export function layout(nodes: LineageNode[], edges: Edge[]): LineageNode[] {
  const graph = new dagre.graphlib.Graph({ multigraph: true });
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({
    rankdir: "LR",
    nodesep: 28,
    ranksep: 96,
    edgesep: 16,
    marginx: 24,
    marginy: 24,
  });

  for (const node of nodes) {
    graph.setNode(node.id, {
      width: TABLE_WIDTH,
      height: node.data.estimatedHeight,
    });
  }

  for (const edge of edges) {
    graph.setEdge(edge.source, edge.target);
  }

  dagre.layout(graph);

  return nodes.map((node) => {
    const positioned = graph.node(node.id);
    const height = node.data.estimatedHeight;
    return {
      ...node,
      position: {
        x: positioned.x - TABLE_WIDTH / 2,
        y: positioned.y - height / 2,
      },
    };
  });
}

export function statusColor(status: ParseStatus) {
  return STATUS_META[status]?.color ?? "#64748b";
}
