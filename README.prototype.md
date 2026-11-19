# LineageLens — 浏览器原型

sqlglot 血缘引擎 + React Flow 渲染的**可交互原型**。
用途：在落 VSCode 扩展之前，先把输入、方言选择、图形样式、交互全部看到并可调。

> 项目总览见 [README.md](README.md)；VS Code 扩展见 [vscode-extension/](vscode-extension/)

> 设计文档：[docs/技术选型调研.md](docs/技术选型调研.md) · [docs/详细方案设计.md](docs/详细方案设计.md)

---

## 快速开始

```bash
npm install
npm run dev          # http://localhost:5178
```

首次打开会有约 3–5 秒的引擎加载（Pyodide 冷启动），完成后右上角显示「血缘引擎就绪」。

```bash
npm run test:engine  # Python 侧回归测试（需要本机 python3 + sqlglot）
npm run typecheck    # TypeScript 类型检查
npm run build        # 生产构建
```

---

## 这个原型验证了什么

| 设计点 | 原型中的体现 |
|---|---|
| 方言必须显式选择 | 顶部 6 个方言 chip，切换即重算 |
| 参数化库名可解析 | `${Schema}.orders` 能正确拆成库+表，且 `${A}.t` 与 `${B}.t` 不合并 |
| 预处理补丁可行 | GaussDB `DISTRIBUTE BY`、MySQL `REPLACE INTO` 改写后能拿到 AST |
| 无 schema 也能出列级血缘 | 所有示例都不传 schema，列级边依然完整 |
| 降级/失败必须可见 | 语句列表按状态着色，失败语句红框 + 行号 |
| 纯 SELECT 也有结果 | 无目标表时归入 `(query result)` 虚线节点 |
| 列级 drill-down 可行 | 两端都展开时，边自动切换到「列→列」连线 |
| 中文/emoji 位置安全 | 引擎侧统一转 UTF-16 偏移 |
| 语法速查随方言切换 | 顶栏「语法速查 ↓」，按建表/写入/删除分组，可下载 .sql |

## 参数化标识符

调度系统常用 `${Schema}` 这类模板占位。引擎的处理策略是**掩码而非删除**：

```
输入:  INSERT INTO ${Schema}.dws_t SELECT id FROM ${Schema}.ods_t
掩码:  INSERT INTO zz0______.dws_t SELECT id FROM zz0______.ods_t   (等长，偏移不变)
输出:  target = "${Schema}.dws_t"   sources = ["${Schema}.ods_t"]
```

原因：直接删掉 `${...}` 会让 `${A}.t` 和 `${B}.t` 都变成 `t`，两张不同的表被合并成
一个节点，血缘就错了。等长占位符既保住了库名位置，又能无损还原显示。

支持的写法：`${x}`、`#{x}`、`{{x}}`。
字符串字面量里的模板（如 `dt='${bizdate}'`）不会被改写，因为那是值不是标识符。

## 常见解析问题

| 现象 | 原因 | 提示 |
|---|---|---|
| `insert into table select a,b from t` 报「缺少目标表名」 | `TABLE` 后少了表名 | 明确写出 `INSERT INTO TABLE 表名 SELECT ...` |
| 报「疑似拼写错误」 | 关键字拼错（`fron`/`seelct`） | 按提示改正 |
| 全角标点 | `，` `；` `（）` | 引擎会自动转半角，无需手动改 |

---

## 目录结构

```
engine/
  lineage_engine.py      # 唯一引擎入口：analyze(payload_json) -> json
  test_engine.py         # 回归测试（6 组场景，25 条断言）
src/
  shared/types.ts        # 前后端共享类型 + 方言表 + 状态/变换配色
  worker/engine.worker.ts# Pyodide 宿主；引擎源码经 ?raw 内联
  hooks/useEngine.ts     # worker 生命周期 + 请求/响应关联
  graph/layout.ts        # 节点/边构建、dagre 布局、列级连线切换
  graph/TableNode.tsx    # 表节点（可展开列、列级 handle、hover 提示）
  App.tsx                # 布局、方言选择、详情面板、图例
  styles.css             # 全部样式（主题变量集中在 :root）
  samples.ts             # 5 个方言示例 SQL
scripts/
  prepare-pyodide.mjs    # 拷贝 Pyodide 运行时到 public/
public/
  pyodide/               # 离线运行时（13 MB，构建期生成，勿提交）
  wheels/                # sqlglot wheel（离线安装）
```

---

## 想改样式时看这里

| 想改什么 | 位置 |
|---|---|
| 整体配色 / 圆角 / 字体 | `src/styles.css` 顶部的 `:root` 变量 |
| 数仓分层颜色（ods/dwd/dws/ads） | `src/graph/TableNode.tsx` 的 `LAYER_COLORS` |
| 解析状态颜色 | `src/shared/types.ts` 的 `STATUS_META` |
| 连线颜色 / 虚线样式 | `src/shared/types.ts` 的 `TRANSFORM_META` |
| 表节点宽高、行高 | `src/graph/layout.ts` 顶部常量 + `styles.css` 里对应高度 |
| 布局方向（左右/上下） | `src/graph/layout.ts` 的 `rankdir` |
| 方言清单 | `src/shared/types.ts` 的 `DIALECTS` |

> 注意：`layout.ts` 里的 `HEADER_HEIGHT` / `FOOTER_HEIGHT` / `COLUMN_ROW_HEIGHT`
> 必须与 `styles.css` 中对应元素的真实高度一致，否则 dagre 布局会重叠。

---

## 引擎契约

```python
analyze(json.dumps({
    "dialectId": "hive",              # 决定预处理补丁
    "sqlglotDialect": "hive",         # 传给 sqlglot
    "sql": "...",
    "schema": {},                     # 可选，形如 {"db.t": {"col": "type"}}
    "options": {"includeColumnLineage": True, "maxStatements": 500},
})) -> str  # JSON
```

返回的关键字段：

```jsonc
{
  "ok": true,
  "statements": [{
    "index": 0,
    "slice": { "startLine": 1, "start": 0, "end": 120 },
    "kind": "insert",                  // insert|create|select|command|plsql_block|expression|error|other
    "status": "ok",                    // ok|degraded|unsupported|failed
    "target": "dws.dws_order_di",
    "sources": [{ "name": "ods.ods_order", "alias": "o" }],
    "columns": [{ "name": "pay_amt", "transform": "case",
                  "edges": [{ "sourceTable": "ods.ods_payment",
                              "sourceColumn": "pay_amount" }] }],
    "warnings": []
  }],
  "graph": {
    "nodes": [{ "id": "ods.ods_order", "roles": ["source"], "synthetic": false }],
    "edges": [{ "source": "ods.ods_order", "target": "dws.dws_order_di" }],
    "columnEdges": []
  },
  "stats": { "parseMs": 15.6, "tableCount": 7, "columnEdgeCount": 14 }
}
```

---

## 已知边界（原型阶段）

1. **不接元数据**：`SELECT *` 无法展开，列级图会缺列。
2. **Pyodide 冷启动 3–5s**：落 VSCode 时靠 `activate()` 后台预热解决。
3. **单文件分析**：跨文件 DAG 合并尚未在原型中实现（引擎已返回 `sources`，够用）。
4. **常量列无边**：`COUNT(1)` 这类输出列在图上没有上游边，属预期行为。
5. **不自动检测方言**：这是刻意的设计决策，见设计文档 1.1。

---

## 从原型到 VSCode 插件

可复用的部分（约 80%）：

- `engine/lineage_engine.py` —— 原封不动
- `src/graph/*`、`src/shared/types.ts` —— 原封不动
- `src/worker/engine.worker.ts` —— 只需把资源路径从 `location.origin` 换成扩展安装路径
- `src/styles.css` —— 原封不动

需要新写的部分：

- 扩展宿主：命令注册、状态栏、文件头方言识别、多文件选择
- Webview 桥接：`postMessage` 协议、`revealRange` 跳转
- 防抖 + 语句级缓存（原型里只有整体防抖）
