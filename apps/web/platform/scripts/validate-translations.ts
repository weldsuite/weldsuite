#!/usr/bin/env tsx

/**
 * Migration Script: Validate Translations
 *
 * Validates that every locale under packages/core/i18n/src/locales/ has parity
 * with the source locale (English). Detects missing keys, untranslated
 * strings, type mismatches, structural inconsistencies.
 *
 * Usage:
 *   pnpm tsx scripts/validate-translations.ts [options]
 *
 * Options:
 *   --fix              Emit non-destructive patch files (per locale) listing
 *                      missing keys and orphans (no in-place rewrites).
 *   --strict           Fail on warnings as well as errors.
 *   --report <file>    Save the validation report to a JSON file.
 *   --source <locale>  Source-of-truth locale (default: en).
 */

import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'node:url';

const SOURCE_DEFAULT = 'en';

interface ValidationIssue {
  type: 'error' | 'warning' | 'info';
  category: 'missing_key' | 'untranslated' | 'structure' | 'type_mismatch' | 'empty_value';
  path: string;
  message: string;
  suggestion?: string;
}

interface ValidationReport {
  timestamp: string;
  status: 'pass' | 'fail';
  source: string;
  summary: {
    totalKeys: Record<string, number>;
    errors: number;
    warnings: number;
    info: number;
  };
  issues: ValidationIssue[];
}

function findLocalesDir(): string {
  const candidates = [
    // Phase 2+ — locales live in the shared @weldsuite/i18n package.
    path.resolve(__dirname, '../../../../packages/core/i18n/src/locales'),
    path.resolve(process.cwd(), 'packages/core/i18n/src/locales'),
    // Phase 1 — pre-extraction, per-module layout in the platform.
    path.resolve(__dirname, '../lib/i18n/locales'),
    path.resolve(process.cwd(), 'lib/i18n/locales'),
    path.resolve(process.cwd(), 'apps/web/platform/lib/i18n/locales'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
  }
  throw new Error(
    `Could not locate locales directory. Tried:\n  ${candidates.join('\n  ')}`
  );
}

function discoverLocales(localesDir: string): string[] {
  return fs
    .readdirSync(localesDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .filter(name => fs.existsSync(path.join(localesDir, name, 'index.ts')));
}

interface LocaleConfigEntry {
  experimental?: boolean;
}

async function loadLocaleConfig(localesDir: string): Promise<Record<string, LocaleConfigEntry>> {
  const configPath = path.join(localesDir, 'index.ts');
  if (!fs.existsSync(configPath)) return {};
  try {
    const mod = (await import(pathToFileURL(configPath).href)) as {
      localeConfig?: Record<string, LocaleConfigEntry>;
    };
    return mod.localeConfig ?? {};
  } catch {
    return {};
  }
}

async function loadLocales(localesDir: string, codes: string[]): Promise<Record<string, any>> {
  const out: Record<string, any> = {};
  for (const code of codes) {
    const indexPath = path.join(localesDir, code, 'index.ts');
    const mod = (await import(pathToFileURL(indexPath).href)) as Record<string, unknown>;
    if (!mod[code]) {
      throw new Error(`Expected named export "${code}" in ${indexPath}; got ${Object.keys(mod).join(',')}`);
    }
    out[code] = mod[code];
  }
  return out;
}

// Count total keys in nested object
function countKeys(obj: any, prefix = ''): number {
  let count = 0;

  for (const key in obj) {
    if (typeof obj[key] === 'object' && !Array.isArray(obj[key])) {
      count += countKeys(obj[key], `${prefix}${key}.`);
    } else {
      count++;
    }
  }

  return count;
}

// Get all key paths in an object
function getKeyPaths(obj: any, prefix = ''): string[] {
  const paths: string[] = [];

  for (const key in obj) {
    const currentPath = prefix ? `${prefix}.${key}` : key;

    if (typeof obj[key] === 'object' && !Array.isArray(obj[key])) {
      paths.push(...getKeyPaths(obj[key], currentPath));
    } else {
      paths.push(currentPath);
    }
  }

  return paths;
}

// Get value at path
function getValueAtPath(obj: any, path: string): any {
  return path.split('.').reduce((current, key) => current?.[key], obj);
}

// Set value at path
function setValueAtPath(obj: any, path: string, value: any): void {
  const keys = path.split('.');
  const lastKey = keys.pop()!;
  const target = keys.reduce((current, key) => {
    if (!current[key]) current[key] = {};
    return current[key];
  }, obj);
  target[lastKey] = value;
}

// Validate a single target locale against the source. Issue paths are
// prefixed with the locale code so cross-locale aggregation stays unambiguous.
function validateLocale(
  source: any,
  target: any,
  sourceLocale: string,
  targetLocale: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const sourcePaths = getKeyPaths(source);
  const targetPaths = getKeyPaths(target);

  const sourceSet = new Set(sourcePaths);
  const targetSet = new Set(targetPaths);

  // Missing keys in target.
  sourcePaths.forEach(p => {
    if (!targetSet.has(p)) {
      issues.push({
        type: 'error',
        category: 'missing_key',
        path: `${targetLocale}.${p}`,
        message: `Missing ${targetLocale} translation for: ${p}`,
        suggestion: `Add: ${p}: "${getValueAtPath(source, p)}"`,
      });
    }
  });

  // Orphan keys in target (present in target but missing in source).
  targetPaths.forEach(p => {
    if (!sourceSet.has(p)) {
      issues.push({
        type: 'warning',
        category: 'missing_key',
        path: `${sourceLocale}.${p}`,
        message: `${targetLocale} translation exists but ${sourceLocale} is missing: ${p}`,
        suggestion: `Remove from ${targetLocale} or add to ${sourceLocale}`,
      });
    }
  });

  // Keys present in both: type / emptiness / untranslated-marker checks.
  const commonPaths = sourcePaths.filter(p => targetSet.has(p));

  commonPaths.forEach(p => {
    const srcValue = getValueAtPath(source, p);
    const tgtValue = getValueAtPath(target, p);

    if (typeof srcValue !== typeof tgtValue) {
      issues.push({
        type: 'error',
        category: 'type_mismatch',
        path: `${targetLocale}.${p}`,
        message: `Type mismatch: ${sourceLocale} is ${typeof srcValue}, ${targetLocale} is ${typeof tgtValue}`,
        suggestion: 'Ensure both have the same type',
      });
      return;
    }

    if (typeof srcValue === 'string' && srcValue.trim() === '') {
      issues.push({
        type: 'warning',
        category: 'empty_value',
        path: `${sourceLocale}.${p}`,
        message: `Empty ${sourceLocale} translation`,
        suggestion: 'Add proper translation text',
      });
    }

    if (typeof tgtValue === 'string' && tgtValue.trim() === '') {
      issues.push({
        type: 'warning',
        category: 'empty_value',
        path: `${targetLocale}.${p}`,
        message: `Empty ${targetLocale} translation`,
        suggestion: 'Add proper translation text',
      });
    }

    if (typeof tgtValue === 'string') {
      if (tgtValue.includes('[TRANSLATE]') || tgtValue.includes('[REVIEW]')) {
        issues.push({
          type: 'warning',
          category: 'untranslated',
          path: `${targetLocale}.${p}`,
          message: `Translation marked as incomplete: ${tgtValue}`,
          suggestion: `Replace marker with proper ${targetLocale} translation`,
        });
      } else if (tgtValue === srcValue && tgtValue.length > 20) {
        issues.push({
          type: 'info',
          category: 'untranslated',
          path: `${targetLocale}.${p}`,
          message: `${targetLocale} translation identical to ${sourceLocale} (might need translation)`,
          suggestion: `Verify if "${tgtValue}" should be translated`,
        });
      }
    }
  });

  return issues;
}

// Display validation results
function displayResults(report: ValidationReport, verbose: boolean = true) {
  console.log('\n' + '='.repeat(80));
  console.log('✅ TRANSLATION VALIDATION REPORT');
  console.log('='.repeat(80) + '\n');

  console.log(`Status: ${report.status === 'pass' ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`Source: ${report.source}`);
  console.log(`Timestamp: ${report.timestamp}\n`);

  console.log('Key counts:');
  for (const [code, count] of Object.entries(report.summary.totalKeys)) {
    console.log(`  ${code.padEnd(6)} ${count}`);
  }
  console.log(`\n  Errors:   ${report.summary.errors}`);
  console.log(`  Warnings: ${report.summary.warnings}`);
  console.log(`  Info:     ${report.summary.info}\n`);

  if (report.issues.length === 0) {
    console.log('🎉 No issues found! Translations are in perfect sync.\n');
    return;
  }

  // Group issues by category
  const byCategory: Record<string, ValidationIssue[]> = {};
  report.issues.forEach(issue => {
    if (!byCategory[issue.category]) byCategory[issue.category] = [];
    byCategory[issue.category].push(issue);
  });

  // Display by category
  Object.entries(byCategory).forEach(([category, issues]) => {
    const icon =
      category === 'missing_key'
        ? '🔍'
        : category === 'untranslated'
          ? '⚠️'
          : category === 'type_mismatch'
            ? '⚡'
            : '📝';

    console.log(`${icon} ${category.replace(/_/g, ' ').toUpperCase()} (${issues.length})`);
    console.log('='.repeat(80));

    if (verbose) {
      issues.slice(0, 10).forEach((issue, i) => {
        const typeIcon = issue.type === 'error' ? '❌' : issue.type === 'warning' ? '⚠️' : 'ℹ️';
        console.log(`\n${i + 1}. ${typeIcon} ${issue.path}`);
        console.log(`   ${issue.message}`);
        if (issue.suggestion) {
          console.log(`   💡 ${issue.suggestion}`);
        }
      });

      if (issues.length > 10) {
        console.log(`\n... and ${issues.length - 10} more ${category} issues`);
      }
    } else {
      console.log(`  ${issues.length} issues found (use --verbose for details)`);
    }

    console.log('');
  });

  console.log('='.repeat(80));
  console.log('💡 RECOMMENDATIONS');
  console.log('='.repeat(80) + '\n');

  if (report.summary.errors > 0) {
    console.log('❌ Fix errors before proceeding:');
    console.log('   - Add all missing translation keys');
    console.log('   - Resolve type mismatches');
    console.log('   - Use --fix to auto-add missing keys with [TRANSLATE] markers\n');
  }

  if (report.summary.warnings > 0) {
    console.log('⚠️  Address warnings for complete translations:');
    console.log('   - Complete all [TRANSLATE] / [REVIEW] markers with proper translations');
    console.log('   - Fill in empty translation values');
    console.log('   - Review strings identical to the source locale\n');
  }
}

function patchesDir(): string {
  // Anchor patches next to the locales so they live with the data they describe.
  const localesDir = findLocalesDir();
  const dir = path.join(localesDir, '..', '.patches');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Emit a non-destructive patch file listing missing-key skeleton for one
// locale. We deliberately do NOT overwrite the locale's source — that would
// normalize formatting, re-order keys, and strip comments. The patch file is
// for human review and manual merging.
function writePatchFile(locale: string, missingByPath: Record<string, string>): string | null {
  const entries = Object.entries(missingByPath);
  if (entries.length === 0) return null;

  const patchTree: Record<string, any> = {};
  for (const [keyPath, srcValue] of entries) {
    setValueAtPath(patchTree, keyPath, `[TRANSLATE] ${srcValue}`);
  }

  const outPath = path.join(patchesDir(), `${locale}-missing-keys.patch.ts`);
  const header = `// AUTO-GENERATED by scripts/validate-translations.ts --fix\n// ${entries.length} missing ${locale} key(s). Review and merge into locales/${locale}/ manually.\n// Do not import this file at runtime.\n\n`;
  const body = `export const ${locale}Pending = ${JSON.stringify(patchTree, null, 2)} as const;\n`;
  fs.writeFileSync(outPath, header + body);
  return outPath;
}

function writeOrphanReport(locale: string, orphans: string[]): string | null {
  if (orphans.length === 0) return null;
  const outPath = path.join(patchesDir(), `${locale}-orphan-keys.txt`);
  const body = `# Keys present in ${locale} but absent from the source locale (${orphans.length}).\n# Review each: either add to the source (intentional new key) or remove from\n# ${locale} (drift). Do NOT auto-delete.\n\n${orphans.join('\n')}\n`;
  fs.writeFileSync(outPath, body);
  return outPath;
}

// Save report
function saveReport(report: ValidationReport, outputFile: string) {
  fs.writeFileSync(outputFile, JSON.stringify(report, null, 2));
  console.log(`\n📊 Validation report saved to ${outputFile}`);
}

// Main execution
async function main() {
  const args = process.argv.slice(2);
  const fix = args.includes('--fix');
  const strict = args.includes('--strict');
  const verbose = !args.includes('--quiet');
  const reportFile = args.includes('--report')
    ? args[args.indexOf('--report') + 1]
    : undefined;
  const source = args.includes('--source')
    ? args[args.indexOf('--source') + 1]!
    : SOURCE_DEFAULT;
  const stableOnly = args.includes('--stable-only');

  console.log('🔍 Validating translation files...\n');

  try {
    const localesDir = findLocalesDir();
    const allCodes = discoverLocales(localesDir);
    if (!allCodes.includes(source)) {
      throw new Error(`Source locale "${source}" not found under ${localesDir}`);
    }
    const localeConfig = await loadLocaleConfig(localesDir);

    // In --stable-only mode, skip locales flagged experimental in localeConfig.
    // We always include the source locale and ones not listed in the config.
    const codes = stableOnly
      ? allCodes.filter(c => c === source || !localeConfig[c]?.experimental)
      : allCodes;

    if (stableOnly && codes.length < allCodes.length) {
      const skipped = allCodes.filter(c => !codes.includes(c));
      console.log(`ℹ️  --stable-only: skipping experimental ${skipped.join(', ')}\n`);
    }

    const locales = await loadLocales(localesDir, codes);

    // Validate every non-source locale against the source.
    const targets = codes.filter(c => c !== source);
    const allIssues: ValidationIssue[] = [];
    for (const target of targets) {
      allIssues.push(...validateLocale(locales[source], locales[target], source, target));
    }

    const totalKeys: Record<string, number> = {};
    for (const code of codes) totalKeys[code] = countKeys(locales[code]);

    const report: ValidationReport = {
      timestamp: new Date().toISOString(),
      source,
      status:
        allIssues.filter(i => i.type === 'error').length === 0 &&
        (!strict || allIssues.filter(i => i.type === 'warning').length === 0)
          ? 'pass'
          : 'fail',
      summary: {
        totalKeys,
        errors: allIssues.filter(i => i.type === 'error').length,
        warnings: allIssues.filter(i => i.type === 'warning').length,
        info: allIssues.filter(i => i.type === 'info').length,
      },
      issues: allIssues,
    };

    displayResults(report, verbose);

    // Emit one patch + one orphan file per target locale when --fix is set.
    // We never overwrite a locale's source — see writePatchFile() for why.
    if (fix) {
      console.log('🔧 Generating patch files...\n');

      for (const target of targets) {
        const missingByPath: Record<string, string> = {};
        const orphans: string[] = [];

        for (const issue of allIssues) {
          if (issue.category !== 'missing_key') continue;
          if (issue.path.startsWith(`${target}.`)) {
            const keyPath = issue.path.slice(target.length + 1);
            const srcValue = getValueAtPath(locales[source], keyPath);
            if (typeof srcValue === 'string') {
              missingByPath[keyPath] = srcValue;
            }
          } else if (issue.path.startsWith(`${source}.`)) {
            // The orphan is reported once globally (source side). Bucket it
            // under the locale that introduced it: any non-source locale
            // that has the key.
            const keyPath = issue.path.slice(source.length + 1);
            const hasInTarget = getValueAtPath(locales[target], keyPath) !== undefined;
            if (hasInTarget) orphans.push(keyPath);
          }
        }

        const patchPath = writePatchFile(target, missingByPath);
        if (patchPath) {
          console.log(`  ✓ ${target}: ${Object.keys(missingByPath).length} missing → ${patchPath}`);
        }
        const orphanPath = writeOrphanReport(target, orphans);
        if (orphanPath) {
          console.log(`  ✓ ${target}: ${orphans.length} orphans → ${orphanPath}`);
        }
        if (!patchPath && !orphanPath) {
          console.log(`  ✓ ${target}: no drift`);
        }
      }
      console.log();
    }

    if (reportFile) {
      saveReport(report, reportFile);
    }

    // Exit with appropriate code
    process.exit(report.status === 'pass' ? 0 : 1);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

main();
