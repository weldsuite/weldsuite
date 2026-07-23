#!/usr/bin/env tsx

/**
 * Migration Script: Generate Translation Keys
 *
 * This script takes the output from find-hardcoded-strings.ts and generates
 * proper translation keys with English and Dutch translations.
 *
 * Usage:
 *   pnpm tsx scripts/generate-translation-keys.ts <input-json> [options]
 *
 * Options:
 *   --output <file>    Save generated keys to file (default: generated-keys.json)
 *   --dutch           Auto-translate to Dutch using basic translations
 *   --merge           Merge with existing translation files
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

interface TranslationStructure {
  [namespace: string]: {
    [category: string]: {
      [key: string]: string | Record<string, any>;
    };
  };
}

// Basic English -> Dutch translations for common terms
const COMMON_TRANSLATIONS: Record<string, string> = {
  // Actions
  'add': 'toevoegen',
  'edit': 'bewerken',
  'delete': 'verwijderen',
  'save': 'opslaan',
  'cancel': 'annuleren',
  'submit': 'verzenden',
  'create': 'aanmaken',
  'update': 'bijwerken',
  'remove': 'verwijderen',
  'search': 'zoeken',
  'filter': 'filteren',
  'export': 'exporteren',
  'import': 'importeren',
  'print': 'afdrukken',
  'download': 'downloaden',
  'upload': 'uploaden',
  'view': 'bekijken',
  'close': 'sluiten',
  'open': 'openen',
  'refresh': 'verversen',
  'reset': 'resetten',
  'clear': 'wissen',
  'select': 'selecteren',
  'confirm': 'bevestigen',

  // Common nouns
  'name': 'naam',
  'description': 'beschrijving',
  'title': 'titel',
  'status': 'status',
  'type': 'type',
  'category': 'categorie',
  'date': 'datum',
  'time': 'tijd',
  'email': 'e-mail',
  'phone': 'telefoon',
  'address': 'adres',
  'city': 'stad',
  'country': 'land',
  'code': 'code',
  'number': 'nummer',
  'amount': 'bedrag',
  'price': 'prijs',
  'total': 'totaal',
  'subtotal': 'subtotaal',
  'tax': 'btw',
  'discount': 'korting',
  'quantity': 'hoeveelheid',
  'unit': 'eenheid',
  'notes': 'notities',
  'comments': 'opmerkingen',
  'tags': 'tags',
  'priority': 'prioriteit',
  'order': 'bestelling',
  'customer': 'klant',
  'user': 'gebruiker',
  'product': 'product',
  'item': 'item',
  'items': 'items',
  'location': 'locatie',
  'warehouse': 'magazijn',
  'invoice': 'factuur',
  'payment': 'betaling',
  'account': 'account',

  // Status values
  'active': 'actief',
  'inactive': 'inactief',
  'pending': 'in behandeling',
  'approved': 'goedgekeurd',
  'rejected': 'afgewezen',
  'completed': 'voltooid',
  'cancelled': 'geannuleerd',
  'draft': 'concept',
  'published': 'gepubliceerd',
  'archived': 'gearchiveerd',
  'new': 'nieuw',
  'in progress': 'in behandeling',
  'ready': 'klaar',
  'shipped': 'verzonden',
  'delivered': 'afgeleverd',

  // Common phrases
  'all': 'alle',
  'none': 'geen',
  'yes': 'ja',
  'no': 'nee',
  'loading': 'laden',
  'error': 'fout',
  'success': 'succes',
  'warning': 'waarschuwing',
  'info': 'info',
  'required': 'verplicht',
  'optional': 'optioneel',
  'show more': 'toon meer',
  'show less': 'toon minder',
  'no data': 'geen gegevens',
  'no results': 'geen resultaten',
  'total results': 'totaal resultaten',
  'per page': 'per pagina',
  'of': 'van',
  'to': 'tot',
  'from': 'van',
};

// Simple translation function using common words
function simpleTranslate(english: string): string {
  const lower = english.toLowerCase();

  // Check for direct translation
  if (COMMON_TRANSLATIONS[lower]) {
    // Match original case
    if (english[0] === english[0].toUpperCase()) {
      return COMMON_TRANSLATIONS[lower].charAt(0).toUpperCase() + COMMON_TRANSLATIONS[lower].slice(1);
    }
    return COMMON_TRANSLATIONS[lower];
  }

  // Try word-by-word translation
  const words = lower.split(/\s+/);
  const translated = words.map(word => COMMON_TRANSLATIONS[word] || word);

  if (translated.some((word, i) => word !== words[i])) {
    // At least one word was translated
    return translated.join(' ');
  }

  // No translation available - return original with note
  return `${english} [TRANSLATE]`;
}

// Build translation key path from suggested key
function parseKeyPath(suggestedKey: string): { namespace: string; category: string; key: string } {
  const parts = suggestedKey.split('.');

  if (parts.length >= 3) {
    return {
      namespace: parts[0],
      category: parts[1],
      key: parts.slice(2).join('_'),
    };
  }

  // Fallback
  return {
    namespace: parts[0] || 'common',
    category: parts[1] || 'labels',
    key: parts.slice(2).join('_') || 'unknown',
  };
}

// Generate translation structure
function generateTranslationStructure(
  analysis: AnalysisResult,
  autoDutch: boolean
): { en: TranslationStructure; nl: TranslationStructure } {
  const en: TranslationStructure = {};
  const nl: TranslationStructure = {};

  // Group all strings by module and type
  const grouped: Record<string, Record<string, HardcodedString[]>> = {};

  Object.values(analysis.byModule).forEach(moduleStrings => {
    moduleStrings.forEach(item => {
      const { namespace, category, key } = parseKeyPath(item.suggestedKey || '');

      if (!grouped[namespace]) grouped[namespace] = {};
      if (!grouped[namespace][category]) grouped[namespace][category] = [];
      grouped[namespace][category].push(item);
    });
  });

  // Build nested structure
  Object.entries(grouped).forEach(([namespace, categories]) => {
    if (!en[namespace]) en[namespace] = {};
    if (!nl[namespace]) nl[namespace] = {};

    Object.entries(categories).forEach(([category, strings]) => {
      if (!en[namespace][category]) en[namespace][category] = {};
      if (!nl[namespace][category]) nl[namespace][category] = {};

      strings.forEach(item => {
        const { key } = parseKeyPath(item.suggestedKey || '');

        // Deduplicate - use first occurrence
        if (!en[namespace][category][key]) {
          en[namespace][category][key] = item.stringValue;

          if (autoDutch) {
            nl[namespace][category][key] = simpleTranslate(item.stringValue);
          } else {
            nl[namespace][category][key] = `[TRANSLATE] ${item.stringValue}`;
          }
        }
      });
    });
  });

  return { en, nl };
}

// Load existing translations
function loadExistingTranslations(): { en: any; nl: any } | null {
  try {
    const enPath = path.join(process.cwd(), 'lib/i18n/locales/en.ts');
    const nlPath = path.join(process.cwd(), 'lib/i18n/locales/nl.ts');

    if (!fs.existsSync(enPath) || !fs.existsSync(nlPath)) {
      return null;
    }

    // Note: This is a simplified loader. In reality, we'd need to parse TypeScript
    console.log('ℹ️  Found existing translation files');
    return null; // For now, manual merge required
  } catch (error) {
    return null;
  }
}

// Display generated keys
function displayKeys(en: TranslationStructure, nl: TranslationStructure) {
  console.log('\n' + '='.repeat(80));
  console.log('📝 GENERATED TRANSLATION KEYS');
  console.log('='.repeat(80) + '\n');

  let totalKeys = 0;
  let translatedKeys = 0;

  Object.entries(en).forEach(([namespace, categories]) => {
    console.log(`\n📦 Namespace: ${namespace}`);

    Object.entries(categories).forEach(([category, keys]) => {
      const keyCount = Object.keys(keys).length;
      totalKeys += keyCount;

      console.log(`  📁 ${category}: ${keyCount} keys`);

      // Show first 3 keys as examples
      Object.entries(keys)
        .slice(0, 3)
        .forEach(([key, value]) => {
          const nlValue = nl[namespace][category][key];
          const isTranslated = !nlValue.toString().startsWith('[TRANSLATE]');
          if (isTranslated) translatedKeys++;

          console.log(`    - ${key}:`);
          console.log(`      EN: "${value}"`);
          console.log(`      NL: "${nlValue}" ${isTranslated ? '✅' : '⚠️ '}`);
        });

      if (keyCount > 3) {
        console.log(`    ... and ${keyCount - 3} more keys`);
      }
    });
  });

  console.log(`\n📊 Total keys generated: ${totalKeys}`);
  console.log(`📊 Auto-translated: ${translatedKeys} (${((translatedKeys / totalKeys) * 100).toFixed(1)}%)`);
  console.log(`⚠️  Need manual translation: ${totalKeys - translatedKeys}`);
}

// Save generated keys
function saveKeys(en: TranslationStructure, nl: TranslationStructure, outputFile: string) {
  const output = {
    en,
    nl,
    metadata: {
      generated: new Date().toISOString(),
      totalKeys: Object.values(en).reduce(
        (sum, namespace) =>
          sum +
          Object.values(namespace).reduce(
            (catSum, category) => catSum + Object.keys(category).length,
            0
          ),
        0
      ),
    },
  };

  fs.writeFileSync(outputFile, JSON.stringify(output, null, 2));
  console.log(`\n✅ Generated keys saved to ${outputFile}`);
  console.log('\n💡 Next steps:');
  console.log('   1. Review generated keys in the output file');
  console.log('   2. Complete any [TRANSLATE] placeholders with proper Dutch translations');
  console.log('   3. Merge keys into lib/i18n/locales/en.ts and nl.ts');
  console.log('   4. Run pnpm generate:i18n-types to update types');
}

// Main execution
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0].startsWith('--')) {
    console.error('❌ Error: Input file required');
    console.log('\nUsage:');
    console.log('  pnpm tsx scripts/generate-translation-keys.ts <input.json> [options]');
    console.log('\nOptions:');
    console.log('  --output <file>    Output file (default: generated-keys.json)');
    console.log('  --dutch            Auto-translate to Dutch using basic translations');
    console.log('  --merge            Merge with existing translation files (coming soon)');
    process.exit(1);
  }

  const inputFile = args[0];
  const outputFile = args.includes('--output')
    ? args[args.indexOf('--output') + 1]
    : 'generated-keys.json';
  const autoDutch = args.includes('--dutch');
  const merge = args.includes('--merge');

  console.log('🔧 Generating translation keys...\n');
  console.log(`📥 Input: ${inputFile}`);
  console.log(`📤 Output: ${outputFile}`);
  console.log(`🇳🇱 Auto-translate Dutch: ${autoDutch ? 'Yes' : 'No'}\n`);

  try {
    // Load analysis results
    if (!fs.existsSync(inputFile)) {
      console.error(`❌ Error: File not found: ${inputFile}`);
      process.exit(1);
    }

    const analysis: AnalysisResult = JSON.parse(fs.readFileSync(inputFile, 'utf-8'));

    console.log(`Processing ${analysis.totalHardcodedStrings} hardcoded strings...`);

    // Generate keys
    const { en, nl } = generateTranslationStructure(analysis, autoDutch);

    // Display results
    displayKeys(en, nl);

    // Save to file
    saveKeys(en, nl, outputFile);

    if (merge) {
      console.log('\n⚠️  Merge functionality coming soon - please merge manually for now');
    }
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

main();
