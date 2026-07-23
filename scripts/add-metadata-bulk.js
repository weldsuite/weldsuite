#!/usr/bin/env node

/**
 * Script to bulk add metadata to pages
 * Usage: node scripts/add-metadata-bulk.js
 */

const fs = require('fs');
const path = require('path');

// Mapping of pages that need simple list metadata
const listPages = {
  'app/accounting/products/page.tsx': ['Products', 'Accounting'],
  'app/accounting/journal/page.tsx': ['Journal Entries', 'Accounting'],
  'app/accounting/expenses/page.tsx': ['Expenses', 'Accounting'],
  'app/accounting/banking/page.tsx': ['Banking', 'Accounting'],
  'app/accounting/purchase-orders/page.tsx': ['Purchase Orders', 'Accounting'],
  'app/accounting/projects/page.tsx': ['Projects', 'Accounting'],
  'app/accounting/budgets/page.tsx': ['Budgets', 'Accounting'],
  'app/accounting/cost-centers/page.tsx': ['Cost Centers', 'Accounting'],
  'app/accounting/payment-batches/page.tsx': ['Payment Batches', 'Accounting'],
  'app/accounting/direct-debits/page.tsx': ['Direct Debits', 'Accounting'],
  'app/accounting/cash-entries/page.tsx': ['Cash Entries', 'Accounting'],
  'app/accounting/recurring-entries/page.tsx': ['Recurring Entries', 'Accounting'],
  'app/accounting/general-ledger/page.tsx': ['General Ledger', 'Accounting'],
  'app/accounting/receivables/page.tsx': ['Receivables', 'Accounting'],
  'app/accounting/payables/page.tsx': ['Payables', 'Accounting'],
  'app/accounting/tax/vat-returns/page.tsx': ['VAT Returns', 'Accounting'],
  'app/accounting/tax/ec-sales/page.tsx': ['EC Sales List', 'Accounting'],
  'app/accounting/tax/oss/page.tsx': ['OSS Returns', 'Accounting'],
  'app/accounting/timesheets/page.tsx': ['Timesheets', 'Accounting'],
  'app/accounting/milestones/page.tsx': ['Milestones', 'Accounting'],
  'app/accounting/currency/page.tsx': ['Currencies', 'Accounting'],
  'app/accounting/sequences/page.tsx': ['Sequences', 'Accounting'],
  'app/accounting/integrations/page.tsx': ['Integrations', 'Accounting'],
  'app/accounting/inbox/page.tsx': ['Inbox', 'Accounting'],
};

// Mapping of create pages
const createPages = {
  'app/accounting/journal/new/page.tsx': ['Journal Entry', 'Accounting'],
  'app/accounting/purchase-orders/new/page.tsx': ['Purchase Order', 'Accounting'],
  'app/accounting/budgets/new/page.tsx': ['Budget', 'Accounting'],
  'app/accounting/cost-centers/new/page.tsx': ['Cost Center', 'Accounting'],
  'app/accounting/payment-batches/new/page.tsx': ['Payment Batch', 'Accounting'],
  'app/accounting/direct-debits/new/page.tsx': ['Direct Debit', 'Accounting'],
  'app/accounting/cash-entries/new/page.tsx': ['Cash Entry', 'Accounting'],
  'app/accounting/recurring-entries/new/page.tsx': ['Recurring Entry', 'Accounting'],
  'app/accounting/tax/vat-returns/new/page.tsx': ['VAT Return', 'Accounting'],
  'app/accounting/tax/ec-sales/new/page.tsx': ['EC Sales List', 'Accounting'],
  'app/accounting/tax/oss/new/page.tsx': ['OSS Return', 'Accounting'],
  'app/accounting/currency/new/page.tsx': ['Currency', 'Accounting'],
  'app/accounting/inbox/new/page.tsx': ['Document', 'Accounting'],
  'app/accounting/banking/accounts/new/page.tsx': ['Bank Account', 'Accounting'],
};

// Report pages
const reportPages = {
  'app/accounting/reports/page.tsx': ['Reports', 'Accounting'],
  'app/accounting/reports/balance-sheet/page.tsx': ['Balance Sheet', 'Accounting'],
};

// Settings pages
const settingsPages = {
  'app/accounting/settings/administrations/page.tsx': ['Administration', 'Accounting'],
  'app/accounting/settings/currencies/page.tsx': ['Currency', 'Accounting'],
  'app/accounting/settings/taxes/page.tsx': ['Tax', 'Accounting'],
};

// Special pages
const specialPages = {
  'app/accounting/year-end/page.tsx': {
    title: 'Year-End Closing',
    description: 'Perform year-end closing operations for your accounting system. Close fiscal periods and generate reports.',
    keywords: ['year-end', 'closing', 'fiscal', 'accounting'],
  },
  'app/accounting/client-portal/page.tsx': {
    title: 'Client Portal',
    description: 'Manage client portal access and settings. Allow customers to view invoices, statements, and make payments online.',
    keywords: ['client portal', 'customer access', 'online payments', 'accounting'],
  },
  'app/accounting/reconciliation/page.tsx': {
    title: 'Bank Reconciliation',
    description: 'Reconcile bank accounts and match transactions. Ensure your accounting records match your bank statements.',
    keywords: ['reconciliation', 'bank matching', 'accounting'],
  },
  'app/accounting/banking/reconciliation/page.tsx': {
    title: 'Bank Reconciliation',
    description: 'Reconcile bank accounts and match transactions. Ensure your accounting records match your bank statements.',
    keywords: ['reconciliation', 'bank matching', 'accounting'],
  },
  'app/accounting/assets/depreciation/page.tsx': {
    title: 'Asset Depreciation',
    description: 'Manage asset depreciation schedules and calculations. Track the value of fixed assets over time.',
    keywords: ['depreciation', 'assets', 'fixed assets', 'accounting'],
  },
};

const PLATFORM_DIR = path.join(__dirname, '../apps/web/platform');

function addListMetadata(filePath, entityName, moduleName) {
  const fullPath = path.join(PLATFORM_DIR, filePath);

  if (!fs.existsSync(fullPath)) {
    console.log(`⚠️  File not found: ${filePath}`);
    return false;
  }

  let content = fs.readFileSync(fullPath, 'utf8');

  // Check if metadata already exists
  if (content.includes('export const metadata') || content.includes('generateMetadata')) {
    console.log(`⏭️  Skipping ${filePath} (already has metadata)`);
    return false;
  }

  // Find the first import statement
  const importMatch = content.match(/^import .+$/m);

  if (!importMatch) {
    console.log(`⚠️  No imports found in ${filePath}`);
    return false;
  }

  // Add the metadata import after other imports
  const lastImportIndex = content.lastIndexOf('\nimport ');
  const insertIndex = content.indexOf('\n', lastImportIndex + 1);

  const metadataImport = `import { generateListMetadata } from "@/lib/metadata";`;
  const metadataExport = `\nexport const metadata = generateListMetadata('${entityName}', '${moduleName}');\n`;

  // Insert import
  content = content.slice(0, insertIndex + 1) + metadataImport + '\n' + content.slice(insertIndex + 1);

  // Find where to insert metadata export (after imports, before interface/export default)
  const interfaceOrExportMatch = content.match(/\n(interface |export (default |async ))/);
  if (interfaceOrExportMatch) {
    const exportIndex = interfaceOrExportMatch.index;
    content = content.slice(0, exportIndex + 1) + metadataExport + content.slice(exportIndex + 1);
  }

  fs.writeFileSync(fullPath, content);
  console.log(`✅ Added metadata to ${filePath}`);
  return true;
}

function addCreateMetadata(filePath, entityName, moduleName) {
  const fullPath = path.join(PLATFORM_DIR, filePath);

  if (!fs.existsSync(fullPath)) {
    console.log(`⚠️  File not found: ${filePath}`);
    return false;
  }

  let content = fs.readFileSync(fullPath, 'utf8');

  // Check if metadata already exists
  if (content.includes('export const metadata') || content.includes('generateMetadata')) {
    console.log(`⏭️  Skipping ${filePath} (already has metadata)`);
    return false;
  }

  // Find the last import statement
  const lastImportIndex = content.lastIndexOf('\nimport ');
  const insertIndex = content.indexOf('\n', lastImportIndex + 1);

  const metadataImport = `import { generateCreateMetadata } from "@/lib/metadata";`;
  const metadataExport = `\nexport const metadata = generateCreateMetadata('${entityName}', '${moduleName}');\n`;

  // Insert import
  content = content.slice(0, insertIndex + 1) + metadataImport + '\n' + content.slice(insertIndex + 1);

  // Find where to insert metadata export
  const exportMatch = content.match(/\n(export (default |async function))/);
  if (exportMatch) {
    const exportIndex = exportMatch.index;
    content = content.slice(0, exportIndex + 1) + metadataExport + content.slice(exportIndex + 1);
  }

  fs.writeFileSync(fullPath, content);
  console.log(`✅ Added metadata to ${filePath}`);
  return true;
}

function addReportMetadata(filePath, reportName, moduleName) {
  return addMetadataWithFunction(filePath, 'generateReportMetadata', reportName, moduleName);
}

function addSettingsMetadata(filePath, settingName, moduleName) {
  return addMetadataWithFunction(filePath, 'generateSettingsMetadata', settingName, moduleName);
}

function addMetadataWithFunction(filePath, functionName, name, moduleName) {
  const fullPath = path.join(PLATFORM_DIR, filePath);

  if (!fs.existsSync(fullPath)) {
    console.log(`⚠️  File not found: ${filePath}`);
    return false;
  }

  let content = fs.readFileSync(fullPath, 'utf8');

  if (content.includes('export const metadata') || content.includes('generateMetadata')) {
    console.log(`⏭️  Skipping ${filePath} (already has metadata)`);
    return false;
  }

  const lastImportIndex = content.lastIndexOf('\nimport ');
  const insertIndex = content.indexOf('\n', lastImportIndex + 1);

  const metadataImport = `import { ${functionName} } from "@/lib/metadata";`;
  const metadataExport = `\nexport const metadata = ${functionName}('${name}', '${moduleName}');\n`;

  content = content.slice(0, insertIndex + 1) + metadataImport + '\n' + content.slice(insertIndex + 1);

  const exportMatch = content.match(/\n(export (default |async function)|interface )/);
  if (exportMatch) {
    const exportIndex = exportMatch.index;
    content = content.slice(0, exportIndex + 1) + metadataExport + content.slice(exportIndex + 1);
  }

  fs.writeFileSync(fullPath, content);
  console.log(`✅ Added metadata to ${filePath}`);
  return true;
}

async function main() {
  console.log('🚀 Starting bulk metadata addition...\n');

  let successCount = 0;
  let skipCount = 0;

  // Add list metadata
  console.log('\n📋 Adding metadata to list pages...');
  for (const [filePath, [entityName, moduleName]] of Object.entries(listPages)) {
    if (addListMetadata(filePath, entityName, moduleName)) {
      successCount++;
    } else {
      skipCount++;
    }
  }

  // Add create metadata
  console.log('\n➕ Adding metadata to create pages...');
  for (const [filePath, [entityName, moduleName]] of Object.entries(createPages)) {
    if (addCreateMetadata(filePath, entityName, moduleName)) {
      successCount++;
    } else {
      skipCount++;
    }
  }

  // Add report metadata
  console.log('\n📊 Adding metadata to report pages...');
  for (const [filePath, [reportName, moduleName]] of Object.entries(reportPages)) {
    if (addReportMetadata(filePath, reportName, moduleName)) {
      successCount++;
    } else {
      skipCount++;
    }
  }

  // Add settings metadata
  console.log('\n⚙️  Adding metadata to settings pages...');
  for (const [filePath, [settingName, moduleName]] of Object.entries(settingsPages)) {
    if (addSettingsMetadata(filePath, settingName, moduleName)) {
      successCount++;
    } else {
      skipCount++;
    }
  }

  console.log('\n✨ Done!');
  console.log(`\n✅ Added metadata to ${successCount} pages`);
  console.log(`⏭️  Skipped ${skipCount} pages`);
  console.log('\n💡 Run `pnpm check:metadata` to see remaining pages\n');
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
