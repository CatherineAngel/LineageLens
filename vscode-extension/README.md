# SQL Lineage — VSCode 扩展

在 VS Code 里实时查看 SQL 的表级 / 字段级血缘。完全离线，不连数据库、不上传代码。

支持方言：**Hive SQL · GaussDB(DWS) · OceanBase(MySQL/Oracle) · GoldenDB · MySQL**

---

## 安装

```bash
code --install-extension sql-lineage-vscode-0.1.0.vsix
```

或在 VS Code 中：扩展面板 → `...` → 从 VSIX 安装 → 选择上面的文件。

装好后重启 VS Code（或执行 `Developer: Reload Window`）。

---

## 使用

打开任意 `.sql` 文件，血缘图会自动在编辑器右侧打开。

| 操作 | 效果 |
|---|---|
| 编辑 SQL | 停手 500ms 后自动重新分析 |
| 点击图节点 | 编辑器跳到该表所在行并选中表名 |
| 点击方言胶囊 | 切换当前文件方言（不会自动猜测） |
| 点击「全部展开」类按钮 | 展开列级视图，显示列→列血缘 |
| 右键 SQL 文件 → 分析选中片段 | 只分析选中的一段 |
| 状态栏「血缘: Hive SQL」 | 显示当前方言与来源，点击打开血图 |

### 方言如何确定

优先级从高到低，**刻意不做自动检测**（猜错会静默产出错误血缘，比不产出更危险）：

1. 手动切换（当前文件的临时覆盖）
2. 文件头标记：`-- dialect: hive`
3. 工作区配置 `sqlLineage.defaultDialect`

状态栏会显示来源：`(文件头)` / `(已切换)` / 无标记表示用的是工作区默认值。

---

## 配置项

| 配置 | 默认 | 说明 |
|---|---|---|
| `sqlLineage.defaultDialect` | `hive` | 默认方言 |
| `sqlLineage.detectFromFileHeader` | `true` | 允许 `-- dialect: xxx` 覆盖 |
| `sqlLineage.realtime` | `true` | 编辑时自动刷新 |
| `sqlLineage.debounceMs` | `500` | 编辑防抖（毫秒） |
| `sqlLineage.maxFileSizeKB` | `2048` | 超过此大小跳过自动分析 |
| `sqlLineage.viewMode` | `side` | `side` 编辑右侧 / `panel` 底部面板 |

---

## 实测性能

Apple Silicon / VS Code 1.141：

| 场景 | 耗时 |
|---|---|
| 引擎冷启动（激活时后台预热） | ~0.7–1.0 s |
| 3 条语句 / 7 表 / 9 列边（热路径） | **41 ms** |
| 单条语句列级血缘 | 2–3 ms |

冷启动是在扩展激活时后台完成的，正常使用时不会感知到。

---

## 架构

```
扩展宿主 (Node)
├── extension.ts      命令 / 状态栏 / 文档监听 / 防抖
├── dialects.ts       方言注册表 + 四级优先级解析
├── engineClient.ts   worker 生命周期 + 请求关联
└── lineagePanel.ts   Webview 管理 + postMessage
        │
        ▼
   worker thread
   └── engineWorker.ts   Pyodide + sqlglot，离线运行
        │
        ▼
   Webview (React + React Flow)
   └── 图渲染、节点展开、点击回传
```

三个设计要点：

1. **引擎跑在 worker 线程**，Pyodide 冷启动 0.7s 不会卡住扩展宿主。
2. **Pyodide 打包进 bundle**（`dist/engineWorker.js` 45 KB 引导 + `vendor/pyodide` 运行时），不依赖 `node_modules`，安装即用。
3. **sqlglot wheel 解压进 Pyodide 虚拟文件系统**，避免 micropip 的额外网络依赖。

---

## 已知边界

| 限制 | 说明 |
|---|---|
| `SELECT *` 不展开 | 不接元数据，无法知道表结构。图会显示「无列信息」 |
| PL/SQL 匿名块 | 标记为「不支持」，不产生血缘 |
| Oracle RANGE 分区 DDL | 只建表节点，不解析列 |
| 常量列无边 | `COUNT(1)` 这类输出列没有上游，属预期 |
| 超 2MB 文件 | 跳过自动分析，可手动触发 |

方言专有语法的处理：

- **GaussDB** `DISTRIBUTE BY HASH(...)` → 解析前剥离（等长空格替换，保持位置不偏移）
- **MySQL / OceanBase** `REPLACE INTO` → 按 `INSERT INTO` 等价解析
- 无法解析的语句 → 降级为正则抽取（仅表级），并在图上报黄色「降级」

---

## 开发

```bash
npm install
npm run watch      # 增量构建（extension / worker / webview）
npm run build      # 生产构建
npm run typecheck  # 类型检查
npm run package    # 打包 VSIX
```

构建产物：

```
dist/extension.js      20 KB   扩展宿主
dist/engineWorker.js   46 KB   Pyodide 引导（+ vendor 运行时）
media/webview.js      380 KB   React 图界面
vendor/pyodide/       13 MB    Python 运行时（离线）
vendor/wheels/       810 KB    sqlglot
```

### 引擎同步

`lineage_engine.py` 有两份（浏览器原型用的 `../engine/` 与本扩展目录）。修改后必须同步：

```bash
cp ../engine/lineage_engine.py ./lineage_engine.py
npm run build
```

引擎在构建时以**文本**方式内联进 worker bundle，所以不存在「改了源码但跑的是旧副本」的问题。

---

## 验收记录

在真实 VS Code 1.141（macOS arm64）中验证：

- ✅ 打开 SQL 文件自动出图（5 表 / 7 列边）
- ✅ 文件头 `-- dialect: hive` 被识别，状态栏显示「(文件头)」
- ✅ 点击节点精确跳到第 11 行并选中 `ods_payment`（11 个字符）
- ✅ 新增语句后自动重算（3 语句 / 7 表 / 9 列边）
- ✅ 热路径 41ms
- ✅ 受限模式（Restricted Mode）下可用
- ✅ 面板不抢占编辑器焦点
