"""Verify the review fixes: newline preservation, column edge count, offsets."""
import json
import sys

sys.path.insert(0, "engine")
from lineage_engine import analyze, preprocess  # noqa: E402

FAIL = []


def check(label, cond, detail=""):
    print(("  ok   " if cond else "  FAIL ") + label + (f"   {detail}" if not cond else ""))
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


print("1. DISTRIBUTE BY 剥离不应吃掉换行")
GAUSS = """CREATE TABLE db.t (
  id BIGINT,
  dt VARCHAR(8)
)
DISTRIBUTE BY HASH(id);
INSERT INTO db.u SELECT a FROM x;"""
processed, notes, _ = preprocess(GAUSS, "gaussdb")
check(
    "行数不变",
    processed.count("\n") == GAUSS.count("\n"),
    f"{GAUSS.count(chr(10))} -> {processed.count(chr(10))}",
)
check("字符数不变", len(processed) == len(GAUSS))

print()
print("2. 后续语句行号不受影响")
r = run(GAUSS, "gaussdb", "postgres")
lines = [(s["slice"]["startLine"], s["kind"]) for s in r["statements"]]
check(
    "第二条语句仍在第 6 行",
    any(line == 6 for line, kind in lines),
    lines,
)

print()
print("3. REPLACE INTO 改写保留换行")
MYSQL = "REPLACE\nINTO t2 SELECT id FROM t1"
processed, notes, _ = preprocess(MYSQL, "mysql")
check("行数不变", processed.count("\n") == MYSQL.count("\n"), repr(processed))
check("长度不变", len(processed) == len(MYSQL))
check("已改写为 INSERT", processed.startswith("INSERT"))

print()
print("4. columnEdgeCount 统计真实边数")
COALESCE = """INSERT INTO dws.t
SELECT COALESCE(a.x, b.y) AS v
FROM ods.ta a JOIN ods.tb b ON a.id = b.id"""
r = run(COALESCE)
reported = r["stats"]["columnEdgeCount"]
actual = len(r["graph"]["columnEdges"])
check("与 columnEdges 长度一致", reported == actual, f"reported={reported} actual={actual}")
check("一列两源 = 2 条边", actual == 2, actual)

print()
print("5. UTF-16 偏移换算正确（emoji 之后）")
SQL = "SELECT 中文, amt AS 金额, '😀' AS e FROM db.t1"
r = run(SQL)
check("含 emoji 的 SQL 可解析", r["ok"])
src = r["statements"][0]["sources"]
check("源表位置已给出", bool(src) and src[0]["range"] is not None, src)

print()
print("6. 位置换算：行内列偏移而非绝对偏移")
POS = "INSERT INTO db.t2\nSELECT a\nFROM db.t1"
r = run(POS)
ranges = {s["name"]: s["range"] for s in r["statements"][0]["sources"]}
t1 = ranges.get("db.t1")
check("db.t1 在第 3 行", bool(t1) and t1.get("line") == 3, t1)
check("列偏移为行内偏移（小于行长）", bool(t1) and t1.get("col", 99) < 10, t1)

print()
print("7. 多语句文件：源表行号是文档绝对行号")
MULTI = """CREATE TABLE db.a (
  id BIGINT
);

INSERT INTO db.b
SELECT x.id
FROM db.src x;"""
r = run(MULTI)
sources = r["statements"][1]["sources"]
check(
    "db.src 位于文档第 7 行",
    bool(sources) and sources[0]["range"]["line"] == 7,
    sources[0]["range"] if sources else None,
)
node_lines = {n["id"]: n.get("line") for n in r["graph"]["nodes"]}
check("图节点同步为第 7 行", node_lines.get("db.src") == 7, node_lines)

print()
if FAIL:
    print(f"{len(FAIL)} FAILURE(S): {FAIL}")
    sys.exit(1)
print("all review fixes verified")
