import { useState } from "react";
import { SourceInventory } from "../shared/types";

interface Props {
  inventory: SourceInventory | undefined;
  /** Jump to a table reference in the editor. */
  onRevealTable: (line: number, charRange?: { start: number; end: number } | null) => void;
  onCopy: (text: string) => void;
}

/**
 * Compact summary of the external tables this file reads.
 *
 * Intermediates produced by the same file are excluded upstream, so this is the
 * "what do I depend on" list rather than "everything mentioned".
 */
export function SourceInventoryPanel({ inventory, onRevealTable, onCopy }: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const groups = inventory?.groups ?? [];
  const total = inventory?.totalTables ?? 0;

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

  if (total === 0) {
    return (
      <div className="inventory inventory--empty">
        <span className="inventory__title">源表清单</span>
        <span className="inventory__hint">未识别到外部输入表</span>
      </div>
    );
  }

  return (
    <div className="inventory">
      <div className="inventory__head">
        <span className="inventory__title">源表清单</span>
        <span className="inventory__summary">
          {total} 张表 · {groups.length} 个库
        </span>
        <div className="inventory__actions">
          <button className="ghost-btn" onClick={copyAll} title="复制为 SQL 注释">
            复制
          </button>
        </div>
      </div>

      <div className="inventory__groups">
        {groups.map((group) => {
          const isCollapsed = collapsed.has(group.schema);
          return (
            <section key={group.schema} className="inventory__group">
              <button className="inventory__group-head" onClick={() => toggle(group.schema)}>
                <span className="inventory__chevron">{isCollapsed ? "▸" : "▾"}</span>
                <span
                  className={`inventory__schema ${
                    group.isParameter ? "is-parameter" : ""
                  }`}
                  title={group.isParameter ? "库名是模板参数" : group.schema}
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
    </div>
  );
}

/** Export helper so callers do not have to re-derive the flat list. */
export function inventoryNames(inventory: SourceInventory | undefined): string[] {
  if (!inventory) return [];
  return inventory.groups.flatMap((g) => g.tables.map((t) => t.fullName));
}
