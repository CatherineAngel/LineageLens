# LineageLens

**SQL 血缘分析，看得见。** 为数据工程师打造的 Hive / GaussDB / OceanBase / GoldenDB / MySQL
血缘可视化工具 —— 表级、字段级，完全离线运行。

```
  ods.ods_order  ──┐
  ods.ods_product ─┼──▶  dws.dws_order_di  ──▶  dws.dws_user_df
  ods.ods_payment ─┘
```

---

## 这是什么

一个支持多种 SQL 方言的血缘分析器，两种形态共用同一套引擎：

| 形态 | 位置 | 用途 |
|---|---|---|
| **VS Code 扩展** | [`vscode-extension/`](vscode-extension/) | 写 SQL 时实时看血缘图，点节点跳回源码 |
| **浏览器原型** | 仓库根目录 | 调样式、试方言、验证引擎行为的沙盒 |

---

## 支持的方言

| 方言 | sqlglot dialect | 特殊处理 |
|---|---|---|
| Hive SQL | `hive` | 原生支持，含 `INSERT OVERWRITE`、`LATERAL VIEW`、多表写入 |
| GaussDB (DWS) | `postgres` | 自动剥离 `DISTRIBUTE BY HASH(...)` |
| OceanBase · MySQL | `mysql` | `REPLACE INTO` 按 `INSERT` 等价解析 |
| OceanBase · Oracle | `oracle` | 跳过 PL/SQL 匿名块 |
| GoldenDB | `mysql` | MySQL 兼容 |
| MySQL | `mysql` | `REPLACE INTO` 等价改写 |

**不做方言自动检测** —— 猜错会静默产出错误血缘，比不产出更危险。方言按
「命令指定 → 文件头 `-- dialect: xxx` → 工作区配置」四级确定，状态栏常显来源。

---

## 核心能力

- **字段级血缘**：`COALESCE(p.pay_amt, 0)` 能追到 `ods.ods_payment.pay_amount`，并标注变换类型（直接 / 聚合 / 函数 / 条件）
- **参数化标识符**：`${Schema}.orders` 正确拆成库 + 表，且 `${A}.t` 与 `${B}.t` 不会被误合并
- **列级下钻**：两端表都展开时，连线自动切换成「列 → 列」
- **点击跳转**：点图上节点，编辑器精确选中该表名
- **完全离线**：Pyodide + sqlglot 打包进产物，不上传任何代码
- **语法速查**：内置 6 方言 × 65 条模板（建表 / 写入 / 查询 / 删除），可下载 `.sql`
- **错误可诊断**：缺表名、关键字拼错、全角标点都有明确提示，绝不静默出空图

---

## 快速开始

### 浏览器原型

```bash
npm install
npm run dev            # http://localhost:5178
```

首次打开约 0.7–1 秒加载 Pyodide，右上角显示「血缘引擎就绪」后即可输入。
原型使用说明见 [README.prototype.md](README.prototype.md)。

### VS Code 扩展

```bash
cd vscode-extension
npm install
npm run package        # 产出 lineage-lens-0.1.0.vsix
code --install-extension lineage-lens-0.1.0.vsix
```

打开任意 `.sql` 文件，血缘图自动出现在编辑器右侧。

---

## 测试

```bash
python3 -m pip install sqlglot
npm test               # 三套引擎测试全跑
```

| 测试 | 覆盖 |
|---|---|
| `engine/test_engine.py` | 语句切分、Hive CTE / 窗口、方言补丁、错误隔离、位置换算 |
| `engine/test_params.py` | `${Schema}` / `${Table}` / `{{schema}}` 参数化标识符 |
| `engine/test_templates.py` | 65 条语法速查模板逐条验证，保证文档不会说谎 |

---

## 架构

```
        ┌─────────────────────────────────────┐
        │  Host（VS Code / 浏览器）            │
        │  文档监听 · 防抖 · 方言解析 · 缓存   │
        └──────────────┬──────────────────────┘
                       │ JSON
        ┌──────────────▼──────────────────────┐
        │  Worker Thread                       │
        │  Pyodide + sqlglot                   │
        │  ┌────────────────────────────────┐  │
        │  │ 1. 全角标点归一化               │  │
        │  │ 2. 参数占位掩码（等长）          │  │
        │  │ 3. 方言预处理补丁                │  │
        │  │ 4. 语句切分                      │  │
        │  │ 5. AST → 表级 / 列级血缘         │  │
        │  │ 6. 位置转 UTF-16                 │  │
        │  └────────────────────────────────┘  │
        └──────────────┬──────────────────────┘
                       │ JSON
        ┌──────────────▼──────────────────────┐
        │  Webview（React + React Flow）       │
        │  图渲染 · 节点展开 · 点击回传        │
        └─────────────────────────────────────┘
```

引擎跑在 worker 线程里，Pyodide 冷启动不会阻塞界面。

---

## 目录结构

```
engine/
  lineage_engine.py      唯一引擎入口：analyze(payload) -> JSON
  test_*.py              三套回归测试
src/                     浏览器原型
  worker/engine.worker.ts
  graph/                 节点 / 边构建、dagre 布局
  syntaxSpec.ts          6 方言 × 65 条语法模板
  components/SyntaxSheet.tsx
vscode-extension/
  src/extension.ts       命令 / 状态栏 / 文档监听
  src/engineWorker.ts    Pyodide 宿主（引擎以文本内联）
  src/lineagePanel.ts    Webview 管理
  scripts/build.mjs      三路构建 + vendor 打包
docs/
  技术选型调研.md         方言 / 解析器选型的实测对比
  详细方案设计.md         架构、方言机制、增量策略设计
```

---

## 关键设计决策

**1. 为什么用 sqlglot 而不是自研 ANTLR 语法**

实测 ANTLR4 的 `dt-sql-parser` 连 Hive 最主流的 `INSERT OVERWRITE ... WITH` 都解析失败，
且不提供任何血缘 API。sqlglot 在 42 条真实语句上通过率 88–95%，内置列级血缘，热路径亚毫秒。

**2. 参数掩码为什么不能直接删除**

删掉 `${...}` 会让 `${A}.t` 和 `${B}.t` 都变成 `t`，两张不同的表被合并成一个节点。
等长合法标识符既保住库名位置、保持所有偏移不变，又能无损还原显示。

**3. 为什么解析失败必须可见**

sqlglot 对 `INSERT INTO TABLE SELECT ...`（漏表名）不报错，会静默返回空图。
引擎强制检查 AST 节点类型，任何降级 / 失败都在 UI 上标红，绝不允许「没有血缘但看起来成功」。

---

## 已知限制

| 限制 | 说明 |
|---|---|
| `SELECT *` 不展开 | 不接元数据，无法得知表结构，图上会标注「无列信息」 |
| PL/SQL 匿名块 | 标记「不支持」，不产生血缘 |
| `VALUES LESS THAN` 分区 DDL | 只识别表名，不解析列 |
| 超过 2 MB 的文件 | 跳过自动分析，可手动触发 |

---

## License

[Apache License 2.0](LICENSE)
