#!/usr/bin/env tsx

/**
 * One-time migration: split monolithic locale files into per-namespace files.
 *
 *   lib/i18n/locales/en.ts    →  lib/i18n/locales/en/<namespace>.ts  +  en/index.ts
 *   lib/i18n/locales/nl.ts    →  lib/i18n/locales/nl/<namespace>.ts  +  nl/index.ts
 *
 * Preserves source formatting verbatim by extracting initializer text via
 * ts.SourceFile.getText() at the property's range. The barrel `index.ts`
 * is generated and ends with `as const` so `typeof en` inference is preserved.
 *
 * Run from apps/web/platform:
 *   pnpm tsx scripts/split-locales.ts
 */

import fs from 'fs';
import path from 'path';
import ts from 'typescript';

interface SplitResult {
  locale: 'en' | 'nl';
  outDir: string;
  namespaces: string[];
}

function unwrapAsConst(node: ts.Expression): ts.Expression {
  if (ts.isAsExpression(node)) return unwrapAsConst(node.expression);
  if (ts.isSatisfiesExpression?.(node)) return unwrapAsConst(node.expression);
  if (ts.isParenthesizedExpression(node)) return unwrapAsConst(node.expression);
  return node;
}

function splitLocale(locale: 'en' | 'nl', baseDir: string): SplitResult {
  const sourcePath = path.join(baseDir, `${locale}.ts`);
  const src = fs.readFileSync(sourcePath, 'utf-8');
  const sf = ts.createSourceFile(`${locale}.ts`, src, ts.ScriptTarget.ESNext, true);

  let objLiteral: ts.ObjectLiteralExpression | undefined;

  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue;
      if (decl.name.text !== locale) continue;
      if (!decl.initializer) continue;
      const expr = unwrapAsConst(decl.initializer);
      if (ts.isObjectLiteralExpression(expr)) objLiteral = expr;
    }
  }

  if (!objLiteral) {
    throw new Error(`Could not find object literal for export const ${locale} in ${sourcePath}`);
  }

  const outDir = path.join(baseDir, locale);
  fs.mkdirSync(outDir, { recursive: true });

  const namespaces: string[] = [];

  for (const prop of objLiteral.properties) {
    if (!ts.isPropertyAssignment(prop)) {
      throw new Error(`Unexpected property kind ${ts.SyntaxKind[prop.kind]} in ${locale}.ts`);
    }
    let name: string;
    if (ts.isIdentifier(prop.name)) name = prop.name.text;
    else if (ts.isStringLiteral(prop.name)) name = prop.name.text;
    else throw new Error(`Unsupported property name kind in ${locale}.ts`);

    const valueText = prop.initializer.getText(sf);
    const outPath = path.join(outDir, `${name}.ts`);
    // No `as const` — the original monolithic en.ts / nl.ts inferred wide string
    // types, and adding `as const` would make `typeof en` literal-narrow (e.g.,
    // `'Save'` not `string`), which is unsound when nl provides different
    // literal values at runtime.
    const content = `export const ${name} = ${valueText};\n`;
    fs.writeFileSync(outPath, content);
    namespaces.push(name);
  }

  // Barrel — also without `as const`, matching the original monolithic shape.
  const importLines = namespaces.map(ns => `import { ${ns} } from './${ns}';`).join('\n');
  const exportObject = `{\n  ${namespaces.join(',\n  ')},\n}`;
  const barrel = `${importLines}\n\nexport const ${locale} = ${exportObject};\n`;
  fs.writeFileSync(path.join(outDir, 'index.ts'), barrel);

  return { locale, outDir, namespaces };
}

function main() {
  const baseDir = path.resolve(__dirname, '../lib/i18n/locales');
  if (!fs.existsSync(baseDir)) {
    throw new Error(`Locales dir not found at ${baseDir}`);
  }

  for (const locale of ['en', 'nl'] as const) {
    const result = splitLocale(locale, baseDir);
    console.log(
      `✓ Split ${locale}: ${result.namespaces.length} namespaces → ${path.relative(process.cwd(), result.outDir)}`
    );
    console.log(`  ${result.namespaces.join(', ')}`);
  }

  console.log('\nNext: verify the split with tsc, then delete the monolithic en.ts / nl.ts.');
}

main();
