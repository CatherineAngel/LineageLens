/**
 * Unit tests for the formatter post-processing transforms.
 *
 * These encode the five formatting requirements the user asked for, so a
 * regression in any transform fails loudly.
 *
 * Run with: npx tsx src/formatterTransforms.test.ts   (or via npm test)
 */
import {
  expandCreateColumns,
  joinInsertTarget,
  leadingCommas,
  normalizeSchemaCase,
  semicolonOnOwnLine,
} from "./formatterTransforms";

let failures = 0;

function check(label: string, actual: string, expected: string) {
  if (actual === expected) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${label}`);
  console.log(`     expected: ${JSON.stringify(expected)}`);
  console.log(`     actual:   ${JSON.stringify(actual)}`);
}

console.log("1. INSERT INTO 后紧接表名");
check(
  "INTO 换行被合并",
  joinInsertTarget("INSERT INTO\n  db.dws_t\nSELECT\n  a"),
  "INSERT INTO db.dws_t\nSELECT\n  a",
);
check(
  "OVERWRITE TABLE 换行被合并",
  joinInsertTarget("INSERT\n  OVERWRITE TABLE ${Schema}.t\nSELECT 1"),
  "INSERT OVERWRITE TABLE ${Schema}.t\nSELECT 1",
);
check(
  "无换行时不变",
  joinInsertTarget("INSERT INTO db.t SELECT 1"),
  "INSERT INTO db.t SELECT 1",
);

console.log("\n2. 逗号移到行首");
check(
  "两列",
  leadingCommas("CREATE TABLE t (\n  a INT,\n  b INT\n)"),
  "CREATE TABLE t (\n  a INT\n  , b INT\n)",
);
check(
  "SELECT 投影",
  leadingCommas("SELECT\n  a,\n  b,\n  c\nFROM t"),
  "SELECT\n  a\n  , b\n  , c\nFROM t",
);
check(
  "最后一项无逗号",
  leadingCommas("SELECT\n  a\nFROM t"),
  "SELECT\n  a\nFROM t",
);

console.log("\n3. 建表字段分行");
check(
  "内联三列被拆开",
  expandCreateColumns("CREATE TABLE db.t (id BIGINT, name VARCHAR(20), amt DECIMAL(18, 2))"),
  "CREATE TABLE db.t (\n  id BIGINT,\n  name VARCHAR(20),\n  amt DECIMAL(18, 2)\n)",
);
check(
  "嵌套括号不被拆",
  expandCreateColumns("CREATE TABLE db.t (amt DECIMAL(18, 2), name VARCHAR(20))"),
  "CREATE TABLE db.t (\n  amt DECIMAL(18, 2),\n  name VARCHAR(20)\n)",
);
check(
  "已分行则不重复处理",
  expandCreateColumns("CREATE TABLE db.t (\n  id BIGINT\n)"),
  "CREATE TABLE db.t (\n  id BIGINT\n)",
);

console.log("\n4. 库名大小写");
check(
  "FROM 后库名转大写",
  normalizeSchemaCase("FROM db.t1", "upper"),
  "FROM DB.t1",
);
check(
  "\${Schema} 模板不受影响",
  normalizeSchemaCase("FROM ${Schema}.t1", "upper"),
  "FROM ${Schema}.t1",
);
check(
  "JOIN 后库名转小写",
  normalizeSchemaCase("JOIN Dim.City c", "lower"),
  "JOIN dim.City c",
);
check(
  "preserve 模式原样返回",
  normalizeSchemaCase("FROM db.t", "preserve"),
  "FROM db.t",
);

console.log("\n5. 分号单独成行");
check(
  "语句末尾分号下移",
  semicolonOnOwnLine("SELECT 1;"),
  "SELECT 1\n;",
);
check(
  "无分号不变",
  semicolonOnOwnLine("SELECT 1"),
  "SELECT 1",
);

console.log();
if (failures > 0) {
  // Throwing keeps the exit code non-zero without depending on @types/node,
  // which this browser-targeted project does not include.
  throw new Error(`${failures} formatter transform test(s) failed`);
}
console.log("all formatter transform tests passed");
