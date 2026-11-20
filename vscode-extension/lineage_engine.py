"""
SQL lineage analysis engine, runs inside Pyodide.

Exposes `analyze(payload_json: str) -> str` for the JS host.
Design doc: docs/详细方案设计.md
"""

import json
import re
import time

import sqlglot
from sqlglot import exp
from sqlglot.lineage import lineage as sqlglot_lineage
from sqlglot.optimizer.scope import traverse_scope

__all__ = ["analyze", "split_statements"]


# ---------------------------------------------------------------- statement split

def split_statements(sql: str) -> list[dict]:
    """Split on `;` while skipping comments, string literals and dollar quoting.

    Returns slices with codepoint offsets and 1-based line numbers.
    """
    slices = []
    state = "code"
    start = 0
    i = 0
    n = len(sql)
    line = 1
    start_line = 1

    while i < n:
        ch = sql[i]
        nxt = sql[i + 1] if i + 1 < n else ""

        if state == "code":
            if ch == "-" and nxt == "-":
                state = "line_comment"
                i += 2
                continue
            if ch == "#":
                state = "line_comment"
                i += 1
                continue
            if ch == "/" and nxt == "*":
                state = "block_comment"
                i += 2
                continue
            if ch == "'":
                state = "single"
                i += 1
                continue
            if ch == '"':
                state = "double"
                i += 1
                continue
            if ch == "`":
                state = "backtick"
                i += 1
                continue
            if ch == "$" and nxt == "$":
                state = "dollar"
                i += 2
                continue
            if ch == ";":
                text = sql[start:i]
                if text.strip():
                    slices.append(_make_slice(sql, start, i, start_line))
                start = i + 1
                start_line = line
                i += 1
                continue
            if ch == "\n":
                line += 1
            i += 1
            continue

        if state == "line_comment":
            if ch == "\n":
                line += 1
                state = "code"
            i += 1
            continue

        if state == "block_comment":
            if ch == "*" and nxt == "/":
                state = "code"
                i += 2
                continue
            if ch == "\n":
                line += 1
            i += 1
            continue

        if state == "single":
            if ch == "'" and nxt == "'":
                i += 2
                continue
            if ch == "'":
                state = "code"
            elif ch == "\n":
                line += 1
            i += 1
            continue

        if state == "double":
            if ch == '"':
                state = "code"
            elif ch == "\n":
                line += 1
            i += 1
            continue

        if state == "backtick":
            if ch == "`":
                state = "code"
            elif ch == "\n":
                line += 1
            i += 1
            continue

        if state == "dollar":
            if ch == "$" and nxt == "$":
                state = "code"
                i += 2
                continue
            if ch == "\n":
                line += 1
            i += 1
            continue

        i += 1

    tail = sql[start:]
    if tail.strip():
        slices.append(_make_slice(sql, start, n, start_line))
    return slices


def _make_slice(sql: str, start: int, end: int, start_line: int) -> dict:
    text = sql[start:end]
    stripped = text.strip()
    lead = len(text) - len(text.lstrip())
    return {
        "start": start + lead,
        "end": start + lead + len(stripped),
        "startLine": start_line + text[:lead].count("\n"),
        "text": stripped,
    }


# ---------------------------------------------------------------- preprocessing

_DISTRIBUTE_BY = re.compile(
    r"\s+DISTRIBUTE\s+BY\s+(?:HASH|ROUNDROBIN|REPLICATION)\s*\([^)]*\)",
    re.IGNORECASE,
)
_REPLACE_INTO = re.compile(r"\bREPLACE\s+INTO\b", re.IGNORECASE)
_PLSQL_BLOCK = re.compile(r"^\s*(?:BEGIN|DECLARE)\b", re.IGNORECASE)

# Template syntax used by scheduling platforms: ${x} / #{x} / {{x}}.
_PARAM = re.compile(r"(?:\$\{|#\{|\{\{)([^}]+?)(?:\}\}|\})")

# Placeholder identifiers are prefixed so they are unambiguously ours and can be
# mapped back to the original template text. Chosen to stay a valid identifier
# in every supported dialect.
_PLACEHOLDER_PREFIX = "zzparam"


def _blank(match) -> str:
    """Replace with same-length whitespace, preserving newlines.

    Every offset must survive the rewrite, including *line* numbers - turning a
    newline into a space would shift all later positions by one line.
    """
    return "".join("\n" if ch == "\n" else " " for ch in match.group(0))


def _string_literal_spans(sql: str) -> list[tuple[int, int]]:
    """Offsets of single-quoted string literals, so templates inside them are skipped.

    `dt='${bizdate}'` is a value, not an identifier; rewriting it would be
    pointless and could confuse the parser.
    """
    spans = []
    i = 0
    n = len(sql)
    while i < n:
        if sql[i] != "'":
            i += 1
            continue
        start = i
        i += 1
        while i < n:
            if sql[i] == "'":
                if i + 1 < n and sql[i + 1] == "'":  # escaped quote
                    i += 2
                    continue
                i += 1
                break
            i += 1
        spans.append((start, i))
    return spans


def _mask_params(sql: str) -> tuple[str, dict[str, str]]:
    """Replace `${Name}` templates with equal-length legal identifiers.

    sqlglot accepts `${Schema}.orders` but silently drops the schema part
    (`table.db == ""`) and loses the parameter, which merges `${A}.t` and
    `${B}.t` into one node. Substituting a real identifier keeps the schema
    position intact, leaves every offset unchanged (same length), and lets us
    restore the original `${Schema}` when rendering.

    Templates inside string literals are left untouched - they are values.

    Returns (rewritten sql, token -> original template).
    """
    mapping: dict[str, str] = {}
    assigned: dict[str, str] = {}
    counter = 0
    literals = _string_literal_spans(sql)

    def in_literal(position: int) -> bool:
        return any(start <= position < end for start, end in literals)

    def replace(match: re.Match) -> str:
        nonlocal counter
        if in_literal(match.start()):
            return match.group(0)

        original = match.group(0)
        token = assigned.get(original)
        if token is None:
            # Index tokens keep us within the narrow width of `${X}` (4 chars)
            # without deriving text from the parameter name, which would
            # truncate and collide (`${SchemaA}` vs `${SchemaB}`).
            digits = _base36(counter)
            counter += 1
            token = f"zz{digits}"
            if len(token) < len(original):
                token = token + "_" * (len(original) - len(token))
            else:
                token = token[: len(original)]
            if token.startswith("zz") is False:
                return original  # too narrow to encode safely; leave as-is
            assigned[original] = token
            mapping[token.lower()] = original
        return token

    return _PARAM.sub(replace, sql), mapping


def _base36(value: int) -> str:
    alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
    if value == 0:
        return "0"
    out = []
    while value:
        value, rem = divmod(value, 36)
        out.append(alphabet[rem])
    return "".join(reversed(out))


def _restore_params(name: str, mapping: dict[str, str]) -> str:
    """Turn a placeholder identifier back into the original `${Name}` template."""
    if not name or not mapping:
        return name
    restored = name
    for token, original in mapping.items():
        # Case-insensitive: dialects differ on identifier casing.
        pattern = re.compile(re.escape(token), re.IGNORECASE)
        restored = pattern.sub(original, restored)
    return restored


def preprocess(sql: str, dialect_id: str) -> tuple[str, list[str], dict[str, str]]:
    """Apply dialect fixes and template masking before parsing.

    Returns (rewritten sql, notes, param map). `notes` describes lossless
    rewrites and must NOT downgrade the statement status - only genuine
    fidelity loss (missing AST, failed columns) counts as a warning.
    """
    notes: list[str] = []
    sql, param_map = _mask_params(sql)

    if dialect_id in ("gaussdb",):
        if _DISTRIBUTE_BY.search(sql):
            notes.append("已剥离 GaussDB 专有语法 DISTRIBUTE BY（不影响血缘）")
            sql = _DISTRIBUTE_BY.sub(_blank, sql)

    if dialect_id in ("mysql", "oceanbase-mysql", "goldendb"):
        if _REPLACE_INTO.search(sql):
            notes.append("REPLACE INTO 已按 INSERT INTO 等价解析（血缘一致）")

            def _rewrite_replace(match: re.Match) -> str:
                # `REPLACE` (7) -> `INSERT ` (7): identical width, and any
                # newline inside `REPLACE INTO` must stay a newline.
                text = match.group(0)
                head = "INSERT "
                return head + "".join("\n" if ch == "\n" else " " for ch in text[7:])

            sql = _REPLACE_INTO.sub(_rewrite_replace, sql)

    if param_map:
        notes.append(f"已解析参数化标识符: {', '.join(sorted(set(param_map.values())))}")

    return sql, notes, param_map


# ---------------------------------------------------------------- positions

_UTF16_CACHE: dict[str, list[int]] = {}


def _utf16_offsets(text: str) -> list[int]:
    """codepoint index -> utf16 code unit index map.

    Keyed by the text itself: `id()` is not stable, since a freed string's id
    can be reused by a different string of the same length.
    """
    cached = _UTF16_CACHE.get(text)
    if cached is not None:
        return cached

    out = [0] * (len(text) + 1)
    total = 0
    for i, ch in enumerate(text):
        out[i] = total
        total += 2 if ord(ch) > 0xFFFF else 1
    out[len(text)] = total

    if len(_UTF16_CACHE) > 4:
        _UTF16_CACHE.clear()
    _UTF16_CACHE[text] = out
    return out


def _range_from_meta(node, text: str) -> dict | None:
    """Convert sqlglot position metadata into VSCode-friendly coordinates.

    sqlglot reports *absolute codepoint offsets*; VSCode wants (1-based line,
    0-based UTF-16 column). Both conversions happen here so consumers never
    have to re-derive them.
    """
    meta = getattr(node, "meta", None) or {}
    start = meta.get("start")
    end = meta.get("end")
    if start is None or end is None:
        return None

    offsets = _utf16_offsets(text)
    if start >= len(offsets) or end >= len(offsets):
        return None

    start_utf16 = offsets[start]
    end_utf16 = offsets[end + 1] if end + 1 < len(offsets) else offsets[end]

    # Column = distance from the start of the node's own line.
    line_start = text.rfind("\n", 0, start) + 1
    col_start_utf16 = offsets[start] - offsets[line_start]
    col_end_utf16 = col_start_utf16 + (end_utf16 - start_utf16)

    return {
        "start": start_utf16,
        "end": end_utf16,
        "line": text.count("\n", 0, start) + 1,
        "col": col_start_utf16,
        "colEnd": col_end_utf16,
    }


# ---------------------------------------------------------------- helpers

def _table_name(node) -> str:
    parts = []
    if node.catalog:
        parts.append(node.catalog)
    if node.db:
        parts.append(node.db)
    parts.append(node.name)
    return ".".join(parts)


def _short_name(node) -> str:
    if node.db:
        return f"{node.db}.{node.name}"
    return node.name


def _restore_in_name(name: str, param_map: dict[str, str]) -> str:
    """Restore masked identifiers (`zz0`) back to their `${Schema}` spelling."""
    return _restore_params(name, param_map)


def _collect_alias_map(ast) -> dict[str, str]:
    """alias -> physical table name. Needed because lineage leaves use aliases."""
    alias_map = {}
    cte_names = {cte.alias_or_name.lower() for cte in ast.find_all(exp.CTE)}
    for scope in traverse_scope(ast):
        for alias, source in scope.sources.items():
            node = source[0] if isinstance(source, tuple) else source
            if isinstance(node, exp.Table):
                if node.name.lower() in cte_names and not node.db:
                    continue
                alias_map[alias.lower()] = _short_name(node)
    return alias_map


def _resolve_leaf(leaf_name: str, alias_map: dict[str, str]) -> tuple[str, str]:
    parts = leaf_name.split(".")
    column = parts[-1]
    if len(parts) == 1:
        return "<unknown>", column
    qualifier = ".".join(parts[:-1]).strip('"`')
    resolved = alias_map.get(qualifier.lower())
    if resolved:
        return resolved, column
    return qualifier, column


def _single_table_of(source, dialect: str) -> str | None:
    """When a lineage leaf has no qualifier, recover the table from its query.

    Example: `COALESCE(p.pay_amt, 0)` resolves to bare `pay_amount`, whose
    source expression is `SELECT SUM(pay_amount) FROM ods.ods_payment`.
    """
    if source is None:
        return None
    try:
        query = source if isinstance(source, exp.Expression) else None
        if query is None:
            return None
        tables = [t for t in query.find_all(exp.Table)]
        if len(tables) == 1:
            return _short_name(tables[0])
    except Exception:
        return None
    return None


_TRANSFORM_KEYWORDS = {
    "SUM", "COUNT", "AVG", "MIN", "MAX", "COLLECT_SET", "COLLECT_LIST",
    "GROUP_CONCAT", "LISTAGG", "ARRAY_AGG", "STRING_AGG", "WM_CONCAT",
    "STDDEV", "VARIANCE", "PERCENTILE", "MEDIAN", "FIRST", "LAST",
    "ROW_NUMBER", "RANK", "DENSE_RANK", "LAG", "LEAD", "NTILE",
}


def _classify_transform(expression: str | None) -> str:
    if not expression:
        return "direct"
    upper = expression.upper()
    if "CASE" in upper or "IF(" in upper or "IFNULL" in upper or "COALESCE" in upper or "NVL(" in upper:
        return "case"
    head = upper.split("(")[0].strip()
    if head in _TRANSFORM_KEYWORDS:
        return "aggregate"
    if "(" in upper:
        return "function"
    return "direct"


def _output_columns(ast) -> list[str]:
    query = ast
    if isinstance(ast, (exp.Insert, exp.Create)) and ast.expression is not None:
        query = ast.expression
    if isinstance(query, exp.Subquery):
        query = query.this
    while isinstance(query, (exp.Union, exp.Except, exp.Intersect)):
        query = query.this
    if not isinstance(query, exp.Select):
        return []
    names = []
    for projection in query.expressions:
        name = projection.alias_or_name
        if name:
            names.append(name)
    return names


def _target_of(ast):
    if isinstance(ast, exp.Insert):
        target = ast.this
    elif isinstance(ast, (exp.Create, exp.Merge, exp.Update, exp.Delete)):
        target = ast.this
    else:
        return None
    if isinstance(target, exp.Schema):
        target = target.this
    if isinstance(target, exp.Table):
        return target
    return None


_STATEMENT_TYPES = (
    exp.Query,  # Select / Union / Except / Intersect
    exp.Insert,
    exp.Create,
    exp.Update,
    exp.Delete,
    exp.Merge,
    exp.Drop,
    exp.Alter,
    exp.Command,
    # Administrative / DDL-ish statements that are legitimate SQL but carry no
    # lineage. Listing them keeps them out of the "not a statement" failure path.
    exp.Comment,
    exp.Copy,
    exp.TruncateTable,
    exp.Transaction,
    exp.Commit,
    exp.Rollback,
    exp.Grant,
    exp.Analyze,
    exp.Use,
    exp.MultitableInserts,  # Hive `FROM ... INSERT ... INSERT ...`
)


def _is_statement(ast) -> bool:
    """Guard against sqlglot accepting bare expressions as "valid SQL".

    `THIS IS NOT SQL` parses cleanly into `NOT THIS IS SQL` (an exp.Not), which
    is a valid expression but not a statement - analysing it would yield a
    silent empty graph instead of a visible failure.
    """
    return isinstance(ast, _STATEMENT_TYPES)


def _fallback_sources(names: list[str]) -> list[dict]:
    """Normalise regex-extracted table names into the SourceTable shape.

    The fallback path used to return bare strings while the AST path returned
    objects, which broke consumers that index ``["name"]``.
    """
    out = []
    for name in names:
        clean = str(name).strip().strip("`\"")
        if not clean:
            continue
        db, _, table = clean.rpartition(".")
        if not db:
            db, table = "", clean
        out.append(
            {
                "name": clean,
                "db": db,
                "table": table,
                "alias": "",
                "range": None,
            }
        )
    return out


def _normalise_punctuation(sql: str) -> tuple[str, list[str]]:
    """Turn full-width punctuation into ASCII so CN-authored SQL still parses.

    Chinese IMEs frequently emit `，` `；` `（）` — sqlglot only accepts the ASCII
    forms, which surfaced as "this simple INSERT does not parse".
    """
    replacements = {
        "，": ",",
        "；": ";",
        "（": "(",
        "）": ")",
        "：": ":",
        "＝": "=",
        "＂": '"',
        "＇": "'",
    }
    hits = {ch for ch in replacements if ch in sql}
    if not hits:
        return sql, []
    for ch, ascii_ch in replacements.items():
        sql = sql.replace(ch, ascii_ch)
    names = "、".join(sorted(hits))
    return sql, [f"已将全角标点 {names} 转为半角"]


_COMMON_TYPOS = {
    "fron": "from",
    "form": "from",
    "wher": "where",
    "seelct": "select",
    "selct": "select",
    "selec": "select",
    "gruop": "group",
    "gorup": "group",
    "odrer": "order",
    "partiton": "partition",
    "inser": "insert",
    "uptade": "update",
    "delet": "delete",
    "jion": "join",
    "tabel": "table",
    "tbale": "table",
}


def _suggest_typo(sql: str) -> str | None:
    """Spot a misspelled keyword so the error message is actionable."""
    lowered = sql.lower()
    for wrong, right in _COMMON_TYPOS.items():
        if re.search(rf"\b{wrong}\b", lowered):
            return f"疑似拼写错误：`{wrong}` 应为 `{right}`"
    return None


def _statement_kind(ast) -> str:
    if isinstance(ast, exp.Insert):
        return "insert"
    if isinstance(ast, exp.Create):
        return "create"
    if isinstance(ast, exp.Select):
        return "select"
    if isinstance(ast, exp.Update):
        return "update"
    if isinstance(ast, exp.Merge):
        return "merge"
    if isinstance(ast, exp.Delete):
        return "delete"
    if isinstance(ast, exp.Command):
        return "command"
    return "other"


_SQL_KEYWORDS_LOWER = {
    "select", "from", "where", "group", "order", "having", "limit", "union",
    "join", "left", "right", "inner", "outer", "on", "as", "with", "insert",
    "into", "table", "values", "set", "partition", "overwrite", "create",
}

_INSERT_RE = re.compile(
    r"\bINSERT\s+(?:OVERWRITE\s+)?(?:INTO\s+)?(?:TABLE\s+)?([\w.`\"$]+)", re.I
)
_REPLACE_RE = re.compile(r"\bREPLACE\s+INTO\s+([\w.`\"$]+)", re.I)
_CREATE_RE = re.compile(
    r"\bCREATE\s+(?:EXTERNAL\s+)?(?:TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w.`\"$]+)",
    re.I,
)
_FROM_RE = re.compile(r"\b(?:FROM|JOIN)\s+([\w.`\"$]+)", re.I)


def _fallback_extract(sql: str) -> dict:
    """Last-resort regex extraction used when sqlglot yields no AST.

    Keywords are filtered out so `INSERT INTO TABLE SELECT ...` does not report
    "select" as a table name.
    """
    target = None
    for pattern in (_REPLACE_RE, _INSERT_RE, _CREATE_RE):
        match = pattern.search(sql)
        if match:
            candidate = match.group(1).strip("`\"")
            if candidate.lower() in _SQL_KEYWORDS_LOWER:
                continue
            target = candidate
            break

    sources = []
    for match in _FROM_RE.finditer(sql):
        name = match.group(1).strip("`\"")
        if not name or name.lower() in _SQL_KEYWORDS_LOWER:
            continue
        if name not in sources:
            sources.append(name)
    return {"target": target, "sources": sources}


def _analyze_multitable(
    ast,
    slice_info: dict,
    processed: str,
    param_map: dict[str, str],
    pre_notes: list[str],
) -> dict:
    """Expand `FROM src INSERT ... INSERT ...` into per-target table edges.

    sqlglot's MultitableInserts carries the shared source plus child Insert
    nodes; each child gets the same source table but its own target.
    """
    sources = []
    edges = []
    targets = []

    source_node = ast.args.get("source")
    for child in ast.args.get("expressions") or []:
        target_node = _target_of(child)
        if target_node is None:
            continue
        target_name = _restore_in_name(_short_name(target_node), param_map)
        targets.append(target_name)
        if source_node is not None and isinstance(source_node, exp.Table):
            source_name = _restore_in_name(_short_name(source_node), param_map)
            if source_name and source_name not in [s["name"] for s in sources]:
                mt_range = _range_from_meta(source_node.this, processed)
                if mt_range is not None:
                    mt_range["line"] = (mt_range.get("line") or 1) + (
                        slice_info.get("startLine", 1) - 1
                    )
                sources.append(
                    {
                        "name": source_name,
                        "db": _restore_in_name(source_node.db or "", param_map),
                        "table": _restore_in_name(source_node.name, param_map),
                        "alias": "",
                        "range": mt_range,
                    }
                )
            edges.append({"source": source_name, "target": target_name, "kind": "table"})

    return {
        "index": slice_info["index"],
        "slice": slice_info,
        "kind": "multitable_insert",
        "status": "ok",
        "target": targets[0] if targets else None,
        "targets": targets,
        "sources": sources,
        "edges": edges,
        "columns": [],
        "warnings": [],
        "notes": pre_notes + [f"多表写入：一次读 {len(sources)} 张源表，写 {len(targets)} 张目标表"],
    }


# ---------------------------------------------------------------- core analysis

def _analyze_statement(slice_info: dict, payload: dict) -> dict:
    sql = slice_info["text"]
    dialect = payload["sqlglotDialect"]
    dialect_id = payload["dialectId"]
    schema = payload.get("schema") or {}
    options = payload.get("options") or {}

    processed, pre_notes, param_map = preprocess(sql, dialect_id)
    warnings: list[str] = []

    if _PLSQL_BLOCK.match(processed):
        return {
            "index": slice_info["index"],
            "slice": slice_info,
            "kind": "plsql_block",
            "status": "unsupported",
            "target": None,
            "sources": [],
            "edges": [],
            "columns": [],
            "warnings": warnings + ["PL/SQL 匿名块不支持静态分析"],
            "notes": pre_notes,
        }

    try:
        ast = sqlglot.parse_one(processed, dialect=dialect)
    except Exception as exc:
        fallback = _fallback_extract(sql)
        typo = _suggest_typo(sql)
        messages = [f"解析失败: {str(exc).splitlines()[0][:160]}"]
        if typo:
            messages.append(typo)
        return {
            "index": slice_info["index"],
            "slice": slice_info,
            "kind": "error",
            "status": "failed",
            "target": fallback["target"],
            "sources": _fallback_sources(fallback["sources"]),
            "edges": [
                {"source": s, "target": fallback["target"], "kind": "table"}
                for s in fallback["sources"]
                if fallback["target"]
            ],
            "columns": [],
            "warnings": warnings + messages,
            "notes": pre_notes,
        }

    if not _is_statement(ast):
        fallback = _fallback_extract(sql)
        return {
            "index": slice_info["index"],
            "slice": slice_info,
            "kind": "expression",
            "status": "failed",
            "target": fallback["target"],
            "sources": _fallback_sources(fallback["sources"]),
            "edges": [
                {"source": s, "target": fallback["target"], "kind": "table"}
                for s in fallback["sources"]
                if fallback["target"]
            ],
            "columns": [],
            "warnings": warnings
            + [f"不是可分析的 SQL 语句（被解析为表达式 {type(ast).__name__}）"],
            "notes": pre_notes,
        }

    if isinstance(ast, exp.Command):
        fallback = _fallback_extract(sql)
        return {
            "index": slice_info["index"],
            "slice": slice_info,
            "kind": "command",
            "status": "degraded",
            "target": fallback["target"],
            "sources": _fallback_sources(fallback["sources"]),
            "edges": [
                {"source": s, "target": fallback["target"], "kind": "table"}
                for s in fallback["sources"]
                if fallback["target"]
            ],
            "columns": [],
            "warnings": warnings + ["该语句未生成 AST，已降级为正则抽取（仅表级）"],
            "notes": pre_notes,
        }

    # Hive `FROM src INSERT ... INSERT ...` writes one source into many tables.
    # sqlglot models it as MultitableInserts, which owns no lineage of its own.
    if isinstance(ast, exp.MultitableInserts):
        return _analyze_multitable(ast, slice_info, processed, param_map, pre_notes)

    kind = _statement_kind(ast)
    target_node = _target_of(ast)
    target = _short_name(target_node) if target_node is not None else None

    # `INSERT INTO TABLE SELECT ...` (missing table name) parses without error but
    # the target ends up being the SELECT itself. Report it instead of silently
    # producing an empty graph.
    if kind in ("insert", "create", "merge", "update", "delete"):
        raw_this = getattr(ast, "this", None)
        looks_like_query = isinstance(raw_this, (exp.Select, exp.Subquery, exp.Union))
        if target is None or looks_like_query:
            fallback = _fallback_extract(sql)
            return {
                "index": slice_info["index"],
                "slice": slice_info,
                "kind": kind,
                "status": "failed",
                "target": None,
                "sources": _fallback_sources(fallback["sources"]),
                "edges": [],
                "columns": [],
                "warnings": warnings
                + [
                    "缺少目标表名：`INSERT INTO TABLE` 后面需要跟表名，"
                    "当前写法无法确定写入哪张表",
                ],
                "notes": pre_notes,
            }

    # A bare SELECT has no target table; give the result set a synthetic node so
    # column lineage still works when the user analyses a selected fragment.
    pseudo_target = None
    if target is None and kind == "select" and _output_columns(ast):
        pseudo_target = "(query result)"
        target = pseudo_target

    alias_map = _collect_alias_map(ast)
    cte_names = {c.alias_or_name.lower() for c in ast.find_all(exp.CTE)}

    sources = []
    seen = set()
    for scope in traverse_scope(ast):
        for alias, source in scope.sources.items():
            node = source[0] if isinstance(source, tuple) else source
            if not isinstance(node, exp.Table):
                continue
            name = _restore_in_name(_short_name(node), param_map)
            is_cte = bool(alias and alias.lower() in cte_names and not node.db)
            if is_cte:
                continue
            if name == _restore_in_name(target, param_map):
                continue
            key = name.lower()
            if key in seen:
                continue
            seen.add(key)
            # `sql` here is one statement slice, so the reported line is relative
            # to the statement. Shift it into document coordinates, otherwise a
            # click scrolls to line 3 instead of the source's real line.
            src_range = _range_from_meta(node.this, sql)
            if src_range is not None:
                src_range["line"] = (src_range.get("line") or 1) + (
                    slice_info.get("startLine", 1) - 1
                )
            sources.append(
                {
                    "name": name,
                    "db": _restore_in_name(node.db or "", param_map),
                    "table": _restore_in_name(node.name, param_map),
                    "alias": alias or "",
                    "range": src_range,
                }
            )

    edges = []
    columns = []
    if target and options.get("includeColumnLineage", True):
        out_columns = _output_columns(ast)
        for column in out_columns:
            try:
                node = sqlglot_lineage(
                    column,
                    processed,
                    schema=schema,
                    dialect=dialect,
                    trim_selects=True,
                )
            except Exception as exc:  # one bad column must not kill the statement
                detail = str(exc)[:80]
                if column == "*" or "*" in column:
                    # Without metadata there is no way to expand `*`; that is a
                    # known limitation, not a parse failure.
                    pre_notes.append("`SELECT *` 需要表结构元数据才能展开列，已跳过")
                else:
                    warnings.append(f"列 {column} 血缘追溯失败: {detail}")
                columns.append({"name": column, "edges": [], "expression": None})
                continue

            col_edges = []
            entry = {
                "name": column,
                "expression": None,
                "transform": "direct",
            }

            def walk(current, depth=0, scope_source=None):
                if depth == 0:
                    expression = getattr(current, "expression", None)
                    if expression is not None:
                        try:
                            entry["expression"] = _restore_in_name(
                                expression.sql(dialect=dialect), param_map
                            )
                        except Exception:
                            entry["expression"] = None
                if not current.downstream:
                    source_table, source_column = _resolve_leaf(current.name, alias_map)
                    if source_table == "<unknown>" and scope_source is not None:
                        source_table = _single_table_of(scope_source, dialect)
                    if source_table and source_table != "<unknown>":
                        col_edges.append(
                            {
                                "sourceTable": _restore_in_name(source_table, param_map),
                                "sourceColumn": source_column,
                                "targetTable": target,
                                "targetColumn": column,
                                "transform": _classify_transform(entry["expression"]),
                                "expression": entry["expression"],
                            }
                        )
                next_source = getattr(current, "source", None) or scope_source
                for child in current.downstream:
                    walk(child, depth + 1, next_source)

            walk(node)
            entry["transform"] = _classify_transform(entry["expression"])
            entry["edges"] = col_edges
            columns.append(entry)
            edges.extend(col_edges)

    status = "degraded" if warnings else "ok"
    restored_target = _restore_in_name(target, param_map) if target else target
    return {
        "index": slice_info["index"],
        "slice": slice_info,
        "kind": kind,
        "status": status,
        "target": restored_target,
        "sources": sources,
        "edges": [
            {"source": s["name"], "target": restored_target, "kind": "table"}
            for s in sources
        ] if restored_target else [],
        "columns": columns,
        "warnings": warnings,
        "notes": pre_notes,
    }


def analyze(payload_json: str) -> str:
    started = time.perf_counter()
    try:
        payload = json.loads(payload_json)
        sql = payload.get("sql") or ""
        max_statements = (payload.get("options") or {}).get("maxStatements", 500)

        # Full-width punctuation must be normalised *before* splitting, because
        # `；` acts as a statement separator.
        sql, punctuation_notes = _normalise_punctuation(sql)

        slices = split_statements(sql)
        if len(slices) > max_statements:
            return json.dumps(
                {
                    "ok": False,
                    "error": f"语句数 {len(slices)} 超过上限 {max_statements}",
                    "statements": [],
                    "graph": {"nodes": [], "edges": []},
                    "stats": {},
                }
            )

        statements = []
        for index, slice_info in enumerate(slices):
            slice_info = dict(slice_info)
            slice_info["index"] = index
            result = _analyze_statement(slice_info, payload)
            if punctuation_notes:
                result["notes"] = punctuation_notes + result.get("notes", [])
            statements.append(result)

        graph = _build_graph(statements)
        failed = sum(1 for s in statements if s["status"] == "failed")
        degraded = sum(1 for s in statements if s["status"] == "degraded")

        return json.dumps(
            {
                "ok": True,
                "statements": statements,
                "graph": graph,
                "stats": {
                    "parseMs": round((time.perf_counter() - started) * 1000, 2),
                    "statementCount": len(statements),
                    "failedCount": failed,
                    "degradedCount": degraded,
                    "tableCount": len(graph["nodes"]),
                    "edgeCount": len(graph["edges"]),
                    "columnEdgeCount": len(graph["columnEdges"]),
                },
            }
        )
    except Exception as exc:
        return json.dumps(
            {
                "ok": False,
                "error": f"{type(exc).__name__}: {exc}",
                "statements": [],
                "graph": {"nodes": [], "edges": []},
                "stats": {},
            }
        )


def _build_graph(statements: list[dict]) -> dict:
    nodes: dict[str, dict] = {}
    table_edges: dict[tuple, dict] = {}

    def touch(
        name: str | None,
        role: str,
        status: str,
        statement_index: int,
        line: int | None = None,
        char_range: dict | None = None,
    ):
        if not name:
            return
        entry = nodes.get(name)
        statuses = ["ok", "degraded", "failed", "unsupported"]
        if entry is None:
            nodes[name] = {
                "id": name,
                "label": name,
                "db": name.rsplit(".", 1)[0] if "." in name else "",
                "table": name.rsplit(".", 1)[-1],
                "roles": [role],
                "status": status,
                "statements": [statement_index],
                "synthetic": name.startswith("("),
                # Where to jump when the user clicks this node in the graph.
                "line": line,
                "charRange": char_range,
            }
            return
        if role not in entry["roles"]:
            entry["roles"].append(role)
        if statement_index not in entry["statements"]:
            entry["statements"].append(statement_index)
        if entry.get("line") is None and line is not None:
            entry["line"] = line
            entry["charRange"] = char_range
        if statuses.index(status) > statuses.index(entry["status"]):
            entry["status"] = status

    for statement in statements:
        index = statement["index"]
        status = statement["status"]
        start_line = (statement.get("slice") or {}).get("startLine")
        # Multi-table writes list every target in `targets`; single-target
        # statements only carry `target`.
        for target_name in statement.get("targets") or [statement.get("target")]:
            touch(target_name, "target", status, index, start_line, None)
        for source in statement.get("sources", []):
            if isinstance(source, dict):
                # Prefer the table reference's own position so clicking a source
                # node lands on the table name, not the statement header.
                loc = source.get("range") or {}
                line = loc.get("line") or start_line
                char_range = (
                    {"start": loc["col"], "end": loc.get("colEnd", loc["col"])}
                    if "col" in loc
                    else None
                )
                touch(source.get("name"), "source", status, index, line, char_range)
            else:
                touch(source, "source", status, index, start_line, None)

        for edge in statement.get("edges", []):
            source = edge.get("source")
            target = edge.get("target")
            if not source or not target:
                continue
            key = (source, target)
            existing = table_edges.get(key)
            if existing:
                if index not in existing["statements"]:
                    existing["statements"].append(index)
                continue
            table_edges[key] = {
                "id": f"{source}->{target}",
                "source": source,
                "target": target,
                "kind": "table",
                "statements": [index],
                "status": status,
            }

    for statement in statements:
        for column in statement.get("columns", []):
            for edge in column.get("edges", []):
                touch(edge["sourceTable"], "source", statement["status"], statement["index"])

    return {
        "nodes": list(nodes.values()),
        "edges": list(table_edges.values()),
        "columnEdges": [
            edge
            for statement in statements
            for column in statement.get("columns", [])
            for edge in column.get("edges", [])
        ],
    }
