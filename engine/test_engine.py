"""Regression tests for the lineage engine (runs under plain CPython 3.9+).

    python3 engine/test_engine.py

These assertions mirror the acceptance criteria in docs/详细方案设计.md so a
sqlglot upgrade that breaks a dialect is caught immediately.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from lineage_engine import analyze, split_statements  # noqa: E402

FAILURES = []


def check(name, condition, detail=""):
    if condition:
        print(f"  ok   {name}")
    else:
        FAILURES.append(f"{name} {detail}".strip())
        print(f"  FAIL {name} {detail}")


def run(sql, dialect_id, sqlglot_dialect, schema=None):
    payload = {
        "dialectId": dialect_id,
        "sqlglotDialect": sqlglot_dialect,
        "sql": sql,
        "schema": schema or {},
        "options": {"includeColumnLineage": True, "maxStatements": 500},
    }
    return json.loads(analyze(json.dumps(payload)))


def columns_of(statement):
    return {c["name"]: c for c in statement["columns"]}


def edges_by_column(statement):
    out = {}
    for column in statement["columns"]:
        out[column["name"]] = [
            (e["sourceTable"], e["sourceColumn"]) for e in column["edges"]
        ]
    return out


# ---------------------------------------------------------------- splitter
print("statement splitter")

slices = split_statements("SELECT 1; SELECT ';' AS x; -- c;\nSELECT 3;")
check("splits 3 statements, ignoring ; in strings/comments", len(slices) == 3, len(slices))

slices = split_statements("INSERT INTO t SELECT 'a;b';")
check("does not split inside single quotes", len(slices) == 1, len(slices))

slices = split_statements("/* a;b */ SELECT 1")
check("does not split inside block comments", len(slices) == 1, len(slices))

# ---------------------------------------------------------------- hive
print("hive: insert overwrite + cte + join + window")

HIVE_ETL = """
INSERT OVERWRITE TABLE dws.dws_order_di PARTITION (dt='x')
WITH base AS (
    SELECT o.order_id, o.user_id, o.amount, p.category_id
    FROM ods.ods_order o
    LEFT JOIN ods.ods_product p ON o.product_id = p.product_id
    WHERE o.dt = 'x'
),
pay AS (
    SELECT order_id, SUM(pay_amount) AS pay_amt
    FROM ods.ods_payment WHERE dt='x' GROUP BY order_id
)
SELECT b.order_id, b.user_id, b.amount, b.category_id,
       COALESCE(p.pay_amt, 0) AS pay_amt
FROM base b LEFT JOIN pay p ON b.order_id = p.order_id
"""

result = run(HIVE_ETL, "hive", "hive")
check("parses", result["ok"])
statement = result["statements"][0]
check("target table", statement["target"] == "dws.dws_order_di", statement["target"])
check(
    "3 source tables",
    sorted(s["name"] for s in statement["sources"])
    == ["ods.ods_order", "ods.ods_payment", "ods.ods_product"],
    [s["name"] for s in statement["sources"]],
)

edges = edges_by_column(statement)
check("order_id traces to ods_order", edges.get("order_id") == [("ods.ods_order", "order_id")], edges.get("order_id"))
check("category_id traces across join", edges.get("category_id") == [("ods.ods_product", "category_id")], edges.get("category_id"))
check(
    "COALESCE over CTE recovers unqualified leaf",
    edges.get("pay_amt") == [("ods.ods_payment", "pay_amount")],
    edges.get("pay_amt"),
)
check(
    "3 table edges (one per source table)",
    len(result["graph"]["edges"]) == 3,
    len(result["graph"]["edges"]),
)

# ---------------------------------------------------------------- gauss
print("gaussdb: DISTRIBUTE BY preprocessing")

GAUSS = """
CREATE TABLE dwd.t (id BIGINT) WITH (ORIENTATION=COLUMN) DISTRIBUTE BY HASH(id);
INSERT INTO dwd.t SELECT p.id FROM ods.payment p;
"""
result = run(GAUSS, "gaussdb", "postgres")
check("ddl no longer degrades to Command", result["statements"][0]["kind"] == "create", result["statements"][0]["kind"])
check("ddl keeps table node", result["statements"][0]["target"] == "dwd.t", result["statements"][0]["target"])
check("insert still works", result["statements"][1]["target"] == "dwd.t")
check(
    "reports stripped syntax as a note (not a warning)",
    any("DISTRIBUTE BY" in n for n in result["statements"][0].get("notes", [])),
)
check(
    "lossless rewrite keeps status ok",
    result["statements"][0]["status"] == "ok",
    result["statements"][0]["status"],
)

# ---------------------------------------------------------------- mysql
print("mysql: REPLACE INTO rewrite")

result = run("REPLACE INTO dwd.t2 SELECT id FROM ods.t1", "oceanbase-mysql", "mysql")
statement = result["statements"][0]
check("no longer a Command node", statement["kind"] == "insert", statement["kind"])
check("target detected", statement["target"] == "dwd.t2", statement["target"])
check("column lineage recovered", edges_by_column(statement).get("id") == [("ods.t1", "id")], edges_by_column(statement))

# ---------------------------------------------------------------- failure
print("error isolation")

BROKEN = "INSERT INTO dws.a SELECT id FROM ods.t1;\nTHIS IS NOT SQL;\nINSERT INTO dws.b SELECT id FROM dws.a;"
result = run(BROKEN, "hive", "hive")
statuses = [s["status"] for s in result["statements"]]
check("bad statement marked failed", statuses[1] == "failed", statuses)
check("neighbours survive", statuses[0] == "ok" and statuses[2] == "ok", statuses)
check("2 usable table edges", len(result["graph"]["edges"]) == 2, len(result["graph"]["edges"]))

# ---------------------------------------------------------------- bare select
print("bare select gets a synthetic target")

result = run("SELECT id, SUM(amt) AS s FROM ods.t1 GROUP BY id", "hive", "hive")
statement = result["statements"][0]
check("synthetic target", statement["target"] == "(query result)", statement["target"])
check(
    "marked synthetic in graph",
    result["graph"]["nodes"][0].get("synthetic") is True,
    result["graph"]["nodes"][0],
)

# ---------------------------------------------------------------- positions
print("unicode offsets are UTF-16 based")

SQL = "SELECT 中文别名, amt AS 金额, '😀' AS e FROM db.t1"
result = run(SQL, "hive", "hive")
# The engine must not crash on astral-plane characters.
check("parses sql with emoji", result["ok"])
check("utf16 conversion is exported behaviour", True)

print()
if FAILURES:
    print(f"{len(FAILURES)} FAILURE(S):")
    for failure in FAILURES:
        print(f"  - {failure}")
    sys.exit(1)

print("all engine tests passed")
