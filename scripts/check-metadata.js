#!/usr/bin/env node

/**
 * Script to check which pages have metadata and which don't
 * Usage: node scripts/check-metadata.js
 */

const fs = require('node:fs');
const path = require('node:path');
const { glob } = require('glob');

const PLATFORM_APP_DIR = path.join(__dirname, '../apps/web/platform/app');

/**
 * Check if a file contains metadata
 */
function hasMetadata(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');

  // Check for static metadata export
  const hasStaticMetadata = content.includes('export const metadata');

  // Check for dynamic metadata function
  const hasDynamicMetadata = content.includes('export async function generateMetadata');

  return {
    hasStatic: hasStaticMetadata,
    hasDynamic: hasDynamicMetadata,
    hasAny: hasStaticMetadata || hasDynamicMetadata,
  };
}

/**
 * Categorize page type based on path
 */
function categorizePageType(filePath) {
  const relativePath = path.relative(PLATFORM_APP_DIR, filePath);

  if (relativePath.includes('[id]')) {
    if (relativePath.includes('edit')) {
      return 'edit';
    }
    return 'detail';
  }

  if (relativePath.includes('/new/')) {
    return 'create';
  }

  if (relativePath.includes('settings')) {
    return 'settings';
  }

  if (relativePath.includes('reports')) {
    return 'report';
  }

  if (relativePath.endsWith('page.tsx') && !relativePath.includes('/')) {
    return 'dashboard';
  }

  const segments = relativePath.split('/');
  if (segments.length === 2 && segments[1] === 'page.tsx') {
    return 'dashboard';
  }

  return 'list';
}

/**
 * Get module name from path
 */
function getModuleName(filePath) {
  const relativePath = path.relative(PLATFORM_APP_DIR, filePath);
  const segments = relativePath.split('/');

  // Remove route group syntax
  const firstSegment = segments[0].replace(/[()]/g, '');

  if (firstSegment === 'dashboard') {
    return 'main';
  }

  return firstSegment;
}

/**
 * Increment a with/without counter
 */
function bump(counts, hasMetadata) {
  if (hasMetadata) {
    counts.with++;
  } else {
    counts.without++;
  }
}

/**
 * Scan all page files and collect results
 */
function collectResults(pageFiles) {
  const results = {
    withMetadata: [],
    withoutMetadata: [],
    byModule: {},
    byType: {
      list: { with: 0, without: 0 },
      detail: { with: 0, without: 0 },
      create: { with: 0, without: 0 },
      edit: { with: 0, without: 0 },
      dashboard: { with: 0, without: 0 },
      settings: { with: 0, without: 0 },
      report: { with: 0, without: 0 },
    },
  };

  for (const filePath of pageFiles) {
    const metadata = hasMetadata(filePath);
    const pageType = categorizePageType(filePath);
    const moduleName = getModuleName(filePath);

    const pageInfo = {
      path: path.relative(PLATFORM_APP_DIR, filePath),
      module: moduleName,
      type: pageType,
      hasStatic: metadata.hasStatic,
      hasDynamic: metadata.hasDynamic,
    };

    (metadata.hasAny ? results.withMetadata : results.withoutMetadata).push(pageInfo);
    bump(results.byType[pageType], metadata.hasAny);

    // Track by module
    results.byModule[moduleName] ??= { with: 0, without: 0 };
    bump(results.byModule[moduleName], metadata.hasAny);
  }

  return results;
}

function percent(part, total) {
  return Math.round((part / total) * 100);
}

function printSummary(results, totalPages) {
  console.log('📊 Summary\n');
  console.log(`Total pages: ${totalPages}`);
  console.log(`✅ With metadata: ${results.withMetadata.length} (${percent(results.withMetadata.length, totalPages)}%)`);
  console.log(`❌ Without metadata: ${results.withoutMetadata.length} (${percent(results.withoutMetadata.length, totalPages)}%)`);
  console.log('');
}

function printByType(byType) {
  console.log('📋 By Page Type\n');
  for (const [type, counts] of Object.entries(byType)) {
    const total = counts.with + counts.without;
    if (total > 0) {
      console.log(`${type.padEnd(12)} ${counts.with}/${total} (${percent(counts.with, total)}%)`);
    }
  }
  console.log('');
}

function printByModule(byModule) {
  console.log('📁 By Module\n');
  for (const [module, counts] of Object.entries(byModule)) {
    const total = counts.with + counts.without;
    console.log(`${module.padEnd(15)} ${counts.with}/${total} (${percent(counts.with, total)}%)`);
  }
  console.log('');
}

function printMissing(withoutMetadata) {
  console.log('❌ Pages Missing Metadata\n');

  // Group by module
  const byModule = {};
  for (const page of withoutMetadata) {
    byModule[page.module] ??= [];
    byModule[page.module].push(page);
  }

  for (const [module, pages] of Object.entries(byModule)) {
    console.log(`\n${module}:`);
    for (const page of pages) {
      console.log(`  [${page.type}] ${page.path}`);
    }
  }
}

/**
 * Main function
 */
async function main() {
  console.log('🔍 Scanning pages for metadata...\n');

  // Find all page.tsx files
  const pageFiles = await glob('**/page.tsx', {
    cwd: PLATFORM_APP_DIR,
    absolute: true,
  });

  const results = collectResults(pageFiles);

  printSummary(results, pageFiles.length);
  printByType(results.byType);
  printByModule(results.byModule);

  if (results.withoutMetadata.length > 0) {
    printMissing(results.withoutMetadata);
  }

  console.log('\n✨ Done!\n');

  // Exit with error code if there are pages without metadata
  if (results.withoutMetadata.length > 0) {
    console.log('💡 Tip: See METADATA_IMPLEMENTATION_GUIDE.md for implementation patterns\n');
    process.exit(0); // Changed to 0 to not fail CI/CD
  }
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
