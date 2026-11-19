import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import type { HostMessage, WebviewMessage } from "./protocol";
import type { AnalyzeResult, DialectSpec } from "./webview/shared/types";

export interface GraphUpdate {
  result: AnalyzeResult;
  dialect: DialectSpec;
  dialectOrigin: "override" | "header" | "setting";
  fileName: string;
}

export interface PanelHandlers {
  onReveal: (line: number, charRange?: { start: number; end: number } | null) => void;
  onPickDialect: () => void;
  onRefresh: () => void;
  onCopy: (name: string) => void;
  onDownloadSyntax: (fileName: string, content: string) => void;
  onInsertSnippet: (sql: string) => void;
}

/**
 * The lineage graph panel.
 *
 * A single panel is reused across documents so switching files never stacks
 * windows. The webview bundle is plain React with no vscode imports, so the
 * exact same code runs in the browser prototype.
 */
export class LineagePanel {
  private static current: LineagePanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private webviewReady = false;
  private queued: HostMessage | null = null;

  static show(
    context: vscode.ExtensionContext,
    handlers: PanelHandlers,
  ): LineagePanel {
    if (LineagePanel.current) {
      LineagePanel.current.panel.reveal(undefined, true); // preserveFocus
      return LineagePanel.current;
    }

    const viewMode = vscode.workspace.getConfiguration("sqlLineage").get<string>("viewMode", "side");
    const panel = vscode.window.createWebviewPanel(
      "sqlLineage",
      "SQL 血缘",
      viewMode === "panel" ? vscode.ViewColumn.Active : vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
      },
    );

    const instance = new LineagePanel(panel, context, handlers);
    LineagePanel.current = instance;
    return instance;
  }

  static disposeCurrent(): void {
    LineagePanel.current?.dispose();
    LineagePanel.current = undefined;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    handlers: PanelHandlers,
  ) {
    this.panel = panel;
    panel.webview.html = this.render(panel.webview);

    panel.webview.onDidReceiveMessage(
      (message: WebviewMessage) => {
        switch (message.type) {
          case "ready":
            this.webviewReady = true;
            if (this.queued) {
              void this.panel.webview.postMessage(this.queued);
              this.queued = null;
            }
            break;
          case "revealNode":
            handlers.onReveal(message.line ?? 1, message.charRange ?? null);
            break;
          case "pickDialect":
            handlers.onPickDialect();
            break;
          case "refresh":
            handlers.onRefresh();
            break;
          case "copyNodeName":
            handlers.onCopy(message.name);
            break;
          case "downloadSyntax":
            handlers.onDownloadSyntax(message.fileName, message.content);
            break;
          case "insertSnippet":
            handlers.onInsertSnippet(message.sql);
            break;
        }
      },
      null,
      this.disposables,
    );

    panel.onDidDispose(
      () => {
        LineagePanel.current = undefined;
        for (const disposable of this.disposables) disposable.dispose();
        this.disposables.length = 0;
      },
      null,
      this.disposables,
    );
  }

  push(update: GraphUpdate): void {
    this.send({
      type: "result",
      result: update.result,
      dialect: update.dialect,
      dialectOrigin: update.dialectOrigin,
      fileName: update.fileName,
    });
  }

  sendEmpty(reason: string, fileName: string): void {
    this.send({ type: "empty", reason, fileName });
  }

  sendStatus(detail: string, state: "loading" | "ready" | "error"): void {
    this.send({ type: "status", detail, state });
  }

  sendBusy(busy: boolean): void {
    this.send({ type: "busy", busy });
  }

  private send(message: HostMessage): void {
    if (!this.webviewReady) {
      // Only the newest payload matters; status chatter can be dropped.
      if (message.type === "result" || message.type === "empty") this.queued = message;
      return;
    }
    void this.panel.webview.postMessage(message);
  }

  dispose(): void {
    this.panel.dispose();
  }

  private render(webview: vscode.Webview): string {
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, "media");
    const htmlPath = path.join(this.context.extensionPath, "media", "index.html");

    if (!fs.existsSync(htmlPath)) {
      return `<!doctype html><html><body style="font-family:sans-serif;padding:2rem;color:#cbd5e1">
        <h3>Webview 资源缺失</h3>
        <p>找不到 <code>media/index.html</code>，请先执行 <code>npm run build</code>。</p>
      </body></html>`;
    }

    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, "webview.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, "webview.css"));
    const nonce = getNonce();

    return fs
      .readFileSync(htmlPath, "utf8")
      .replace(/{{script}}/g, scriptUri.toString())
      .replace(/{{style}}/g, styleUri.toString())
      .replace(/{{cspSource}}/g, webview.cspSource)
      .replace(/{{nonce}}/g, nonce);
  }
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i += 1) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
