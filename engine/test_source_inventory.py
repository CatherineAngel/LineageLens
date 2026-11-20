"""Verify external source-table extraction grouped by schema."""
import json
import sys

sys.path.insert(0, "engine")
from lineage_engine import SCHEMA_UNSPECIFIED, analyze  # noqa: E402

FAIL = []


def check(label, cond, detail=""):
    print(("  ok   " if cond else "  FAIL ") + label + (f"   {detail}" if not cond else ""))
    if not cond:
        FAIL.append(label)


def inventory(sql, dialect_id="hive", sqlglot_dialect="hive"):
    r = json.loads(
        analyze(
            json.dumps(
                {
                    "dialectId": dialect_id,
                    "sqlglotDialect": sqlglot_dialect,
                    "sql": sql,
                    "schema": {},
                    "options": {"includeColumnLineage": True, "maxStatements": 500},
                }
            )
        )
    )
    return r, r["graph"]["sourceInventory"]


def flat(inv):
    return {t["table"] for g in inv["groups"] for t in g["tables"]}


print("1. 中间表排除：本文件产出的表不算源表")
ETL = """INSERT OVERWRITE TABLE ${Schema}.dws_order_di
SELECT o.order_id, o.amount FROM ${Schema}.ods_order o;

INSERT INTO ${Schema}.dws_user_df
SELECT user_id FROM ${Schema}.dws_order_di;"""
r, inv = inventory(ETL)
check("只报 ods_order", flat(inv) == {"ods_order"}, flat(inv))
check("总数 = 1", inv["totalTables"] == 1, inv["totalTables"])
check("一个库分组", inv["schemaCount"] == 1, inv)

print()
print("2. 库名参数原样保留")
check("分组名为 ${Schema}", inv["groups"][0]["schema"] == "${Schema}", inv["groups"][0]["schema"])
check("标记为参数", inv["groups"][0]["isParameter"] is True)

print()
print("3. 多库混合分组")
MIX = """INSERT INTO ${Schema}.a SELECT x FROM ${Schema}.s1;
INSERT INTO ${Other}.b SELECT y FROM ${Other}.s2;
INSERT INTO dws.c SELECT z FROM ods.raw;"""
r, inv = inventory(MIX)
schemas = [g["schema"] for g in inv["groups"]]
check("三个库分组", len(schemas) == 3, schemas)
check("含 ${Schema}", "${Schema}" in schemas, schemas)
check("含 ${Other}", "${Other}" in schemas, schemas)
check("含 ods（非参数）", "ods" in schemas, schemas)
ods_group = next(g for g in inv["groups"] if g["schema"] == "ods")
check("ods 标记为非参数", ods_group["isParameter"] is False)

print()
print("4. 无库名的表归入未指定库")
BARE = "INSERT INTO tgt SELECT a FROM stg_log"
r, inv = inventory(BARE)
check("分组为未指定库", inv["groups"][0]["schema"] == SCHEMA_UNSPECIFIED, inv["groups"][0]["schema"])
check("表名 stg_log", flat(inv) == {"stg_log"}, flat(inv))

print()
print("5. 纯 SELECT 文件：合成结果集不算源表")
SEL = "SELECT a, b FROM ods.t1 JOIN ods.t2 ON t1.id = t2.id"
r, inv = inventory(SEL)
check("两个源表", flat(inv) == {"t1", "t2"}, flat(inv))
check("不含 (query result)", "(query result)" not in flat(inv), flat(inv))

print()
print("6. 同表多次引用只出现一次")
DUP = """INSERT INTO ${Schema}.x SELECT a FROM ${Schema}.src;
INSERT INTO ${Schema}.y SELECT b FROM ${Schema}.src;"""
r, inv = inventory(DUP)
check("src 只出现一次", inv["totalTables"] == 1, inv["totalTables"])

print()
print("7. 空文件 / 无血缘")
r, inv = inventory(" ")
check("空结果", inv["totalTables"] == 0, inv)
check("分组为空", inv["groups"] == [], inv["groups"])

print()
print("8. 表内带语句索引，便于定位")
r, inv = inventory(ETL)
t = inv["groups"][0]["tables"][0]
check("有 fullName", t["fullName"] == "${Schema}.ods_order", t)
check("有行号", isinstance(t.get("line"), int), t.get("line"))

print()
if FAIL:
    print(f"{len(FAIL)} FAILURE(S): {FAIL}")
    sys.exit(1)
print("all source-inventory tests passed")
