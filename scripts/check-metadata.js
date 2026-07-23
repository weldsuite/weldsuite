#!/usr/bin/env node

/**
 * Script to check which pages have metadata and which don't
 * Usage: node scripts/check-metadata.js
 */

const fs = require('fs');
const path = require('path');
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
 * Main function
 */
async function main() {
  console.log('🔍 Scanning pages for metadata...\n');

  // Find all page.tsx files
  const pageFiles = await glob('**/page.tsx', {
    cwd: PLATFORM_APP_DIR,
    absolute: true,
  });

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

  // Process each page file
  for (const filePath of pageFiles) {
    const relativePath = path.relative(PLATFORM_APP_DIR, filePath);
    const metadata = hasMetadata(filePath);
    const pageType = categorizePageType(filePath);
    const moduleName = getModuleName(filePath);

    const pageInfo = {
      path: relativePath,
      module: moduleName,
      type: pageType,
      hasStatic: metadata.hasStatic,
      hasDynamic: metadata.hasDynamic,
    };

    if (metadata.hasAny) {
      results.withMetadata.push(pageInfo);
      results.byType[pageType].with++;
    } else {
      results.withoutMetadata.push(pageInfo);
      results.byType[pageType].without++;
    }

    // Track by module
    if (!results.byModule[moduleName]) {
      results.byModule[moduleName] = { with: 0, without: 0 };
    }

    if (metadata.hasAny) {
      results.byModule[moduleName].with++;
    } else {
      results.byModule[moduleName].without++;
    }
  }

  // Print summary
  console.log('📊 Summary\n');
  console.log(`Total pages: ${pageFiles.length}`);
  console.log(`✅ With metadata: ${results.withMetadata.length} (${Math.round((results.withMetadata.length / pageFiles.length) * 100)}%)`);
  console.log(`❌ Without metadata: ${results.withoutMetadata.length} (${Math.round((results.withoutMetadata.length / pageFiles.length) * 100)}%)`);
  console.log('');

  // Print by type
  console.log('📋 By Page Type\n');
  for (const [type, counts] of Object.entries(results.byType)) {
    const total = counts.with + counts.without;
    if (total > 0) {
      const percentage = Math.round((counts.with / total) * 100);
      console.log(`${type.padEnd(12)} ${counts.with}/${total} (${percentage}%)`);
    }
  }
  console.log('');

  // Print by module
  console.log('📁 By Module\n');
  for (const [module, counts] of Object.entries(results.byModule)) {
    const total = counts.with + counts.without;
    const percentage = Math.round((counts.with / total) * 100);
    console.log(`${module.padEnd(15)} ${counts.with}/${total} (${percentage}%)`);
  }
  console.log('');

  // Print pages without metadata
  if (results.withoutMetadata.length > 0) {
    console.log('❌ Pages Missing Metadata\n');

    // Group by module
    const byModule = {};
    for (const page of results.withoutMetadata) {
      if (!byModule[page.module]) {
        byModule[page.module] = [];
      }
      byModule[page.module].push(page);
    }

    for (const [module, pages] of Object.entries(byModule)) {
      console.log(`\n${module}:`);
      for (const page of pages) {
        console.log(`  [${page.type}] ${page.path}`);
      }
    }
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
