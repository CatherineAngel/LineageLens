export interface Sample {
  id: string;
  label: string;
  dialectId: string;
  sql: string;
}

const HIVE_ETL = `-- dialect: hive
-- 订单宽表：ods 明细 + 支付流水 汇总
INSERT OVERWRITE TABLE dws.dws_order_di PARTITION (dt='\${bizdate}')
WITH base AS (
    SELECT
        o.order_id,
        o.user_id,
        o.shop_id,
        o.amount,
        o.create_time,
        p.category_id
    FROM ods.ods_order o
    LEFT JOIN ods.ods_product p
        ON o.product_id = p.product_id
    WHERE o.dt = '\${bizdate}'
      AND o.status IN (1, 2, 3)
),
pay AS (
    SELECT
        order_id,
        SUM(pay_amount) AS pay_amt
    FROM ods.ods_payment
    WHERE dt = '\${bizdate}'
    GROUP BY order_id
)
SELECT
    b.order_id,
    b.user_id,
    b.shop_id,
    b.amount,
    b.category_id,
    COALESCE(p.pay_amt, 0) AS pay_amt,
    ROW_NUMBER() OVER (PARTITION BY b.user_id ORDER BY b.amount DESC) AS rn
FROM base b
LEFT JOIN pay p ON b.order_id = p.order_id;

INSERT INTO dws.dws_user_df
SELECT
    user_id,
    COUNT(1) AS order_cnt,
    SUM(amount) AS total_amount,
    MAX(create_time) AS last_order_time
FROM dws.dws_order_di
GROUP BY user_id;

INSERT INTO ads.ads_shop_report
SELECT s.shop_id, s.order_cnt, u.total_amount
FROM dws.dws_shop_df s
JOIN dws.dws_user_df u ON s.user_id = u.user_id;`;

const GAUSS = `-- dialect: gaussdb
CREATE TABLE dwd.dwd_pay_detail
(
    pay_id      BIGINT,
    order_id    BIGINT,
    pay_amount  NUMERIC(18,2),
    pay_time    TIMESTAMP,
    dt          VARCHAR(8)
)
WITH (ORIENTATION = COLUMN, COMPRESSION = HIGH)
DISTRIBUTE BY HASH(order_id);

INSERT INTO dwd.dwd_pay_detail
SELECT p.pay_id, p.order_id, p.pay_amount, p.pay_time, p.dt
FROM ods.ods_payment p
WHERE p.dt = '\${bizdate}';

INSERT INTO dws.dws_pay_agg
SELECT order_id, SUM(pay_amount) AS pay_total, COUNT(1) AS pay_cnt
FROM dwd.dwd_pay_detail
GROUP BY order_id;`;

const MYSQL = `-- dialect: oceanbase-mysql
REPLACE INTO dwd.dwd_member_tag (member_id, tag_name, update_time)
SELECT m.member_id, t.tag_name, NOW()
FROM ods.ods_member m
JOIN ods.ods_member_tag t ON m.member_id = t.member_id;

INSERT INTO dws.dws_member_summary
SELECT
    member_id,
    GROUP_CONCAT(tag_name SEPARATOR ',') AS tags,
    DATE_FORMAT(update_time, '%Y%m%d') AS update_dt,
    IFNULL(level, 0) AS level
FROM dwd.dwd_member_tag
GROUP BY member_id;`;

const ORACLE = `-- dialect: oceanbase-oracle
INSERT INTO dws.dws_acct_balance
SELECT
    a.acct_id,
    a.cust_id,
    NVL(b.balance, 0) AS balance,
    b.last_update
FROM ods.ods_account a
LEFT JOIN ods.ods_balance b
    ON a.acct_id = b.acct_id;

INSERT INTO ads.ads_cust_rank
SELECT cust_id, SUM(balance) AS total_balance
FROM dws.dws_acct_balance
GROUP BY cust_id;`;

const SELECT_ONLY = `-- 选中一段 SQL 直接看血缘（无目标表时归入 query result）
SELECT
    o.order_id,
    o.user_id,
    SUM(o.amount) AS total_amount,
    COUNT(DISTINCT o.product_id) AS sku_cnt,
    MAX(p.category_id) AS top_category
FROM ods.ods_order o
JOIN ods.ods_product p ON o.product_id = p.product_id
WHERE o.dt >= '20240101'
GROUP BY o.order_id, o.user_id;`;

export const SAMPLES: Sample[] = [
  { id: "hive", label: "Hive ETL", dialectId: "hive", sql: HIVE_ETL },
  { id: "gauss", label: "GaussDB", dialectId: "gaussdb", sql: GAUSS },
  { id: "mysql", label: "OB MySQL", dialectId: "oceanbase-mysql", sql: MYSQL },
  { id: "oracle", label: "OB Oracle", dialectId: "oceanbase-oracle", sql: ORACLE },
  { id: "select", label: "纯 SELECT", dialectId: "hive", sql: SELECT_ONLY },
];
