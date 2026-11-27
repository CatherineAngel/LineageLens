/**
 * Post-processing that sql-formatter does not provide natively.
 *
 * Everything here is a line/token transform over already-formatted SQL, so it
 * never rewrites string literals or comments - sql-formatter kept those intact
 * and we only touch structural whitespace and commas.
 */

/** Strip a trailing comma from a line, returning [newLine, movedComma]. */
function splitTrailingComma(line: string): [string, boolean] {
  const match = /,\s*$/.exec(line);
  if (!match) return [line, false];
  return [line.slice(0, match.index), true];
}

/**
 * Collapse `INSERT INTO\n  schema.table` into `INSERT INTO schema.table`.
 *
 * sql-formatter always breaks after INSERT INTO. Keeping the target on the same
 * line makes the write target obvious, which matters in ETL files where several
 * INSERTs are stacked.
 */
export function joinInsertTarget(text: string): string {
  // Keyword gaps use `[ \t]+` rather than `\s+`: a `\s+` would swallow the very
  // newline this transform is looking for.
  return text.replace(
    /^(INSERT(?:[ \t]+OVERWRITE)?(?:[ \t]+INTO)?(?:[ \t]+TABLE)?)[ \t]*\n[ \t]+(\S.*)$/gim,
    (_match, head: string, target: string) => `${head.trimEnd()} ${target.trim()}`,
  );
}

/**
 * Move trailing commas to the start of the following line.
 *
 * Applies to any indented list: CREATE TABLE columns and SELECT projections both
 * end up one-per-line after formatting, so the same rule covers both. A comma
 * that is the last line of a block (nothing indented after it) stays put.
 */
export function leadingCommas(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const next = lines[i + 1];

    if (next === undefined) {
      result.push(line);
      continue;
    }

    const [stripped, hadComma] = splitTrailingComma(line);
    // The next line must be an indented sibling: same indent level and not a
    // comment, so a comma is never pulled across a closing paren or new clause.
    const nextIsItem = /^\s+\S/.test(next) && !/^\s*(--|\/\*)/.test(next);

    if (!hadComma || !nextIsItem) {
      result.push(line);
      continue;
    }

    result.push(stripped);
    lines[i + 1] = next.replace(/^(\s*)/, "$1, ");
  }

  return result.join("\n");
}

/**
 * Force a one-line CREATE TABLE column list onto separate lines.
 *
 * sql-formatter keeps `CREATE TABLE t (a int, b int)` inline unless the line
 * exceeds `expressionWidth`, which makes DDL formatting unpredictable. This
 * rewrites only the parenthesised column list, respecting nested parentheses
 * (`decimal(18, 2)`) so it is not split.
 */
export function expandCreateColumns(text: string): string {
  return text.replace(
    /\b(CREATE\s+(?:EXTERNAL\s+)?(?:TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[^\n(]+)\(([^()\n]*(?:\([^()\n]*\)[^()\n]*)*)\)/gi,
    (match, head: string, body: string) => {
      // Only split genuine column definitions (contain a space); a single
      // expression like `(SELECT ...)` or `(id)` is left alone.
      const columns = splitTopLevel(body);
      if (columns.length < 2 || !columns.some((c) => /\s/.test(c.trim()))) return match;

      const indented = columns.map((col) => `  ${col.trim()}`).join(",\n");
      return `${head.trimEnd()} (\n${indented}\n)`;
    },
  );
}

/** Split on commas that are not inside parentheses. */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";

  for (const ch of body) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/**
 * Uppercase or lowercase schema qualifiers of table references.
 *
 * `${Schema}` templates are left untouched: they are environment parameters
 * whose spelling the user controls, and casing them would break the template.
 */
export function normalizeSchemaCase(
  text: string,
  mode: "upper" | "lower" | "preserve",
): string {
  if (mode === "preserve") return text;

  const apply = (value: string) => (mode === "upper" ? value.toUpperCase() : value.toLowerCase());

  return text.replace(
    /\b(FROM|JOIN|INTO|TABLE|UPDATE|OVERWRITE\s+TABLE)\s+(\$\{[^}]+\}|#\{[^}]+\}|\{\{[^}]+\}\}|[A-Za-z_][\w$]*)(\s*\.)/gi,
    (_match, keyword: string, schema: string, dot: string) => {
      if (/^[$#{]/.test(schema)) return `${keyword} ${schema}${dot}`;
      return `${keyword} ${apply(schema)}${dot}`;
    },
  );
}

/** Ensure every statement ends with a semicolon on its own line. */
export function semicolonOnOwnLine(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trimEnd();
      if (!trimmed.endsWith(";")) return line;
      return `${trimmed.slice(0, -1).trimEnd()}\n;`;
    })
    .join("\n");
}
