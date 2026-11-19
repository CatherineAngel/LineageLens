import * as vscode from "vscode";
import { EngineClient } from "./engineClient";
import { LineagePanel } from "./lineagePanel";
import { pickDialect, resolveDialect } from "./dialects";
import type { AnalyzeResult } from "./webview/shared/types";

const SELECTOR_LANGUAGES = new Set(["sql", "hive-sql", "mysql"]);

let engine: EngineClient;
let statusBar: vscode.StatusBarItem;
let context: vscode.ExtensionContext;
let realtimeEnabled = true;
let debounceTimer: NodeJS.Timeout | undefined;
let analysisSeq = 0;

/** Per-document dialect overrides chosen through the picker. */
const dialectOverrides = new Map<string, string>();

/**
 * The panel takes focus when clicked, which clears `activeTextEditor`. Track the
 * last SQL editor so "reveal node" and status bar keep working from the panel.
 */
let lastSqlEditor: vscode.TextEditor | undefined;

function activeSqlEditor(): vscode.TextEditor | undefined {
  const current = vscode.window.activeTextEditor;
  if (current && isSqlDocument(current.document)) {
    lastSqlEditor = current;
    return current;
  }
  // Fall back to the tracked editor if its document is still open.
  const tracked = lastSqlEditor;
  if (tracked && !tracked.document.isClosed) return tracked;
  return undefined;
}

export function activate(extensionContext: vscode.ExtensionContext) {
  context = extensionContext;
  realtimeEnabled = vscode.workspace.getConfiguration("sqlLineage").get<boolean>("realtime", true);

  engine = new EngineClient(
    context.extensionPath,
    "dist/engineWorker.js",
    "sqlglot-30.33.0-py3-none-any.whl",
  );

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = "sqlLineage.showGraph";
  context.subscriptions.push(statusBar);

  engine.onStatus((status) => {
    updateStatusBar();
    const panel = ensurePanel();
    panel.sendStatus(status.detail, status.state === "idle" ? "loading" : status.state);
    if (status.state === "error") {
      void vscode.window.showErrorMessage(`SQL 血缘引擎: ${status.detail}`);
    }
  });

  context.subscriptions.push(
    vscode.commands.registerCommand("sqlLineage.selectDialect", () => chooseDialect()),
    vscode.commands.registerCommand("sqlLineage.showGraph", () => analyzeActiveEditor()),
    vscode.commands.registerCommand("sqlLineage.analyzeSelection", () => analyzeSelection()),
    vscode.commands.registerCommand("sqlLineage.toggleRealtime", toggleRealtime),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (!realtimeEnabled || event.contentChanges.length === 0) return;
      if (!isSqlDocument(event.document)) return;
      scheduleAnalysis(event.document);
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      updateStatusBar();
      if (editor && isSqlDocument(editor.document)) scheduleAnalysis(editor.document, 150);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("sqlLineage.realtime")) {
        realtimeEnabled = vscode.workspace
          .getConfiguration("sqlLineage")
          .get<boolean>("realtime", true);
        updateStatusBar();
      }
    }),
  );

  // Warm Pyodide during activation: cold start ~0.7s should never be paid on
  // the user's first request for a graph.
  engine.start();

  const active = vscode.window.activeTextEditor;
  if (active && isSqlDocument(active.document)) {
    lastSqlEditor = active;
    scheduleAnalysis(active.document, 300);
  }
}

export function deactivate() {
  if (debounceTimer) clearTimeout(debounceTimer);
  engine?.dispose();
  LineagePanel.disposeCurrent();
}

// ---------------------------------------------------------------- panel

function ensurePanel(): LineagePanel {
  return LineagePanel.show(context, {
    onReveal: revealLine,
    onPickDialect: () => void chooseDialect(),
    onRefresh: () => void analyzeActiveEditor(),
    onCopy: copyNodeName,
  });
}

// ---------------------------------------------------------------- commands

async function analyzeActiveEditor(): Promise<void> {
  const editor = activeSqlEditor();
  if (!editor) {
    void vscode.window.showInformationMessage("请先打开一个 SQL 文件");
    return;
  }
  if (editor.document.isClosed) {
    void vscode.window.showInformationMessage("原文件已关闭，请重新打开一个 SQL 文件");
    return;
  }
  await analyzeDocument(editor.document);
}

async function analyzeSelection(): Promise<void> {
  const editor = activeSqlEditor();
  if (!editor) return;
  if (editor.selection.isEmpty) {
    void vscode.window.showInformationMessage("请先选中一段 SQL");
    return;
  }
  await run(editor.document, editor.document.getText(editor.selection), editor.selection.start.line);
}

async function chooseDialect(): Promise<void> {
  const editor = activeSqlEditor();
  if (!editor) {
    void vscode.window.showInformationMessage("请先打开一个 SQL 文件");
    return;
  }
  const current = resolveDialect(editor.document, dialectOverrides);
  const picked = await pickDialect(current.spec.id);
  if (!picked) return;
  dialectOverrides.set(editor.document.uri.toString(), picked.id);
  updateStatusBar();
  await analyzeDocument(editor.document);
}

function toggleRealtime(): void {
  realtimeEnabled = !realtimeEnabled;
  updateStatusBar();
  void vscode.window.setStatusBarMessage(
    `SQL 血缘实时分析已${realtimeEnabled ? "开启" : "关闭"}`,
    2000,
  );
}

// ---------------------------------------------------------------- analysis

function scheduleAnalysis(document: vscode.TextDocument, overrideDelay?: number) {
  if (debounceTimer) clearTimeout(debounceTimer);
  const delay =
    overrideDelay ??
    vscode.workspace.getConfiguration("sqlLineage").get<number>("debounceMs", 500);
  debounceTimer = setTimeout(() => void analyzeDocument(document), delay);
}

async function analyzeDocument(document: vscode.TextDocument): Promise<void> {
  const maxKb = vscode.workspace.getConfiguration("sqlLineage").get<number>("maxFileSizeKB", 2048);
  if (document.getText().length > maxKb * 1024) {
    ensurePanel().sendEmpty(
      `文件超过 ${maxKb} KB，已跳过自动分析（可用命令手动触发）`,
      fileNameOf(document),
    );
    return;
  }
  await run(document, document.getText(), 0);
}

async function run(
  document: vscode.TextDocument,
  sql: string,
  lineOffset: number,
): Promise<void> {
  const panel = ensurePanel();

  if (!sql.trim()) {
    panel.sendEmpty("当前内容为空", fileNameOf(document));
    return;
  }

  const status = engine.getStatus();
  if (status.state === "error") {
    panel.sendStatus(status.detail, "error");
    return;
  }

  const { spec, origin } = resolveDialect(document, dialectOverrides);
  const seq = ++analysisSeq;

  panel.sendBusy(true);
  if (status.state !== "ready") panel.sendStatus(status.detail, "loading");

  const started = Date.now();
  const result = (await engine.analyze({
    dialectId: spec.id,
    sqlglotDialect: spec.sqlglotDialect,
    sql,
    schema: {},
    options: { includeColumnLineage: true, maxStatements: 500 },
  })) as AnalyzeResult | null;

  if (seq !== analysisSeq) return; // superseded by a newer edit
  panel.sendBusy(false);

  if (!result) {
    panel.sendStatus("分析失败（引擎未返回结果）", "error");
    return;
  }
  if (!result.ok) {
    panel.sendStatus(result.error ?? "分析失败", "error");
    return;
  }

  result.stats = { ...result.stats, wallMs: Date.now() - started };

  // A selection is analysed as a standalone snippet, so every reported line is
  // relative to it. Shift node and statement lines into document space.
  if (lineOffset > 0) {
    for (const node of result.graph.nodes) {
      if (typeof node.line === "number") node.line += lineOffset;
    }
    for (const statement of result.statements) {
      statement.slice.startLine += lineOffset;
    }
  }

  panel.push({ result, dialect: spec, dialectOrigin: origin, fileName: fileNameOf(document) });
  updateStatusBar();
}

// ---------------------------------------------------------------- misc

function isSqlDocument(document: vscode.TextDocument): boolean {
  return SELECTOR_LANGUAGES.has(document.languageId);
}

function updateStatusBar() {
  const editor = activeSqlEditor();
  if (!editor) {
    statusBar.hide();
    return;
  }
  const { spec, origin } = resolveDialect(editor.document, dialectOverrides);
  const status = engine.getStatus();
  const icon =
    status.state === "ready" ? "$(pulse)" : status.state === "error" ? "$(error)" : "$(sync~spin)";
  const mark = origin === "header" ? " (文件头)" : origin === "override" ? " (已切换)" : "";

  statusBar.text = `${icon} 血缘: ${spec.label}${mark}`;
  statusBar.tooltip = new vscode.MarkdownString(
    [
      "**SQL 血缘**",
      "",
      `方言：${spec.label}${mark}`,
      `引擎：${status.detail}`,
      `实时分析：${realtimeEnabled ? "开启" : "关闭"}`,
      "",
      "点击显示血缘图",
    ].join("\n"),
  );
  statusBar.show();
}

function revealLine(line: number, charRange?: { start: number; end: number } | null): void {
  const editor = activeSqlEditor();
  if (!editor) return;
  // Bring the SQL editor forward so the reveal is actually visible.
  void vscode.window.showTextDocument(editor.document, editor.viewColumn, false);
  const targetLine = Math.max(0, Math.min(line - 1, editor.document.lineCount - 1));
  const range = charRange
    ? new vscode.Range(targetLine, charRange.start, targetLine, charRange.end)
    : new vscode.Range(targetLine, 0, targetLine, 0);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  editor.selection = new vscode.Selection(range.start, range.end);
}

function copyNodeName(name: string): void {
  void vscode.env.clipboard.writeText(name);
  void vscode.window.setStatusBarMessage(`已复制 ${name}`, 1600);
}

function fileNameOf(document: vscode.TextDocument): string {
  return document.uri.path.split("/").pop() ?? document.fileName;
}
