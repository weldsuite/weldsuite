/**
 * Identifier and literal quoting. Table and column names are read from the
 * catalog at runtime and interpolated into SQL text, so every one of them goes
 * through here.
 */

/** Schema all tenant tables live in. */
export const TENANT_SCHEMA = 'public';

/** Quote an identifier: wrap in double quotes and double any embedded quote. */
export function quoteIdent(name: string): string {
  if (name.includes('\0')) throw new Error('Identifier contains a NUL byte');
  return `"${name.replaceAll('"', '""')}"`;
}

/** Quote a string literal (standard_conforming_strings assumed on, which is the Postgres default). */
export function quoteLiteral(value: string): string {
  if (value.includes('\0')) throw new Error('Literal contains a NUL byte');
  return `'${value.replaceAll("'", "''")}'`;
}

/** `"public"."table"` */
export function qualifiedTable(name: string): string {
  return `${quoteIdent(TENANT_SCHEMA)}.${quoteIdent(name)}`;
}

/** `"a", "b", "c"` */
export function quoteIdentList(names: readonly string[]): string {
  return names.map(quoteIdent).join(', ');
}
