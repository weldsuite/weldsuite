/**
 * Generates rust/crates/books-domain/data/jurisdictions.json: the data of
 * @weldsuite/books-domain's jurisdictions that the Rust port reads instead of
 * re-typing it — the jurisdiction summaries, each adapter's settings, the
 * charts of accounts and standard tax categories an entity is seeded with (US
 * per entity type and classification, BR per regime), the US entity types,
 * tax-return forms, tax-line catalogs and category mapping, 1099 boxes and
 * address state codes, and the Brazilian legal forms and regimes.
 *
 *   pnpm --filter books-api exec tsx ../../../rust/crates/books-domain/tools/export.mts
 *
 * Run from apps/workers/books-api (it imports books-domain and the worksheet
 * labels of books-api). Commit the output; regenerate when that data changes.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAdapter, listJurisdictions } from '../../../../packages/domains/books/src/jurisdictions/registry';
import {
  US_ENTITY_TYPES,
  US_ENTITY_TYPE_INFO,
  US_TAX_CLASSIFICATIONS,
  US_TAX_CLASSIFICATION_LABELS,
  taxFormForClassification,
} from '../../../../packages/domains/books/src/jurisdictions/us/entity-types';
import {
  TAX_FORM_LABELS,
  TAX_LINE_CATEGORY_KEYS,
  TAX_LINE_FIRST_YEAR,
  TAX_RETURN_FORMS,
  getTaxLineCatalog,
  resolveTaxLine,
} from '../../../../packages/domains/books/src/jurisdictions/us/tax-lines';
import { FORM_1099_BOXES, FORM_1099_OMIT } from '../../../../packages/domains/books/src/jurisdictions/us/form-1099';
import { US_STATES, US_TERRITORIES } from '../../../../packages/domains/books/src/jurisdictions/us/states';
import { NEXUS_RULES } from '../../../../packages/domains/books/src/jurisdictions/us/nexus-thresholds';
import {
  BR_ENTITY_TYPES,
  BR_TAX_REGIMES,
  allowedBrRegimes,
} from '../../../../packages/domains/books/src/jurisdictions/br/index';
import {
  NL_EU_SERVICES_RATE_NAME,
  NL_ICL_GOODS_RATE_NAME,
  NL_LEGACY_EU_RATE_NAME,
} from '../../../../packages/domains/books/src/jurisdictions/nl/index';
import { BR_STATES, timezoneOfUf } from '../../../../packages/domains/books/src/jurisdictions/br/index';
import { GST_STATES } from '../../../../packages/domains/books/src/jurisdictions/in/states';
import { IBAN_LENGTHS } from '../../../../packages/domains/books/src/identifiers';
import { TAX_SECTION_LABELS } from '../../../../apps/workers/books-api/src/services/accounting-tax-worksheet';

const here = path.dirname(fileURLToPath(import.meta.url));

const summaries = listJurisdictions();
const codes = summaries.map((s) => s.code);

const adapters = Object.fromEntries(
  codes.map((code) => {
    const a = getAdapter(code);
    return [
      code,
      {
        code: a.code,
        name: a.name,
        defaultLocale: a.defaultLocale,
        defaultCurrency: a.defaultCurrency,
        purchaseTax: (a as { purchaseTax?: string }).purchaseTax ?? null,
        badDebtVatRelief: (a as { badDebtVatRelief?: boolean }).badDebtVatRelief ?? false,
        defaultPadding: a.getInvoiceRequirements(a.defaultLocale).defaultPadding,
      },
    ];
  }),
);

/** `type|classification`, an empty part for null. */
const key = (type: string | null, classification: string | null) => `${type ?? ''}|${classification ?? ''}`;

const charts: Record<string, unknown> = {};
const taxCategories: Record<string, unknown> = {};
for (const code of codes) {
  const adapter = getAdapter(code);
  if (code === 'US') {
    const byKind: Record<string, unknown> = {};
    const catsByKind: Record<string, unknown> = {};
    for (const type of [null, ...US_ENTITY_TYPES]) {
      for (const classification of [null, ...US_TAX_CLASSIFICATIONS]) {
        byKind[key(type, classification)] = adapter.getChartOfAccountsTemplate({ entityType: type, taxClassification: classification });
        catsByKind[key(type, classification)] = adapter.getStandardTaxCategories({ entityType: type, taxClassification: classification });
      }
    }
    charts[code] = byKind;
    taxCategories[code] = catsByKind;
  } else if (code === 'BR') {
    charts[code] = { '|': adapter.getChartOfAccountsTemplate({}) };
    const cats: Record<string, unknown> = {};
    for (const regime of [null, ...BR_TAX_REGIMES]) cats[key(null, regime)] = adapter.getStandardTaxCategories({ taxClassification: regime });
    taxCategories[code] = cats;
  } else {
    charts[code] = { '|': adapter.getChartOfAccountsTemplate({}) };
    taxCategories[code] = { '|': adapter.getStandardTaxCategories({}) };
  }
}

const layouts = { v2023: TAX_LINE_FIRST_YEAR, v2025: 2025 } as const;
const catalogs = Object.fromEntries(
  TAX_RETURN_FORMS.map((form) => [form, Object.fromEntries(Object.entries(layouts).map(([layout, year]) => [layout, getTaxLineCatalog(form, year)]))]),
);
const taxLineMap = Object.fromEntries(
  TAX_LINE_CATEGORY_KEYS.map((category) => [
    category,
    Object.fromEntries(
      TAX_RETURN_FORMS.map((form) => [
        form,
        Object.fromEntries(Object.entries(layouts).map(([layout, year]) => [layout, resolveTaxLine(category, form, year)?.code ?? null])),
      ]),
    ),
  ]),
);

/** Many keys share one template: `{ templates: [...], byKey: { key: index } }`. */
function dedupe(byKey: Record<string, unknown>) {
  const templates: unknown[] = [];
  const seen = new Map<string, number>();
  const index: Record<string, number> = {};
  for (const [k, value] of Object.entries(byKey)) {
    const text = JSON.stringify(value);
    let at = seen.get(text);
    if (at === undefined) {
      at = templates.length;
      templates.push(value);
      seen.set(text, at);
    }
    index[k] = at;
  }
  return { templates, byKey: index };
}

const out = {
  $comment: 'Generated by rust/crates/books-domain/tools/export.mts from @weldsuite/books-domain; do not edit.',
  summaries,
  adapters,
  charts: Object.fromEntries(Object.entries(charts).map(([code, byKey]) => [code, dedupe(byKey as Record<string, unknown>)])),
  taxCategories: Object.fromEntries(Object.entries(taxCategories).map(([code, byKey]) => [code, dedupe(byKey as Record<string, unknown>)])),
  nl: {
    euServicesRateName: NL_EU_SERVICES_RATE_NAME,
    iclGoodsRateName: NL_ICL_GOODS_RATE_NAME,
    legacyEuRateName: NL_LEGACY_EU_RATE_NAME,
  },
  us: {
    entityTypes: US_ENTITY_TYPES,
    classifications: US_TAX_CLASSIFICATIONS,
    entityTypeInfo: US_ENTITY_TYPE_INFO,
    classificationLabels: US_TAX_CLASSIFICATION_LABELS,
    formByClassification: Object.fromEntries(US_TAX_CLASSIFICATIONS.map((c) => [c, taxFormForClassification(c)])),
    forms: TAX_RETURN_FORMS,
    formLabels: TAX_FORM_LABELS,
    sectionLabels: TAX_SECTION_LABELS,
    taxLineFirstYear: TAX_LINE_FIRST_YEAR,
    taxLineCategories: TAX_LINE_CATEGORY_KEYS,
    catalogs,
    taxLineMap,
    form1099Omit: FORM_1099_OMIT,
    form1099Boxes: FORM_1099_BOXES.map((box) => box.code),
    stateCodes: US_STATES.map((s) => s.code),
    states: US_STATES,
    territoryCodes: US_TERRITORIES.map((t) => t.code),
    nexusRules: NEXUS_RULES,
  },
  br: {
    entityTypes: BR_ENTITY_TYPES,
    regimes: BR_TAX_REGIMES,
    allowedRegimes: Object.fromEntries([null, ...BR_ENTITY_TYPES].map((type) => [type ?? '', allowedBrRegimes(type)])),
    states: BR_STATES.map((s) => ({ uf: s.uf, name: s.name, ibge: s.ibge, timezone: timezoneOfUf(s.uf) })),
  },
  in: { gstStateCodes: GST_STATES.map((s) => s.code) },
  ibanLengths: IBAN_LENGTHS,
};

mkdirSync(path.join(here, '../data'), { recursive: true });
writeFileSync(path.join(here, '../data/jurisdictions.json'), `${JSON.stringify(out, null, 1)}\n`);
console.log(`wrote jurisdictions.json (${codes.join(', ')})`);
