/**
 * Per-dialect SQL syntax cheat sheets.
 *
 * Rendered next to the dialect switcher and downloadable as .sql. Every snippet
 * here is verified against the lineage engine (see engine/test_templates.py), so
 * the templates double as "known-good" examples users can paste and analyse.
 */

export interface SyntaxTemplate {
  title: string;
  /** Short note about dialect-specific behaviour. */
  note?: string;
  sql: string;
  /** True when the engine cannot fully analyse it (documented limitation). */
  limited?: boolean;
}

export interface SyntaxGroup {
  title: string;
  templates: SyntaxTemplate[];
}

export interface DialectSyntax {
  dialectId: string;
  label: string;
  summary: string;
  groups: SyntaxGroup[];
}

const COMMON_QUERY: SyntaxGroup = {
  title: "查询",
  templates: [
    {
      title: "基础查询",
      sql: `SELECT order_id, user_id, amount
FROM ${"${Schema}"}.ods_order
WHERE dt = '\${bizdate}';`,
    },
    {
      title: "聚合 + 分组",
      sql: `SELECT user_id, COUNT(1) AS order_cnt, SUM(amount) AS total_amount
FROM ${"${Schema}"}.ods_order
WHERE dt = '\${bizdate}'
GROUP BY user_id;`,
    },
    {
      title: "多表关联",
      sql: `SELECT o.order_id, o.amount, p.category_name
FROM ${"${Schema}"}.ods_order o
JOIN ${"${Schema}"}.ods_product p
  ON o.product_id = p.product_id;`,
    },
    {
      title: "CTE（WITH）",
      sql: `WITH base AS (
    SELECT order_id, user_id, amount
    FROM ${"${Schema}"}.ods_order
    WHERE dt = '\${bizdate}'
)
SELECT user_id, SUM(amount) AS total_amount
FROM base
GROUP BY user_id;`,
    },
  ],
};

export const DIALECT_SYNTAX: DialectSyntax[] = [
  {
    dialectId: "hive",
    label: "Hive SQL",
    summary: "Hive / Spark SQL 语法。支持 INSERT OVERWRITE、分区、LATERAL VIEW explode。",
    groups: [
      {
        title: "建表",
        templates: [
          {
            title: "普通建表（ORC + 分区）",
            sql: `CREATE TABLE IF NOT EXISTS ${"${Schema}"}.dwd_order
(
    order_id     BIGINT      COMMENT '订单ID',
    user_id      BIGINT      COMMENT '用户ID',
    amount       DECIMAL(18,2) COMMENT '金额',
    create_time  STRING      COMMENT '创建时间'
)
COMMENT '订单明细表'
PARTITIONED BY (dt STRING COMMENT '分区日期')
STORED AS ORC
TBLPROPERTIES ('orc.compress' = 'SNAPPY');`,
          },
          {
            title: "外部表",
            sql: `CREATE EXTERNAL TABLE IF NOT EXISTS ${"${Schema}"}.ods_order_ext
(
    order_id  BIGINT,
    amount    DECIMAL(18,2)
)
PARTITIONED BY (dt STRING)
ROW FORMAT DELIMITED FIELDS TERMINATED BY '\\t'
STORED AS TEXTFILE
LOCATION '/warehouse/ods/order';`,
          },
          {
            title: "CTAS（建表即写入）",
            sql: `CREATE TABLE ${"${Schema}"}.dws_user_df
STORED AS ORC
AS
SELECT user_id, COUNT(1) AS order_cnt
FROM ${"${Schema}"}.ods_order
GROUP BY user_id;`,
          },
        ],
      },
      {
        title: "写入",
        templates: [
          {
            title: "覆盖写入分区（最常用）",
            sql: `INSERT OVERWRITE TABLE ${"${Schema}"}.dws_order_di
PARTITION (dt = '\${bizdate}')
SELECT order_id, user_id, SUM(amount) AS amount
FROM ${"${Schema}"}.ods_order
WHERE dt = '\${bizdate}'
GROUP BY order_id, user_id;`,
          },
          {
            title: "追加写入（INSERT INTO）",
            sql: `INSERT INTO TABLE ${"${Schema}"}.dws_order_di
PARTITION (dt = '\${bizdate}')
SELECT order_id, user_id, amount
FROM ${"${Schema}"}.ods_order
WHERE dt = '\${bizdate}';`,
          },
          {
            title: "动态分区写入",
            note: "分区列写在最后，且需开启 hive.exec.dynamic.partition。",
            sql: `INSERT OVERWRITE TABLE ${"${Schema}"}.dwd_order
PARTITION (dt)
SELECT order_id, user_id, amount, dt
FROM ${"${Schema}"}.ods_order;`,
          },
          {
            title: "多表写入（FROM ... INSERT）",
            sql: `FROM ${"${Schema}"}.ods_order
INSERT OVERWRITE TABLE ${"${Schema}"}.dws_order_cnt
  SELECT user_id, COUNT(1) AS order_cnt GROUP BY user_id
INSERT OVERWRITE TABLE ${"${Schema}"}.dws_amount_sum
  SELECT user_id, SUM(amount) AS total_amount GROUP BY user_id;`,
          },
        ],
      },
      {
        title: "常用语法",
        templates: [
          {
            title: "行转列 explode",
            note: "LATERAL VIEW 是 Hive 专有语法。",
            sql: `SELECT o.order_id, item
FROM ${"${Schema}"}.ods_order o
LATERAL VIEW explode(o.items) t AS item;`,
          },
          {
            title: "开窗函数",
            sql: `SELECT order_id, user_id, amount,
       ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY amount DESC) AS rn
FROM ${"${Schema}"}.ods_order;`,
          },
          {
            title: "JSON 解析",
            sql: `SELECT
    get_json_object(ext_json, '$.uid')       AS uid,
    get_json_object(ext_json, '$.channel')   AS channel
FROM ${"${Schema}"}.ods_log;`,
          },
        ],
      },
      {
        title: "删除",
        templates: [
          {
            title: "删除分区（Hive 主要靠分区管理）",
            sql: `ALTER TABLE ${"${Schema}"}.dwd_order DROP IF EXISTS PARTITION (dt = '20240101');`,
          },
          {
            title: "删除表",
            sql: `DROP TABLE IF EXISTS ${"${Schema}"}.tmp_order;`,
          },
          {
            title: "清空表",
            sql: `TRUNCATE TABLE ${"${Schema}"}.tmp_order;`,
          },
          {
            title: "删除行（需事务表）",
            note: "Hive 原生表不支持 DELETE，需 ACID 事务表。",
            limited: true,
            sql: `DELETE FROM ${"${Schema}"}.dwd_order_acid WHERE dt = '20240101';`,
          },
        ],
      },
    ],
  },
  {
    dialectId: "gaussdb",
    label: "GaussDB (DWS)",
    summary: "openGauss / DWS 语法。支持列存、DISTRIBUTE BY、COPY。",
    groups: [
      {
        title: "建表",
        templates: [
          {
            title: "列存 + 分布键（DWS 典型）",
            sql: `CREATE TABLE ${"${Schema}"}.dwd_order
(
    order_id     BIGINT,
    user_id      BIGINT,
    amount       NUMERIC(18,2),
    create_time  TIMESTAMP,
    dt           VARCHAR(8)
)
WITH (ORIENTATION = COLUMN, COMPRESSION = HIGH)
DISTRIBUTE BY HASH(order_id);`,
          },
          {
            title: "行存 + 分区表",
            note: "VALUES LESS THAN 分区子句引擎暂不解析，只识别表名。",
            limited: true,
            sql: `CREATE TABLE ${"${Schema}"}.dwd_order
(
    order_id  BIGINT,
    amount    NUMERIC(18,2),
    dt        VARCHAR(8)
)
WITH (ORIENTATION = ROW)
PARTITION BY RANGE (dt)
(
    PARTITION p202401 VALUES LESS THAN ('20240201'),
    PARTITION p202402 VALUES LESS THAN ('20240301')
);`,
          },
          {
            title: "CTAS",
            sql: `CREATE TABLE ${"${Schema}"}.dws_user_df AS
SELECT user_id, COUNT(1) AS order_cnt
FROM ${"${Schema}"}.ods_order
GROUP BY user_id;`,
          },
        ],
      },
      {
        title: "写入",
        templates: [
          {
            title: "INSERT INTO",
            sql: `INSERT INTO ${"${Schema}"}.dwd_order
SELECT order_id, user_id, amount, create_time, dt
FROM ${"${Schema}"}.ods_order
WHERE dt = '\${bizdate}';`,
          },
          {
            title: "UPSERT（ON CONFLICT）",
            sql: `INSERT INTO ${"${Schema}"}.dwd_order (order_id, amount)
VALUES (1, 100.00)
ON CONFLICT (order_id) DO UPDATE SET amount = EXCLUDED.amount;`,
          },
          {
            title: "COPY 导入",
            sql: `COPY ${"${Schema}"}.dwd_order
FROM '/data/order/${"${bizdate}"}.csv'
WITH (FORMAT csv, HEADER true, DELIMITER ',');`,
          },
        ],
      },
      {
        title: "常用语法",
        templates: [
          {
            title: "JSON 字段提取",
            sql: `SELECT
    ext_json ->> 'uid'      AS uid,
    ext_json #>> '{a,b}'    AS nested
FROM ${"${Schema}"}.ods_log;`,
          },
          {
            title: "生成日期序列",
            sql: `SELECT d::date AS dt
FROM generate_series('2024-01-01'::date, '2024-12-31'::date, '1 day') d;`,
          },
          {
            title: "字符串聚合",
            sql: `SELECT user_id, string_agg(tag, ',' ORDER BY tag) AS tags
FROM ${"${Schema}"}.dwd_user_tag
GROUP BY user_id;`,
          },
        ],
      },
      {
        title: "删除",
        templates: [
          {
            title: "删除行",
            sql: `DELETE FROM ${"${Schema}"}.dwd_order WHERE dt = '\${bizdate}';`,
          },
          {
            title: "清空表",
            sql: `TRUNCATE TABLE ${"${Schema}"}.tmp_order;`,
          },
          {
            title: "删除表",
            sql: `DROP TABLE IF EXISTS ${"${Schema}"}.tmp_order;`,
          },
        ],
      },
    ],
  },
  {
    dialectId: "oceanbase-mysql",
    label: "OceanBase · MySQL",
    summary: "OceanBase MySQL 模式，兼容 MySQL 5.7/8.0 语法。",
    groups: [
      {
        title: "建表",
        templates: [
          {
            title: "普通建表（含索引）",
            sql: `CREATE TABLE IF NOT EXISTS \`\${Schema}\`.\`dwd_order\` (
    \`order_id\`    BIGINT       NOT NULL AUTO_INCREMENT,
    \`user_id\`     BIGINT       NOT NULL,
    \`amount\`      DECIMAL(18,2) DEFAULT 0.00,
    \`create_time\` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`dt\`          VARCHAR(8)   NOT NULL,
    PRIMARY KEY (\`order_id\`),
    KEY \`idx_user\` (\`user_id\`),
    KEY \`idx_dt\` (\`dt\`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;`,
          },
          {
            title: "CTAS",
            sql: `CREATE TABLE dws_user_df AS
SELECT user_id, COUNT(1) AS order_cnt
FROM dwd_order
GROUP BY user_id;`,
          },
        ],
      },
      {
        title: "写入",
        templates: [
          {
            title: "INSERT INTO ... SELECT",
            sql: `INSERT INTO dwd_order (order_id, user_id, amount, dt)
SELECT order_id, user_id, amount, dt
FROM ods_order
WHERE dt = '\${bizdate}';`,
          },
          {
            title: "REPLACE INTO",
            note: "按 INSERT 等价分析血缘（引擎自动改写）。",
            sql: `REPLACE INTO dwd_member_tag (member_id, tag_name, update_time)
SELECT member_id, tag_name, NOW()
FROM ods_member_tag;`,
          },
          {
            title: "ON DUPLICATE KEY UPDATE",
            sql: `INSERT INTO dwd_order (order_id, amount)
VALUES (1, 100.00)
ON DUPLICATE KEY UPDATE amount = VALUES(amount);`,
          },
        ],
      },
      {
        title: "常用语法",
        templates: [
          {
            title: "分组聚合",
            sql: `SELECT
    user_id,
    COUNT(1)                        AS order_cnt,
    IFNULL(SUM(amount), 0)          AS total_amount,
    GROUP_CONCAT(tag SEPARATOR ',') AS tags
FROM dwd_order
GROUP BY user_id;`,
          },
          {
            title: "日期格式化",
            sql: `SELECT
    DATE_FORMAT(create_time, '%Y%m%d') AS dt,
    DATE_SUB(CURDATE(), INTERVAL 1 DAY) AS yesterday
FROM dwd_order
LIMIT 100;`,
          },
        ],
      },
      {
        title: "删除",
        templates: [
          {
            title: "删除行",
            sql: `DELETE FROM dwd_order WHERE dt = '\${bizdate}';`,
          },
          {
            title: "清空表",
            sql: `TRUNCATE TABLE tmp_order;`,
          },
          {
            title: "删除表",
            sql: `DROP TABLE IF EXISTS tmp_order;`,
          },
        ],
      },
    ],
  },
  {
    dialectId: "oceanbase-oracle",
    label: "OceanBase · Oracle",
    summary: "OceanBase Oracle 模式，兼容 Oracle 语法（ROWNUM、CONNECT BY、MERGE）。",
    groups: [
      {
        title: "建表",
        templates: [
          {
            title: "普通建表",
            sql: `CREATE TABLE dwd_order
(
    order_id     NUMBER(20)     NOT NULL,
    user_id      NUMBER(20)     NOT NULL,
    amount       NUMBER(18,2)   DEFAULT 0,
    create_time  DATE           DEFAULT SYSDATE,
    dt           VARCHAR2(8)    NOT NULL,
    CONSTRAINT pk_dwd_order PRIMARY KEY (order_id)
);`,
          },
          {
            title: "注释",
            sql: `COMMENT ON TABLE  dwd_order IS '订单明细表';
COMMENT ON COLUMN dwd_order.amount IS '金额';`,
          },
          {
            title: "CTAS",
            sql: `CREATE TABLE dws_user_df AS
SELECT user_id, COUNT(1) AS order_cnt
FROM dwd_order
GROUP BY user_id;`,
          },
        ],
      },
      {
        title: "写入",
        templates: [
          {
            title: "INSERT INTO ... SELECT",
            sql: `INSERT INTO dwd_order (order_id, user_id, amount, dt)
SELECT order_id, user_id, NVL(amount, 0), dt
FROM ods_order
WHERE dt = '\${bizdate}';`,
          },
          {
            title: "MERGE（Oracle 的 upsert）",
            sql: `MERGE INTO dwd_order t
USING ods_order s
ON (t.order_id = s.order_id)
WHEN MATCHED THEN
    UPDATE SET t.amount = s.amount
WHEN NOT MATCHED THEN
    INSERT (order_id, user_id, amount)
    VALUES (s.order_id, s.user_id, s.amount);`,
          },
        ],
      },
      {
        title: "常用语法",
        templates: [
          {
            title: "ROWNUM 取前 N 行",
            sql: `SELECT order_id, amount
FROM (
    SELECT order_id, amount
    FROM dwd_order
    ORDER BY amount DESC
)
WHERE ROWNUM <= 10;`,
          },
          {
            title: "层级查询 CONNECT BY",
            sql: `SELECT org_id, parent_id, LEVEL AS lvl
FROM dim_org
START WITH parent_id IS NULL
CONNECT BY PRIOR org_id = parent_id;`,
          },
          {
            title: "字符串聚合 LISTAGG",
            sql: `SELECT user_id, LISTAGG(tag, ',') WITHIN GROUP (ORDER BY tag) AS tags
FROM dwd_user_tag
GROUP BY user_id;`,
          },
        ],
      },
      {
        title: "删除",
        templates: [
          {
            title: "删除行",
            sql: `DELETE FROM dwd_order WHERE dt = '\${bizdate}';
COMMIT;`,
          },
          {
            title: "清空表",
            sql: `TRUNCATE TABLE tmp_order;`,
          },
          {
            title: "删除表",
            sql: `DROP TABLE tmp_order PURGE;`,
          },
          {
            title: "PL/SQL 匿名块",
            note: "引擎不支持静态分析，会标记为「不支持」。",
            limited: true,
            sql: `BEGIN
    EXECUTE IMMEDIATE 'TRUNCATE TABLE tmp_order';
    COMMIT;
END;
/`,
          },
        ],
      },
    ],
  },
  {
    dialectId: "goldendb",
    label: "GoldenDB",
    summary: "GoldenDB（MySQL 兼容）。分布式事务型数据库，语法同 MySQL。",
    groups: [
      {
        title: "建表",
        templates: [
          {
            title: "普通建表（推荐带分片键）",
            sql: `CREATE TABLE IF NOT EXISTS \`\${Schema}\`.\`dwd_order\` (
    \`order_id\`    BIGINT       NOT NULL,
    \`user_id\`     BIGINT       NOT NULL,
    \`amount\`      DECIMAL(18,2) DEFAULT 0.00,
    \`dt\`          VARCHAR(8)   NOT NULL,
    PRIMARY KEY (\`order_id\`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;`,
          },
          {
            title: "CTAS",
            sql: `CREATE TABLE dws_user_df AS
SELECT user_id, COUNT(1) AS order_cnt
FROM dwd_order
GROUP BY user_id;`,
          },
        ],
      },
      {
        title: "写入",
        templates: [
          {
            title: "INSERT INTO ... SELECT",
            sql: `INSERT INTO dwd_order (order_id, user_id, amount, dt)
SELECT order_id, user_id, amount, dt
FROM ods_order
WHERE dt = '\${bizdate}';`,
          },
          {
            title: "REPLACE INTO",
            sql: `REPLACE INTO dwd_order (order_id, amount)
SELECT order_id, amount FROM ods_order;`,
          },
          {
            title: "ON DUPLICATE KEY UPDATE",
            sql: `INSERT INTO dwd_order (order_id, amount)
VALUES (1, 100.00)
ON DUPLICATE KEY UPDATE amount = VALUES(amount);`,
          },
        ],
      },
      {
        title: "删除",
        templates: [
          {
            title: "删除行",
            sql: `DELETE FROM dwd_order WHERE dt = '\${bizdate}';`,
          },
          {
            title: "清空表",
            sql: `TRUNCATE TABLE tmp_order;`,
          },
          {
            title: "删除表",
            sql: `DROP TABLE IF EXISTS tmp_order;`,
          },
        ],
      },
    ],
  },
  {
    dialectId: "mysql",
    label: "MySQL",
    summary: "MySQL 5.7 / 8.0 语法。",
    groups: [
      {
        title: "建表",
        templates: [
          {
            title: "普通建表",
            sql: `CREATE TABLE IF NOT EXISTS \`dwd_order\` (
    \`order_id\`    BIGINT       NOT NULL AUTO_INCREMENT,
    \`user_id\`     BIGINT       NOT NULL,
    \`amount\`      DECIMAL(18,2) DEFAULT 0.00,
    \`create_time\` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (\`order_id\`),
    KEY \`idx_user\` (\`user_id\`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;`,
          },
          {
            title: "CTAS",
            sql: `CREATE TABLE dws_user_df AS
SELECT user_id, COUNT(1) AS order_cnt
FROM dwd_order
GROUP BY user_id;`,
          },
        ],
      },
      {
        title: "写入",
        templates: [
          {
            title: "INSERT INTO ... SELECT",
            sql: `INSERT INTO dwd_order (order_id, user_id, amount)
SELECT order_id, user_id, amount
FROM ods_order
WHERE dt = '\${bizdate}';`,
          },
          {
            title: "REPLACE INTO",
            sql: `REPLACE INTO dwd_order (order_id, amount)
SELECT order_id, amount FROM ods_order;`,
          },
          {
            title: "ON DUPLICATE KEY UPDATE",
            sql: `INSERT INTO dwd_order (order_id, amount)
VALUES (1, 100.00)
ON DUPLICATE KEY UPDATE amount = VALUES(amount);`,
          },
        ],
      },
      {
        title: "常用语法",
        templates: [
          {
            title: "分组聚合",
            sql: `SELECT
    user_id,
    COUNT(1)                        AS order_cnt,
    IFNULL(SUM(amount), 0)          AS total_amount,
    GROUP_CONCAT(tag SEPARATOR ',') AS tags
FROM dwd_order
GROUP BY user_id;`,
          },
        ],
      },
      {
        title: "删除",
        templates: [
          {
            title: "删除行",
            sql: `DELETE FROM dwd_order WHERE dt = '\${bizdate}';`,
          },
          {
            title: "清空表",
            sql: `TRUNCATE TABLE tmp_order;`,
          },
          {
            title: "删除表",
            sql: `DROP TABLE IF EXISTS tmp_order;`,
          },
        ],
      },
    ],
  },
];

export function syntaxFor(dialectId: string): DialectSyntax {
  return DIALECT_SYNTAX.find((d) => d.dialectId === dialectId) ?? DIALECT_SYNTAX[0];
}

/** Render a dialect cheat sheet as a downloadable .sql file body. */
export function renderCheatSheet(dialect: DialectSyntax): string {
  const lines: string[] = [
    `-- ============================================================`,
    `-- ${dialect.label} 语法速查`,
    `-- ${dialect.summary}`,
    `-- 生成时间: ${new Date().toISOString().slice(0, 19).replace("T", " ")}`,
    `-- 说明: 每条模板都可直接粘贴到编辑器中分析血缘`,
    `-- ============================================================`,
    ``,
  ];

  for (const group of dialect.groups) {
    lines.push(`-- ${"-".repeat(58)}`);
    lines.push(`-- ${group.title}`);
    lines.push(`-- ${"-".repeat(58)}`);
    lines.push("");
    for (const template of group.templates) {
      lines.push(`-- ${template.title}`);
      if (template.note) lines.push(`-- 注意: ${template.note}`);
      if (template.limited) lines.push(`-- ⚠ 引擎对此语法仅能部分分析`);
      lines.push(template.sql.trimEnd());
      lines.push("");
    }
  }

  return lines.join("\n");
}

export const COMMON_QUERY_GROUP = COMMON_QUERY;
