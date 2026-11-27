import { useMemo, useState } from "react";
import {
  DEFAULT_FORMAT_OPTIONS,
  FormatOptions,
  KeywordCase,
  formatSql,
} from "../formatter";

interface Props {
  sql: string;
  dialectId: string;
  dialectLabel: string;
  open: boolean;
  onClose: () => void;
  /** Replace the editor content with the formatted SQL. */
  onApply: (sql: string) => void;
}

const CASE_OPTIONS: { value: KeywordCase; label: string }[] = [
  { value: "preserve", label: "保持原样" },
  { value: "upper", label: "大写" },
  { value: "lower", label: "小写" },
];

function CaseSelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value: KeywordCase;
  onChange: (value: KeywordCase) => void;
}) {
  return (
    <label className="fmt-field">
      <span className="fmt-field__label">{label}</span>
      <select
        className="fmt-select"
        value={value}
        onChange={(event) => onChange(event.target.value as KeywordCase)}
      >
        {CASE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Side-by-side SQL formatter.
 *
 * Formatting is recomputed on every option change so the effect of each setting
 * is visible immediately - that is the whole point of exposing them.
 */
export function FormatterPanel({
  sql,
  dialectId,
  dialectLabel,
  open,
  onClose,
  onApply,
}: Props) {
  const [options, setOptions] = useState<FormatOptions>(DEFAULT_FORMAT_OPTIONS);
  const [copied, setCopied] = useState(false);

  const outcome = useMemo(
    () => formatSql(sql, dialectId, options),
    [sql, dialectId, options],
  );

  if (!open) return null;

  const patch = <K extends keyof FormatOptions>(key: K, value: FormatOptions[K]) =>
    setOptions((prev) => ({ ...prev, [key]: value }));

  const copy = () => {
    void navigator.clipboard?.writeText(outcome.sql);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const beforeLines = sql.split("\n").length;
  const afterLines = outcome.sql.split("\n").length;

  return (
    <div className="fmt-overlay" onClick={onClose}>
      <div className="fmt-panel" onClick={(event) => event.stopPropagation()}>
        <header className="fmt-panel__head">
          <div>
            <div className="fmt-panel__title">SQL 格式化</div>
            <div className="fmt-panel__sub">
              {dialectLabel} · sql-formatter · {beforeLines} 行 → {afterLines} 行
            </div>
          </div>
          <div className="fmt-panel__actions">
            <button className="ghost-btn" onClick={() => setOptions(DEFAULT_FORMAT_OPTIONS)}>
              重置
            </button>
            <button className="ghost-btn" onClick={copy} disabled={!outcome.ok}>
              {copied ? "已复制" : "复制"}
            </button>
            <button
              className="primary-btn"
              onClick={() => {
                onApply(outcome.sql);
                onClose();
              }}
              disabled={!outcome.ok}
            >
              应用到编辑器
            </button>
            <button className="ghost-btn" onClick={onClose}>
              关闭
            </button>
          </div>
        </header>

        {!outcome.ok && (
          <div className="fmt-error">
            <span className="fmt-error__badge">无法格式化</span>
            <span className="fmt-error__text">{outcome.error}</span>
            <span className="fmt-error__hint">
              该方言可能包含 sql-formatter 不认识的语法，原文保持不变。
            </span>
          </div>
        )}

        <div className="fmt-panel__body">
          <div className="fmt-options">
            <div className="fmt-options__group">
              <div className="fmt-options__title">缩进</div>
              <label className="fmt-field">
                <span className="fmt-field__label">空格数</span>
                <input
                  className="fmt-input"
                  type="number"
                  min={1}
                  max={8}
                  value={options.tabWidth}
                  onChange={(event) => patch("tabWidth", Number(event.target.value) || 2)}
                />
              </label>
              <label className="fmt-field fmt-field--switch">
                <input
                  type="checkbox"
                  checked={options.useTabs}
                  onChange={(event) => patch("useTabs", event.target.checked)}
                />
                <span>使用 Tab</span>
              </label>
            </div>

            <div className="fmt-options__group">
              <div className="fmt-options__title">大小写</div>
              <CaseSelect
                label="关键字"
                value={options.keywordCase}
                onChange={(value) => patch("keywordCase", value)}
              />
              <CaseSelect
                label="函数名"
                value={options.functionCase}
                onChange={(value) => patch("functionCase", value)}
              />
              <CaseSelect
                label="数据类型"
                value={options.dataTypeCase}
                onChange={(value) => patch("dataTypeCase", value)}
              />
              <CaseSelect
                label="库名"
                value={options.schemaCase}
                onChange={(value) => patch("schemaCase", value)}
              />
            </div>

            <div className="fmt-options__group">
              <div className="fmt-options__title">换行</div>
              <label className="fmt-field">
                <span className="fmt-field__label">AND/OR 位置</span>
                <select
                  className="fmt-select"
                  value={options.logicalOperatorNewline}
                  onChange={(event) =>
                    patch("logicalOperatorNewline", event.target.value as "before" | "after")
                  }
                >
                  <option value="before">行首</option>
                  <option value="after">行尾</option>
                </select>
              </label>
              <label className="fmt-field">
                <span className="fmt-field__label">表达式宽度</span>
                <input
                  className="fmt-input"
                  type="number"
                  min={0}
                  max={200}
                  value={options.expressionWidth}
                  onChange={(event) =>
                    patch("expressionWidth", Number(event.target.value) || 0)
                  }
                />
              </label>
              <label className="fmt-field">
                <span className="fmt-field__label">语句间空行</span>
                <input
                  className="fmt-input"
                  type="number"
                  min={0}
                  max={5}
                  value={options.linesBetweenQueries}
                  onChange={(event) =>
                    patch("linesBetweenQueries", Number(event.target.value) || 0)
                  }
                />
              </label>
            </div>

            <div className="fmt-options__group">
              <div className="fmt-options__title">结构</div>
              <label className="fmt-field fmt-field--switch">
                <input
                  type="checkbox"
                  checked={options.joinInsertTarget}
                  onChange={(event) => patch("joinInsertTarget", event.target.checked)}
                />
                <span>INSERT INTO 后紧接表名</span>
              </label>
              <label className="fmt-field fmt-field--switch">
                <input
                  type="checkbox"
                  checked={options.leadingCommas}
                  onChange={(event) => patch("leadingCommas", event.target.checked)}
                />
                <span>逗号在行首</span>
              </label>
              <label className="fmt-field fmt-field--switch">
                <input
                  type="checkbox"
                  checked={options.expandCreateColumns}
                  onChange={(event) => patch("expandCreateColumns", event.target.checked)}
                />
                <span>建表字段分行</span>
              </label>
              <label className="fmt-field fmt-field--switch">
                <input
                  type="checkbox"
                  checked={options.semicolonOnOwnLine}
                  onChange={(event) => patch("semicolonOnOwnLine", event.target.checked)}
                />
                <span>分号单独成行</span>
              </label>
              <label className="fmt-field fmt-field--switch">
                <input
                  type="checkbox"
                  checked={options.denseOperators}
                  onChange={(event) => patch("denseOperators", event.target.checked)}
                />
                <span>紧凑运算符（a=1）</span>
              </label>
            </div>
          </div>

          <div className="fmt-preview">
            <div className="fmt-preview__side">
              <div className="fmt-preview__label">原文</div>
              <pre className="fmt-preview__code">{sql || "（编辑器内容为空）"}</pre>
            </div>
            <div className="fmt-preview__side">
              <div className="fmt-preview__label">格式化后</div>
              <pre className="fmt-preview__code fmt-preview__code--result">
                {outcome.sql || "（无内容）"}
              </pre>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
