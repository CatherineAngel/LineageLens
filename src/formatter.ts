/**
 * SQL formatting, backed by sql-formatter.
 *
 * sql-formatter is a whitespace formatter: it never rewrites tokens, so
 * `${Schema}` templates, comments and string literals survive untouched. That is
 * why it is used instead of sqlglot's `pretty=True`, which relocated comments
 * and rewrote `'has''quote'` into `CONCAT(...)`.
 */
import { format } from "sql-formatter";
import {
  expandCreateColumns,
  joinInsertTarget,
  leadingCommas,
  normalizeSchemaCase,
  semicolonOnOwnLine,
} from "./formatterTransforms";

export type KeywordCase = "preserve" | "upper" | "lower";

export interface FormatOptions {
  /** Indentation width in spaces (ignored when useTabs is on). */
  tabWidth: number;
  useTabs: boolean;
  keywordCase: KeywordCase;
  functionCase: KeywordCase;
  dataTypeCase: KeywordCase;
  /** Case for the schema part of `schema.table`; `${...}` templates are skipped. */
  schemaCase: KeywordCase;
  /** Place AND/OR before the line break or after it. */
  logicalOperatorNewline: "before" | "after";
  /** Max characters of a parenthesised expression kept on one line. */
  expressionWidth: number;
  /** Blank lines between statements in a multi-statement file. */
  linesBetweenQueries: number;
  denseOperators: boolean;
  /** Keep `INSERT INTO table` on one line instead of breaking after INTO. */
  joinInsertTarget: boolean;
  /** Put list commas at the start of the next line. */
  leadingCommas: boolean;
  /** Force CREATE TABLE column lists onto separate lines. */
  expandCreateColumns: boolean;
  /** Put the trailing semicolon on its own line. */
  semicolonOnOwnLine: boolean;
}

export const DEFAULT_FORMAT_OPTIONS: FormatOptions = {
  tabWidth: 4,
  useTabs: false,
  keywordCase: "upper",
  functionCase: "upper",
  dataTypeCase: "upper",
  schemaCase: "upper",
  logicalOperatorNewline: "before",
  expressionWidth: 50,
  linesBetweenQueries: 2,
  denseOperators: false,
  joinInsertTarget: true,
  leadingCommas: true,
  expandCreateColumns: true,
  semicolonOnOwnLine: true,
};

/** Dialect ids (our own) -> sql-formatter language. */
export const FORMAT_LANGUAGE = {
  hive: "hive",
  gaussdb: "postgresql",
  "oceanbase-mysql": "mysql",
  "oceanbase-oracle": "plsql",
  goldendb: "mysql",
  mysql: "mysql",
} as const;

export type FormatLanguage = (typeof FORMAT_LANGUAGE)[keyof typeof FORMAT_LANGUAGE];

export interface FormatOutcome {
  ok: boolean;
  sql: string;
  /** Human-readable reason when the input could not be parsed. */
  error?: string;
}

/**
 * Format one or more statements.
 *
 * `format()` throws on syntax it does not understand, so failures are surfaced
 * as data instead of exceptions - the caller must be able to show the original
 * text untouched.
 */
export function formatSql(
  sql: string,
  dialectId: string,
  options: Partial<FormatOptions> = {},
): FormatOutcome {
  const language: FormatLanguage =
    FORMAT_LANGUAGE[dialectId as keyof typeof FORMAT_LANGUAGE] ?? "sql";
  const merged = { ...DEFAULT_FORMAT_OPTIONS, ...options };

  try {
    let formatted = format(sql, {
      language,
      tabWidth: merged.tabWidth,
      useTabs: merged.useTabs,
      keywordCase: merged.keywordCase,
      functionCase: merged.functionCase,
      dataTypeCase: merged.dataTypeCase,
      logicalOperatorNewline: merged.logicalOperatorNewline,
      expressionWidth: merged.expressionWidth,
      linesBetweenQueries: merged.linesBetweenQueries,
      denseOperators: merged.denseOperators,
    });

    // Ordered on purpose: the INSERT join runs first so a following
    // leading-comma pass sees a stable line structure; the DDL pass adds new
    // lines that the comma pass must then be able to reformat.
    if (merged.joinInsertTarget) formatted = joinInsertTarget(formatted);
    if (merged.expandCreateColumns) formatted = expandCreateColumns(formatted);
    if (merged.leadingCommas) formatted = leadingCommas(formatted);
    if (merged.schemaCase !== "preserve") {
      formatted = normalizeSchemaCase(formatted, merged.schemaCase);
    }
    if (merged.semicolonOnOwnLine) formatted = semicolonOnOwnLine(formatted);

    return { ok: true, sql: formatted };
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    return { ok: false, sql, error: message.split("\n")[0] };
  }
}
