#!/usr/bin/env tsx

/**
 * Migration Script: Find Hardcoded Strings
 *
 * This script scans all TSX/JSX files in the platform app to identify
 * hardcoded English strings that should be converted to translation keys.
 *
 * Usage:
 *   pnpm tsx scripts/find-hardcoded-strings.ts [options]
 *
 * Options:
 *   --module <name>  Scan specific module only (e.g., wms, accounting, commerce)
 *   --output <file>  Save results to JSON file
 *   --verbose        Show detailed analysis
 */

import fs from 'fs';
import path from 'path';

interface HardcodedString {
  file: string;
  line: number;
  column: number;
  context: string;
  stringValue: string;
  type: 'label' | 'placeholder' | 'text' | 'title' | 'description' | 'aria-label' | 'toast' | 'validation' | 'other';
  suggestedKey?: string;
}

interface AnalysisResult {
  totalFiles: number;
  filesWithHardcodedStrings: number;
  totalHardcodedStrings: number;
  byModule: Record<string, HardcodedString[]>;
  byType: Record<string, number>;
  files: Record<string, HardcodedString[]>;
}

// Patterns to identify hardcoded strings
const PATTERNS = {
  label: /(?:label|title|header|name|text):\s*["'`]([^"'`]+)["'`]/g,
  placeholder: /placeholder=["'`]([^"'`]+)["'`]/g,
  ariaLabel: /aria-label=["'`]([^"'`]+)["'`]/g,
  text: />[^<{]*["']([A-Z][^"']*?)["'][^<{]*</g,
  toast: /toast\.[a-z]+\(\s*["'`]([^"'`]+)["'`]/g,
  validation: /(?:error|message|description):\s*["'`]([^"'`]+)["'`]/g,
};

// Strings to ignore (technical terms, IDs, etc.)
const IGNORE_PATTERNS = [
  /^[a-z_-]+$/, // Technical IDs (e.g., 'user_id', 'api-key')
  /^#[0-9A-Fa-f]+$/, // Hex colors
  /^https?:\/\//, // URLs
  /^\/[a-z-/]*$/, // Routes
  /^[0-9]+$/, // Pure numbers
  /^[A-Z_]+$/, // Constants (e.g., 'API_KEY')
  /^\$\{.*\}$/, // Template variables
  /^t\.[a-z.]+/i, // Already using translations
  /^className/, // CSS classes
  /^data-/, // Data attributes
];

// Module detection from file path
function getModuleFromPath(filePath: string): string {
  const match = filePath.match(/app\/([\w-]+)\//);
  if (match) return match[1];

  const componentMatch = filePath.match(/components\/([\w-]+)\//);
  if (componentMatch) return componentMatch[1];

  return 'common';
}

// Detect string type based on context
function detectStringType(context: string, stringValue: string): HardcodedString['type'] {
  if (context.includes('label') || context.includes('Label')) return 'label';
  if (context.includes('placeholder')) return 'placeholder';
  if (context.includes('title') || context.includes('Title')) return 'title';
  if (context.includes('description')) return 'description';
  if (context.includes('aria-label')) return 'aria-label';
  if (context.includes('toast.')) return 'toast';
  if (context.includes('error') || context.includes('message')) return 'validation';
  if (stringValue.match(/^[A-Z]/)) return 'text';
  return 'other';
}

// Generate suggested translation key
function generateSuggestedKey(module: string, type: string, stringValue: string): string {
  const cleanValue = stringValue
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '_')
    .substring(0, 40);

  return `${module}.${type}.${cleanValue}`;
}

// Check if string should be ignored
function shouldIgnore(str: string): boolean {
  if (!str || str.length < 2) return true;
  if (IGNORE_PATTERNS.some(pattern => pattern.test(str))) return true;

  // Ignore if mostly special characters
  const alphaRatio = (str.match(/[a-zA-Z]/g) || []).length / str.length;
  if (alphaRatio < 0.5) return true;

  return false;
}

// Extract hardcoded strings from a file
function extractHardcodedStrings(filePath: string, content: string): HardcodedString[] {
  const results: HardcodedString[] = [];
  const module = getModuleFromPath(filePath);

  // Check each pattern
  for (const [, regex] of Object.entries(PATTERNS)) {
    const matches = content.matchAll(regex);

    for (const match of matches) {
      const stringValue = match[1];

      if (shouldIgnore(stringValue)) continue;

      // Find line and column
      const index = match.index || 0;
      const beforeMatch = content.substring(0, index);
      const line = beforeMatch.split('\n').length;
      const column = beforeMatch.split('\n').pop()?.length || 0;

      const type = detectStringType(match[0], stringValue);
      const suggestedKey = generateSuggestedKey(module, type, stringValue);

      results.push({
        file: filePath,
        line,
        column,
        context: match[0],
        stringValue,
        type,
        suggestedKey,
      });
    }
  }

  return results;
}

// Recursively find all TSX/JSX files
function findFiles(dir: string, pattern: RegExp = /\.(tsx|jsx)$/): string[] {
  const files: string[] = [];

  try {
    const items = fs.readdirSync(dir, { withFileTypes: true });

    for (const item of items) {
      const fullPath = path.join(dir, item.name);

      // Skip node_modules, .next, dist, and test files
      if (
        item.name === 'node_modules' ||
        item.name === '.next' ||
        item.name === 'dist' ||
        item.name.includes('.test.') ||
        item.name.includes('.spec.')
      ) {
        continue;
      }

      if (item.isDirectory()) {
        files.push(...findFiles(fullPath, pattern));
      } else if (item.isFile() && pattern.test(item.name)) {
        files.push(fullPath);
      }
    }
  } catch {
    // Skip directories we can't read
  }

  return files;
}

// Scan all files
async function scanFiles(moduleFilter?: string): Promise<AnalysisResult> {
  const result: AnalysisResult = {
    totalFiles: 0,
    filesWithHardcodedStrings: 0,
    totalHardcodedStrings: 0,
    byModule: {},
    byType: {
      label: 0,
      placeholder: 0,
      text: 0,
      title: 0,
      description: 0,
      'aria-label': 0,
      toast: 0,
      validation: 0,
      other: 0,
    },
    files: {},
  };

  // Find all TSX/JSX files
  const dirs = moduleFilter
    ? [path.join(process.cwd(), 'app', moduleFilter), path.join(process.cwd(), 'components', moduleFilter)]
    : [path.join(process.cwd(), 'app'), path.join(process.cwd(), 'components')];

  const files: string[] = [];
  for (const dir of dirs) {
    if (fs.existsSync(dir)) {
      files.push(...findFiles(dir));
    }
  }

  console.log(`📁 Scanning ${files.length} files${moduleFilter ? ` in ${moduleFilter} module` : ''}...`);

  for (const file of files) {
    result.totalFiles++;

    const content = fs.readFileSync(file, 'utf-8');
    const hardcodedStrings = extractHardcodedStrings(file, content);

    if (hardcodedStrings.length > 0) {
      result.filesWithHardcodedStrings++;
      result.totalHardcodedStrings += hardcodedStrings.length;
      result.files[file] = hardcodedStrings;

      // Group by module
      hardcodedStrings.forEach(item => {
        const module = getModuleFromPath(item.file);
        if (!result.byModule[module]) result.byModule[module] = [];
        result.byModule[module].push(item);

        // Count by type
        result.byType[item.type]++;
      });
    }
  }

  return result;
}

// Display results
function displayResults(result: AnalysisResult, verbose: boolean) {
  console.log('\n' + '='.repeat(80));
  console.log('📊 HARDCODED STRINGS ANALYSIS RESULTS');
  console.log('='.repeat(80) + '\n');

  console.log(`Total files scanned: ${result.totalFiles}`);
  console.log(`Files with hardcoded strings: ${result.filesWithHardcodedStrings}`);
  console.log(`Total hardcoded strings: ${result.totalHardcodedStrings}\n`);

  console.log('By Type:');
  Object.entries(result.byType)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .forEach(([type, count]) => {
      console.log(`  ${type.padEnd(15)}: ${count}`);
    });

  console.log('\nBy Module:');
  Object.entries(result.byModule)
    .sort((a, b) => b[1].length - a[1].length)
    .forEach(([module, strings]) => {
      console.log(`  ${module.padEnd(15)}: ${strings.length} strings`);
    });

  if (verbose) {
    console.log('\n' + '='.repeat(80));
    console.log('📝 DETAILED FINDINGS');
    console.log('='.repeat(80) + '\n');

    Object.entries(result.files)
      .slice(0, 10) // Show first 10 files
      .forEach(([file, strings]) => {
        console.log(`\n📄 ${file.replace('apps/web/platform/', '')}`);
        console.log(`   Found ${strings.length} hardcoded string(s):`);
        strings.slice(0, 5).forEach(item => {
          console.log(`   - Line ${item.line}: "${item.stringValue}" (${item.type})`);
          console.log(`     Suggested key: ${item.suggestedKey}`);
        });
        if (strings.length > 5) {
          console.log(`   ... and ${strings.length - 5} more`);
        }
      });

    if (Object.keys(result.files).length > 10) {
      console.log(`\n... and ${Object.keys(result.files).length - 10} more files`);
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log('💡 RECOMMENDATIONS');
  console.log('='.repeat(80) + '\n');

  console.log('1. Run with --output results.json to save detailed analysis');
  console.log('2. Use generate-translation-keys.ts to create missing keys');
  console.log('3. Prioritize modules with most hardcoded strings:');
  Object.entries(result.byModule)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 3)
    .forEach(([module, strings], i) => {
      console.log(`   ${i + 1}. ${module} (${strings.length} strings)`);
    });
  console.log('');
}

// Save results to file
function saveResults(result: AnalysisResult, outputFile: string) {
  fs.writeFileSync(outputFile, JSON.stringify(result, null, 2));
  console.log(`\n✅ Results saved to ${outputFile}`);
}

// Main execution
async function main() {
  const args = process.argv.slice(2);
  const moduleFilter = args.includes('--module')
    ? args[args.indexOf('--module') + 1]
    : undefined;
  const outputFile = args.includes('--output')
    ? args[args.indexOf('--output') + 1]
    : undefined;
  const verbose = args.includes('--verbose');

  console.log('🔍 Finding hardcoded strings in WeldSuite platform...\n');

  try {
    const result = await scanFiles(moduleFilter);
    displayResults(result, verbose);

    if (outputFile) {
      saveResults(result, outputFile);
    }
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

main();
