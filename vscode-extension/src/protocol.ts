import type { AnalyzeResult, DialectSpec } from "./webview/shared/types";

/** Host -> Webview */
export type HostMessage =
  | { type: "status"; detail: string; state: "loading" | "ready" | "error" }
  | {
      type: "result";
      result: AnalyzeResult;
      dialect: DialectSpec;
      dialectOrigin: "override" | "header" | "setting";
      fileName: string;
    }
  | { type: "empty"; reason: string; fileName: string }
  | { type: "busy"; busy: boolean };

/** Webview -> Host */
export type WebviewMessage =
  | { type: "ready" }
  | { type: "revealNode"; nodeId: string; line?: number | null; charRange?: { start: number; end: number } | null }
  | { type: "pickDialect" }
  | { type: "refresh" }
  | { type: "copyNodeName"; name: string }
  /** Save a dialect cheat sheet via the host's save dialog. */
  | { type: "downloadSyntax"; fileName: string; content: string }
  /** Insert a syntax template into the active SQL editor. */
  | { type: "insertSnippet"; sql: string };
