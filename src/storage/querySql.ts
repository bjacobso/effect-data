import type { SqlClient, Statement } from "effect/sql";
import type { CellColumn, CellTypes } from "../core/cellTypes.ts";
import type { Condition, Rule, Value } from "../core/model.ts";
import { cellDate } from "./cells.ts";

type Fragment = Statement.Fragment;
type Seed = {
  statement: Fragment;
  exact: boolean;
  rank: number;
  ordered?: { attribute: string; statement: Fragment };
};
type Predicate = { boolean: Fragment; yes?: Seed; no?: Seed };

export function querySql(sql: SqlClient.SqlClient, account: string, shape: string, types: CellTypes) {
  const column = (name: CellColumn) => sql`c.${sql(name)}`;
  const cast = (parameter: Fragment, name: CellColumn) => {
    switch (name) {
      case "s":
        return sql`${parameter}::text COLLATE "C"`;
      case "n":
        return sql`${parameter}::numeric`;
      case "b":
        return sql`${parameter}::boolean`;
      case "d":
        return sql`${parameter}::date`;
    }
  };
  const parameter = (value: Value, name: CellColumn) =>
    cast(sql`${name === "d" ? cellDate(String(value)) : name === "n" ? String(value) : value}`, name);
  const lookup = (attribute: string) =>
    sql`FROM cells c WHERE c.account_id=${account} AND c.entity_id=e.id COLLATE "C" AND c.attribute=${attribute}`;
  const orderValue = (attribute: string) => sql`(SELECT ${column(types.get(attribute)!.column)} ${lookup(attribute)})`;

  function leaf(node: Condition): Predicate {
    const { column: name, fold } = types.get(node.fact)!;
    const raw = column(name);
    const ignoreCase = fold && node.ignore_case;
    const value = ignoreCase ? sql`coalesce(c.folded,c.s)` : raw;
    const normalize = (x: Value) => (ignoreCase && typeof x === "string" ? x.toLowerCase() : x);
    const prefix = sql`left(${value},384)`;
    const seed = (filter: Fragment, rank: number, ordered = false): Seed => {
      const source = sql`FROM cells c
        WHERE c.account_id=${account} AND c.attribute=${node.fact} AND c.shape=${shape} AND ${filter}`;
      return {
        statement: sql`SELECT c.entity_id ${source}`,
        exact: true,
        rank,
        ...(ordered &&
          (name === "n" || name === "d") && {
            ordered: { attribute: node.fact, statement: sql`SELECT c.entity_id,${raw} AS sort_value ${source}` },
          }),
      };
    };

    if (node.operator === "exists" || node.operator === "doesNotExist") {
      const present = sql`EXISTS (SELECT 1 ${lookup(node.fact)})`;
      const candidates = seed(sql`TRUE`, 4);
      return node.operator === "exists" ? { boolean: present, yes: candidates } : { boolean: sql`NOT ${present}`, no: candidates };
    }

    let yes: Fragment,
      no: Fragment,
      indexFilter: Fragment | undefined,
      inverse = false,
      rank = 2;
    if (node.operator === "in" || node.operator === "notIn") {
      const list = (node.value as Value[]).map(normalize);
      const encoded = JSON.stringify(name === "d" ? list.map((x) => cellDate(String(x))) : list);
      const members = sql`jsonb_array_elements_text(${encoded}::jsonb) AS operand(v)`;
      yes = sql`${value} IN (SELECT ${cast(sql`v`, name)} FROM ${members})`;
      no = sql`NOT (${yes})`;
      indexFilter = name === "s" ? sql`${prefix} IN (SELECT left(v,384) COLLATE "C" FROM ${members})` : undefined;
      inverse = node.operator === "notIn";
      rank = 1;
    } else {
      const normalized = normalize(node.value as Value);
      const operand = parameter(normalized, name);
      switch (node.operator) {
        case "equal":
        case "notEqual":
          yes = sql`${value} = ${operand}`;
          no = sql`${value} <> ${operand}`;
          indexFilter = name === "s" ? sql`${prefix} = left(${operand},384)` : undefined;
          inverse = node.operator === "notEqual";
          rank = 0;
          break;
        case "contains":
        case "doesNotContain":
          yes = sql`strpos(${value},${operand}) > 0`;
          no = sql`strpos(${value},${operand}) = 0`;
          inverse = node.operator === "doesNotContain";
          rank = 3;
          break;
        case "lessThan":
          yes = sql`${value} < ${operand}`;
          no = sql`${value} >= ${operand}`;
          break;
        case "lessThanInclusive":
          yes = sql`${value} <= ${operand}`;
          no = sql`${value} > ${operand}`;
          break;
        case "greaterThan":
          yes = sql`${value} > ${operand}`;
          no = sql`${value} <= ${operand}`;
          break;
        case "greaterThanInclusive":
          yes = sql`${value} >= ${operand}`;
          no = sql`${value} < ${operand}`;
          break;
        default:
          throw new Error(`Unexpected query operator: ${node.operator}`);
      }
    }
    const present = sql`${raw} IS NOT NULL AND NOT c.exceptional ${node.fact.length <= 768 ? sql`AND octet_length(c.attribute)<=768` : sql``}`;
    const positive = seed(indexFilter ? sql`${present} AND ${indexFilter} AND ${yes}` : sql`${present} AND ${yes}`, rank, true);
    // Prefer scanning in entity-id order for broad complements of equality
    // and membership. Range complements can use the same typed index.
    const negative = seed(sql`${present} AND ${no}`, Math.max(2, rank + 1), true);
    return {
      boolean: sql`(SELECT ${inverse ? no : yes} ${lookup(node.fact)})`,
      yes: inverse ? negative : positive,
      no: inverse ? positive : negative,
    };
  }

  const intersect = (seeds: (Seed | undefined)[]) => {
    const best = seeds.flatMap((seed) => (seed ? [seed] : [])).sort((a, b) => a.rank - b.rank)[0];
    return best && { ...best, exact: best.exact && seeds.length === 1 };
  };
  const union = (seeds: (Seed | undefined)[]): Seed | undefined =>
    seeds.length && seeds.every((seed) => seed !== undefined)
      ? { statement: sql.join(" UNION ")(seeds.map((seed) => seed.statement)), exact: seeds.every((seed) => seed.exact), rank: 2 }
      : undefined;

  function compile(rule: Rule): Predicate {
    if (typeof rule === "boolean") return { boolean: rule ? sql`TRUE` : sql`FALSE` };
    if ("not" in rule) {
      const child = compile(rule.not);
      return { boolean: sql`NOT (${child.boolean})`, ...(child.yes && { no: child.yes }), ...(child.no && { yes: child.no }) };
    }
    if ("all" in rule || "any" in rule) {
      const all = "all" in rule;
      const children = (all ? rule.all : rule.any).map(compile);
      if (!children.length) return compile(all);
      const yes = (all ? intersect : union)(children.map((child) => child.yes));
      const no = (all ? union : intersect)(children.map((child) => child.no));
      return {
        boolean: sql.join(all ? " AND " : " OR ")(children.map((child) => sql`(${child.boolean})`)),
        ...(yes && { yes }),
        ...(no && { no }),
      };
    }
    return leaf(rule);
  }

  return { compile, orderValue, parameter };
}
