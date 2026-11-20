import { useState } from "react";
import { SourceInventory } from "../shared/types";

interface Props {
  inventory: SourceInventory | undefined;
  /** Jump to a table reference in the editor. */
  onRevealTable: (line: number, charRange?: { start: number; end: number } | null) => void;
  onCopy: (text: string) => void;
}

/**
 * Trigger button for the source-table drawer.
 *
 * Kept separate from the drawer so the caller can place it in a toolbar without
 * reserving layout space - the list is reference material, not something you
 * watch while editing.
 */
export function SourceInventoryTrigger({
  inventory,
  open,
  onToggle,
}: {
  inventory: SourceInventory | undefined;
  open: boolean;
  onToggle: () => void;
}) {
  const total = inventory?.totalTables ?? 0;
  const schemas = inventory?.schemaCount ?? 0;

  return (
    <button
      className={`ghost-btn inventory-trigger ${open ? "is-active" : ""}`}
      onClick={onToggle}
      title={
        total > 0
          ? `本文件依赖 ${total} 张源表，分布在 ${schemas} 个库`
          : "未识别到外部输入表"
      }
      disabled={total === 0}
    >
      源表 {total > 0 ? total : "—"}
      {schemas > 0 && <span className="inventory-trigger__schemas">/{schemas} 库</span>}
      <span className="inventory-trigger__chevron">{open ? "▴" : "▾"}</span>
    </button>
  );
}

export function SourceInventoryDrawer({ inventory, onRevealTable, onCopy, open, onClose }: Props & { open: boolean; onClose: () => void }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const groups = inventory?.groups ?? [];
  const total = inventory?.totalTables ?? 0;

  if (!open) return null;

  const copyAll = () => {
    const text = groups
      .map((g) => [`-- ${g.schema} (${g.count})`, ...g.tables.map((t) => t.fullName)].join("\n"))
      .join("\n\n");
    onCopy(text);
  };

  const toggle = (schema: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(schema)) next.delete(schema);
      else next.add(schema);
      return next;
    });
  };

  return (
    <div className="inventory-drawer">
      <div className="inventory-drawer__head">
        <span className="inventory-drawer__title">源表清单</span>
        <span className="inventory-drawer__summary">
          {total} 张表 · {groups.length} 个库
        </span>
        <div className="inventory-drawer__actions">
          <button className="ghost-btn" onClick={copyAll} title="复制为 SQL 注释">
            复制
          </button>
          <button className="ghost-btn" onClick={onClose} title="收起">
            收起
          </button>
        </div>
      </div>

      {total === 0 ? (
        <div className="inventory-drawer__empty">未识别到外部输入表</div>
      ) : (
        <div className="inventory-drawer__groups">
          {groups.map((group) => {
            const isCollapsed = collapsed.has(group.schema);
            return (
              <section key={group.schema} className="inventory__group">
                <button className="inventory__group-head" onClick={() => toggle(group.schema)}>
                  <span className="inventory__chevron">{isCollapsed ? "▸" : "▾"}</span>
                  <span
                    className={`inventory__schema ${group.isParameter ? "is-parameter" : ""}`}
                    title={group.isParameter ? "库名是模板参数，非真实库名" : group.schema}
                  >
                    {group.schema}
                  </span>
                  <span className="inventory__count">{group.count}</span>
                </button>

                {!isCollapsed && (
                  <ul className="inventory__tables">
                    {group.tables.map((table) => (
                      <li key={table.fullName} className="inventory__table">
                        <button
                          className="inventory__table-name"
                          onClick={() => {
                            if (typeof table.line === "number") {
                              onRevealTable(table.line, table.charRange);
                            }
                          }}
                          title={`${table.fullName}${
                            typeof table.line === "number" ? ` · 第 ${table.line} 行` : ""
                          }`}
                        >
                          {table.table}
                        </button>
                        {table.status !== "ok" && (
                          <span
                            className={`inventory__badge inventory__badge--${table.status}`}
                            title="该表所在语句未能完整解析"
                          >
                            {table.status === "failed" ? "失败" : "降级"}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
