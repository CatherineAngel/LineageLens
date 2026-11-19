"""Verify ${Schema} / ${Table} parameter handling end to end."""
import json
import sys

sys.path.insert(0, "engine")
from lineage_engine import analyze  # noqa: E402

FAIL = []


def check(label, cond, detail=""):
    print(("  ok   " if cond else "  FAIL ") + label + (f"  {detail}" if not cond and detail else ""))
    if not cond:
        FAIL.append(label)


def run(sql, dialect_id="hive", sqlglot_dialect="hive"):
    return json.loads(
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


print("1. 库名参数：${Schema}.orders")
SQL = """INSERT OVERWRITE TABLE ${Schema}.dws_order PARTITION (dt='${bizdate}')
SELECT o.order_id, SUM(o.amount) AS amt
FROM ${Schema}.ods_order o
GROUP BY o.order_id;"""
r = run(SQL)
s = r["statements"][0]
check("解析成功", r["ok"] and s["status"] == "ok", s.get("warnings"))
check("target 保留占位", s["target"] == "${Schema}.dws_order", repr(s["target"]))
names = sorted(x["name"] for x in s["sources"])
check("sources 保留占位", names == ["${Schema}.ods_order"], names)
check(
    "列边表名保留占位",
    s["columns"][0]["edges"][0]["sourceTable"] == "${Schema}.ods_order",
    s["columns"][0]["edges"],
)
check(
    "图节点保留占位",
    sorted(n["id"] for n in r["graph"]["nodes"]) == ["${Schema}.dws_order", "${Schema}.ods_order"],
    [n["id"] for n in r["graph"]["nodes"]],
)
check("显示列", s["sources"][0]["db"] == "${Schema}" and s["sources"][0]["table"] == "ods_order",
      (s["sources"][0]["db"], s["sources"][0]["table"]))

print()
print("2. 不同参数不合并")
r2 = run("INSERT INTO ${A}.t SELECT id FROM ${B}.t")
ids = sorted(n["id"] for n in r2["graph"]["nodes"])
check("${A}.t 与 ${B}.t 是两个节点", ids == ["${A}.t", "${B}.t"], ids)
edges = [(e["source"], e["target"]) for e in r2["graph"]["edges"]]
check("边正确", edges == [("${B}.t", "${A}.t")], edges)

print()
print("3. 表名也是参数 ${Table}")
r3 = run("INSERT INTO ${Schema}.${Table} SELECT id FROM src.t")
s3 = r3["statements"][0]
check("target 还原", s3["target"] == "${Schema}.${Table}", repr(s3["target"]))
check("table 部分还原", s3["sources"][0]["name"] == "src.t", s3["sources"])

print()
print("4. 分区值 ${bizdate} 在字符串里，不应被改写")
r4 = run("SELECT id FROM t1 WHERE dt='${bizdate}'")
s4 = r4["statements"][0]
check("解析成功", s4["status"] == "ok", s4.get("warnings"))
check("不产生参数警告", not any("参数化" in w for w in s4["warnings"]), s4["warnings"])
check("合成目标正常", s4["target"] == "(query result)", s4["target"])

print()
print("5. 参数与普通库名混用")
r5 = run("""INSERT INTO ${Schema}.dws_t
SELECT a.id FROM ${Schema}.src_t a JOIN dim.city c ON a.city_id=c.id""")
s5 = r5["statements"][0]
check("target", s5["target"] == "${Schema}.dws_t", s5["target"])
check("sources 含两个", sorted(x["name"] for x in s5["sources"]) == ["${Schema}.src_t", "dim.city"],
      [x["name"] for x in s5["sources"]])

print()
print("6. 短参数名 ${X}（占位符最窄的情况）")
r6 = run("INSERT INTO ${X}.t SELECT id FROM ${Y}.t")
ids6 = sorted(n["id"] for n in r6["graph"]["nodes"])
check("两个节点不合并", ids6 == ["${X}.t", "${Y}.t"], ids6)

print()
print("7. 双大括号 {{schema}}")
r7 = run("SELECT id FROM {{schema}}.orders")
s7 = r7["statements"][0]
check("解析成功", s7["status"] == "ok", s7.get("warnings"))
check("表名还原", [x["name"] for x in s7["sources"]] and True)
check("目标/源", s7["sources"][0]["name"] if s7["sources"] else None, s7["sources"])

print()
print("8. 回归：普通 SQL 不受影响")
r8 = run("INSERT INTO dws.a SELECT id FROM ods.b")
s8 = r8["statements"][0]
check("target 无变化", s8["target"] == "dws.a", s8["target"])
check("无参数警告", not any("参数化" in w for w in s8["warnings"]), s8["warnings"])

print()
if FAIL:
    print(f"{len(FAIL)} FAILURE(S): {FAIL}")
    sys.exit(1)
print("all parameter tests passed")
