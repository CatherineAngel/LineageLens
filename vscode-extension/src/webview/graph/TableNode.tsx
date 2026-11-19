import { Handle, Position, NodeProps } from "@xyflow/react";
import { memo, useState } from "react";
import { columnHandleId, ColumnRow, LineageNode } from "../graph/layout";
import { STATUS_META, TRANSFORM_META } from "../shared/types";

const LAYER_COLORS: Record<string, string> = {
  ods: "#3b82f6",
  dwd: "#8b5cf6",
  dws: "#ec4899",
  ads: "#10b981",
  dim: "#f59e0b",
};

function layerOf(table: string): string | null {
  const prefix = table.split("_")[0]?.toLowerCase();
  if (prefix && prefix in LAYER_COLORS) return prefix;
  return null;
}

const DIRECTION_LABEL: Record<ColumnRow["direction"], string> = {
  source: "上游",
  target: "产出",
  both: "贯通",
};

function TableNodeComponent({ data }: NodeProps<LineageNode>) {
  const { node, columns, expanded, focused, dimmed, onToggle } = data;
  const [hoverColumn, setHoverColumn] = useState<string | null>(null);

  const layer = layerOf(node.table);
  const accent = layer ? LAYER_COLORS[layer] : "#64748b";
  const status = STATUS_META[node.status];
  const isTarget = node.roles.includes("target");
  const isSource = node.roles.includes("source");

  return (
    <div
      className={[
        "table-node",
        focused ? "is-focused" : "",
        dimmed ? "is-dimmed" : "",
        expanded ? "is-expanded" : "",
        node.synthetic ? "is-synthetic" : "",
        `status-${node.status}`,
      ].join(" ")}
      style={{ ["--accent" as string]: accent }}
    >
      {/* Table-level handles stay mounted even when expanded (anchored to the
          header) so edges to/from a collapsed neighbour always have a target. */}
      <Handle
        type="target"
        position={Position.Left}
        className="handle handle--table"
        style={expanded ? { top: 21 } : undefined}
      />
      <Handle
        type="source"
        position={Position.Right}
        className="handle handle--table"
        style={expanded ? { top: 21 } : undefined}
      />

      <button className="table-node__header" onClick={() => onToggle(node.id)}>
        <span className="table-node__bar" style={{ background: accent }} />
        <span className="table-node__names">
          <span className="table-node__db">
            {node.synthetic ? "结果集" : node.db || "default"}
          </span>
          <span className="table-node__table">{node.table}</span>
        </span>
        <span className="table-node__badges">
          {columns.length > 0 && <span className="badge badge--cols">{columns.length}</span>}
          <span
            className="badge badge--status"
            style={{ color: status.color, borderColor: status.color }}
          >
            {status.label}
          </span>
          <span className="table-node__chevron">{expanded ? "▾" : "▸"}</span>
        </span>
      </button>

      {expanded && columns.length > 0 && (
        <ul className="table-node__columns">
          {columns.map((column) => {
            const meta = TRANSFORM_META[column.transform];
            const showTarget = column.direction !== "source";
            const showSource = column.direction !== "target";
            return (
              <li
                key={column.name}
                className="column-row"
                onMouseEnter={() => setHoverColumn(column.name)}
                onMouseLeave={() => setHoverColumn(null)}
              >
                {showTarget && (
                  <Handle
                    id={columnHandleId("target", column.name)}
                    type="target"
                    position={Position.Left}
                    className="column-handle column-handle--target"
                  />
                )}
                <span className="column-row__dot" style={{ background: meta.color }} />
                <span className="column-row__name">{column.name}</span>
                <span className={`column-row__dir column-row__dir--${column.direction}`}>
                  {DIRECTION_LABEL[column.direction]}
                </span>
                {showSource && (
                  <Handle
                    id={columnHandleId("source", column.name)}
                    type="source"
                    position={Position.Right}
                    className="column-handle column-handle--source"
                  />
                )}
                {hoverColumn === column.name && (
                  <div className="column-tooltip">
                    <div>
                      <span className="muted">变换：</span>
                      {meta.label}
                    </div>
                    {column.expression && (
                      <div>
                        <span className="muted">表达式：</span>
                        {column.expression}
                      </div>
                    )}
                    {column.peers.length > 0 && (
                      <div>
                        <span className="muted">关联：</span>
                        {column.peers.join(", ")}
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="table-node__footer">
        {isSource && <span className="role role--source">源</span>}
        {isTarget && <span className="role role--target">目标</span>}
        {node.statements.length > 0 && (
          <span className="role role--stmt">
            #{node.statements.map((s) => s + 1).join(",")}
          </span>
        )}
        <span className="role role--cols-count">
          {columns.length > 0 ? `${columns.length} 列` : "无列信息"}
        </span>
      </div>
    </div>
  );
}

export const TableNode = memo(TableNodeComponent);
