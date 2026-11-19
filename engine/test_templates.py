"""Verify every syntax template parses as documented.

Templates are paired title -> sql within a bounded window, so a template that
omits `note` or `limited` cannot shift the pairing.
"""
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, "engine")
from lineage_engine import analyze  # noqa: E402

SPEC = Path("src/syntaxSpec.ts").read_text()

SQLGLOT_BY_DIALECT = {
    "hive": "hive",
    "gaussdb": "postgres",
    "oceanbase-mysql": "mysql",
    "oceanbase-oracle": "oracle",
    "goldendb": "mysql",
    "mysql": "mysql",
}


def extract_blocks() -> list[dict]:
    parts = re.split(r"\n  \{\n    dialectId: ", SPEC)[1:]
    out = []
    for part in parts:
        m = re.match(r'"([^"]+)"', part)
        if m:
            out.append({"dialectId": m.group(1), "body": part})
    return out


def extract_templates(body: str) -> list[dict]:
    templates = []
    titles = list(re.finditer(r'title:\s*"([^"]+)"', body))
    for idx, match in enumerate(titles):
        title = match.group(1)
        next_title = titles[idx + 1].start() if idx + 1 < len(titles) else len(body)
        segment = body[match.end():next_title]

        sql_match = re.search(r"sql:\s*`", segment)
        if not sql_match:
            continue
        start = sql_match.end()
        i = start
        end = None
        while i < len(segment):
            if segment[i] == "\\":
                i += 2
                continue
            if segment[i] == "`":
                end = i
                break
            i += 1
        if end is None:
            continue

        templates.append(
            {
                "title": title,
                "raw": segment[start:end],
                "limited": bool(re.search(r"limited:\s*true", segment)),
            }
        )
    return templates


def unescape(raw: str) -> str:
    return (
        raw.replace('${"${Schema}"}', "${Schema}")
        .replace("\\`", "`")
        .replace("\\t", "\t")
        .replace("\\\\", "\\")
    )


blocks = extract_blocks()
print(f"{len(blocks)} dialects found")

failures = []
total = 0

for block in blocks:
    dialect_id = block["dialectId"]
    templates = extract_templates(block["body"])
    total += len(templates)
    print(f"\n{dialect_id}  ({len(templates)} templates)")

    for t in templates:
        payload = {
            "dialectId": dialect_id,
            "sqlglotDialect": SQLGLOT_BY_DIALECT.get(dialect_id, "hive"),
            "sql": unescape(t["raw"]),
            "schema": {},
            "options": {"includeColumnLineage": True, "maxStatements": 500},
        }
        r = json.loads(analyze(json.dumps(payload)))

        if not r.get("ok"):
            print(f"  ENGINE-ERR {t['title']:30s} {r.get('error')}")
            failures.append((dialect_id, t["title"], r.get("error")))
            continue

        stmts = r["statements"]
        bad = [s for s in stmts if s["status"] == "failed"]
        if bad and not t["limited"]:
            print(f"  FAIL  {t['title']:30s} {bad[0]['warnings']}")
            failures.append((dialect_id, t["title"], bad[0]["warnings"]))
        elif t["limited"]:
            print(f"  ok*   {t['title']:30s} (文档标注部分支持)")
        else:
            targets = [s["target"] for s in stmts if s["target"]]
            print(f"  ok    {t['title']:30s} {targets[0] if targets else '(无血缘)'}")

print()
print("=" * 88)
if failures:
    print(f"{len(failures)}/{total} template(s) contradict their documentation:")
    for f in failures:
        print("  -", f)
    sys.exit(1)
print(f"all {total} templates verified")
