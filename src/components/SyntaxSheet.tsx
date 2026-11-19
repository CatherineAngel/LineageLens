import { useMemo, useState } from "react";
import { DialectSyntax, syntaxFor, renderCheatSheet } from "../syntaxSpec";

interface Props {
  dialectId: string;
  open: boolean;
  onClose: () => void;
  /** Load a snippet into the editor for immediate analysis. */
  onUseSnippet: (sql: string) => void;
}

/**
 * Dialect syntax reference.
 *
 * Lives next to the dialect switcher because the two questions are coupled:
 * "which dialect am I in?" and "what does that dialect accept?".
 */
export function SyntaxSheet({ dialectId, open, onClose, onUseSnippet }: Props) {
  const dialect: DialectSyntax = useMemo(() => syntaxFor(dialectId), [dialectId]);
  const [activeGroup, setActiveGroup] = useState(0);

  if (!open) return null;

  const group = dialect.groups[Math.min(activeGroup, dialect.groups.length - 1)];

  const download = () => {
    const body = renderCheatSheet(dialect);
    const blob = new Blob([body], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${dialect.dialectId}-syntax.sql`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="syntax-overlay" onClick={onClose}>
      <div className="syntax-sheet" onClick={(e) => e.stopPropagation()}>
        <header className="syntax-sheet__head">
          <div>
            <div className="syntax-sheet__title">{dialect.label} 语法速查</div>
            <div className="syntax-sheet__summary">{dialect.summary}</div>
          </div>
          <div className="syntax-sheet__actions">
            <button className="primary-btn" onClick={download}>
              下载 .sql
            </button>
            <button className="ghost-btn" onClick={onClose}>
              关闭
            </button>
          </div>
        </header>

        <div className="syntax-sheet__body">
          <nav className="syntax-tabs">
            {dialect.groups.map((g, index) => (
              <button
                key={g.title}
                className={`syntax-tab ${index === activeGroup ? "is-active" : ""}`}
                onClick={() => setActiveGroup(index)}
              >
                {g.title}
                <span className="syntax-tab__count">{g.templates.length}</span>
              </button>
            ))}
          </nav>

          <div className="syntax-list">
            {group.templates.map((template) => (
              <article key={template.title} className="syntax-card">
                <header className="syntax-card__head">
                  <span className="syntax-card__title">{template.title}</span>
                  {template.limited && (
                    <span className="syntax-card__badge" title="引擎只能部分分析">
                      部分支持
                    </span>
                  )}
                  <button
                    className="ghost-btn syntax-card__use"
                    onClick={() => {
                      onUseSnippet(template.sql);
                      onClose();
                    }}
                  >
                    填入编辑器
                  </button>
                </header>
                {template.note && <div className="syntax-card__note">{template.note}</div>}
                <pre className="syntax-card__code">{template.sql}</pre>
              </article>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
