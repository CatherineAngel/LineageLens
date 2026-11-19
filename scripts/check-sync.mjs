#!/usr/bin/env node
/**
 * Guard against drift between the shared webview sources used by the browser
 * prototype and the VS Code extension.
 *
 * These files are intentionally duplicated (the extension is packaged
 * standalone), so a copy step is unavoidable - but silently diverging copies
 * are not. Run this before committing; `npm test` also calls it.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const PAIRS = [
  ["engine/lineage_engine.py", "vscode-extension/lineage_engine.py"],
  ["src/syntaxSpec.ts", "vscode-extension/src/webview/syntaxSpec.ts"],
  ["src/styles-syntax.css", "vscode-extension/src/webview/styles-syntax.css"],
  ["src/graph/layout.ts", "vscode-extension/src/webview/graph/layout.ts"],
  ["src/graph/TableNode.tsx", "vscode-extension/src/webview/graph/TableNode.tsx"],
  ["src/shared/types.ts", "vscode-extension/src/webview/shared/types.ts"],
];

// Intentionally host-specific, so not compared byte-for-byte:
//   src/styles.css  - the prototype has an editor pane, the extension does not.
//   App.tsx         - different shell (textarea vs. editor-hosted).

async function read(file) {
  try {
    return await readFile(path.join(root, file), "utf8");
  } catch {
    return null;
  }
}

let drifted = 0;
for (const [a, b] of PAIRS) {
  const left = await read(a);
  const right = await read(b);
  if (left === null || right === null) {
    console.log(`  skip  ${a}  (缺少一份)`);
    continue;
  }
  if (left === right) {
    console.log(`  ok    ${a}`);
  } else {
    drifted += 1;
    console.log(`  DRIFT ${a}  !=  ${b}`);
  }
}

console.log();
if (drifted > 0) {
  console.log(`${drifted} 个共享文件已分叉，请同步后再提交：`);
  console.log("  cp <左侧> <右侧>   # 或反向，取决于哪边是新的");
  process.exit(1);
}
console.log("共享文件全部一致");
