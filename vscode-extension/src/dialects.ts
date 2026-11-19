import * as vscode from "vscode";

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

const HEADER_RE = /^\s*--\s*dialect\s*:\s*([\w-]+)/im;

/**
 * Resolves the dialect for a document with an explicit precedence chain:
 * per-document override -> file header -> workspace setting -> default.
 *
 * Deliberately no auto-detection: a wrong guess produces a confidently wrong
 * graph, which is worse than an explicit choice (see docs/详细方案设计.md §1.1).
 */
export function resolveDialect(
  document: vscode.TextDocument,
  overrides: Map<string, string>,
): { spec: DialectSpec; origin: "override" | "header" | "setting" } {
  const override = overrides.get(document.uri.toString());
  if (override) {
    return { spec: dialectById(override), origin: "override" };
  }

  const config = vscode.workspace.getConfiguration("sqlLineage");
  if (config.get<boolean>("detectFromFileHeader", true)) {
    const head = document.getText(
      new vscode.Range(0, 0, Math.min(document.lineCount - 1, 20), 0),
    );
    const match = HEADER_RE.exec(head);
    if (match) {
      const found = DIALECTS.find((d) => d.id === match[1].toLowerCase());
      if (found) return { spec: found, origin: "header" };
    }
  }

  return {
    spec: dialectById(config.get<string>("defaultDialect", "hive")),
    origin: "setting",
  };
}

export async function pickDialect(current: string): Promise<DialectSpec | undefined> {
  const items = DIALECTS.map((d) => ({
    label: d.id === current ? `$(check) ${d.label}` : `     ${d.label}`,
    description: d.note,
    detail: `sqlglot: ${d.sqlglotDialect}`,
    spec: d,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "选择当前文件的 SQL 方言（不会自动猜测）",
    matchOnDescription: true,
  });
  return picked?.spec;
}
