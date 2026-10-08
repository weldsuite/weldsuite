/**
 * The fixed asset form without the React: the values it edits, the validation
 * schema, and the two conversions to what the API takes.
 *
 * Every field is a string (or a boolean), so a blank is a blank: the create
 * payload leaves a blank out and the server fills in its default, while a
 * value the user typed is always sent, even when it equals the default. The
 * books are only sent when the user chose to customise them.
 */
import { z } from 'zod';
import type {
  BookInput,
  BookKind,
  CreateAssetInput,
  DepreciationConvention,
  DepreciationMethod,
  FixedAssetBook,
  FixedAssetDetail,
  FromBillLineInput,
  UpdateAssetInput,
} from '@/lib/api/domains/weldbooks-assets';
import { isMacrsMethod, parseAmount, toCents, type PreviewBook } from './asset-math';

export interface BookFormValues {
  book: BookKind;
  /** State books only. */
  stateCode: string;
  method: DepreciationMethod;
  /** Blank: the server picks the convention (MACRS books follow the mid-quarter test). */
  convention: '' | DepreciationConvention;
  recoveryYears: string;
  section179Amount: string;
  bonusPercent: string;
  postsToLedger: boolean;
}

export interface AssetFormValues {
  name: string;
  assetNumber: string;
  description: string;
  assetClass: string;
  acquisitionDate: string;
  /** Blank: the same day as the acquisition. */
  placedInServiceDate: string;
  cost: string;
  salvageValue: string;
  /** Blank: 100. */
  businessUsePercent: string;
  listedProperty: boolean;
  /** Blank: the MACRS class, else 5 years. */
  usefulLifeYears: string;
  section179Amount: string;
  bonusPercent: string;
  bonusReducedElection: boolean;
  /** Blank: the chart's default account for the role. */
  assetAccountId: string;
  accumulatedDepreciationAccountId: string;
  depreciationExpenseAccountId: string;
  classId: string;
  locationId: string;
  notes: string;
  customizeBooks: boolean;
  books: BookFormValues[];
}

export function emptyAssetForm(today = ''): AssetFormValues {
  return {
    name: '',
    assetNumber: '',
    description: '',
    assetClass: '',
    acquisitionDate: today,
    placedInServiceDate: '',
    cost: '',
    salvageValue: '',
    businessUsePercent: '',
    listedProperty: false,
    usefulLifeYears: '',
    section179Amount: '',
    bonusPercent: '',
    bonusReducedElection: false,
    assetAccountId: '',
    accumulatedDepreciationAccountId: '',
    depreciationExpenseAccountId: '',
    classId: '',
    locationId: '',
    notes: '',
    customizeBooks: false,
    books: [],
  };
}

export function emptyBook(book: BookKind = 'book'): BookFormValues {
  return {
    book,
    stateCode: '',
    method: book === 'book' ? 'straight_line' : 'macrs_gds',
    convention: '',
    recoveryYears: '',
    section179Amount: '',
    bonusPercent: '',
    postsToLedger: book === 'book',
  };
}

const plain = (value: string | null | undefined): string => value ?? '';

/** The default books of the preview as editable rows: what "customise the books" starts from. */
export function booksFromPreview(preview: readonly PreviewBook[]): BookFormValues[] {
  return preview.map((book) => ({
    book: book.book,
    stateCode: '',
    method: book.method,
    convention: '',
    recoveryYears: String(book.recoveryYears),
    section179Amount: book.section179Amount > 0 ? String(book.section179Amount) : '',
    // Only a bonus the user typed travels as typed; a rule-derived one is left to the server, so it keeps following the dates.
    bonusPercent: book.bonusRule === 'entered' && book.bonusPercent > 0 ? String(book.bonusPercent) : '',
    postsToLedger: book.postsToLedger,
  }));
}

/** Numeric columns come back as `"5.0"` or `"100.0000"`: show them without the padding. */
export function trimNumber(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  const parsed = Number(value);
  return Number.isFinite(parsed) ? String(parsed) : String(value);
}

export function bookFormFrom(book: FixedAssetBook): BookFormValues {
  return {
    book: book.book,
    stateCode: plain(book.stateCode),
    method: book.method,
    convention: book.convention,
    recoveryYears: trimNumber(book.recoveryYears),
    section179Amount: Number(book.section179Amount) > 0 ? trimNumber(book.section179Amount) : '',
    bonusPercent: Number(book.bonusPercent) > 0 ? trimNumber(book.bonusPercent) : '',
    postsToLedger: book.postsToLedger,
  };
}

/** Listed property is not stored on the asset; a book forced to ADS at 50% business use or less is what it leaves behind. */
export function looksLikeListedProperty(asset: Pick<FixedAssetDetail, 'businessUsePercent'>, books: readonly Pick<FixedAssetBook, 'method'>[]): boolean {
  return Number(asset.businessUsePercent) <= 50 && books.some((book) => book.method === 'macrs_ads');
}

/** The form filled from a stored asset (the edit page): the books are listed as they are stored and always editable. */
export function assetFormFromDetail(detail: FixedAssetDetail): AssetFormValues {
  const business = Number(detail.businessUsePercent);
  return {
    name: detail.name,
    assetNumber: plain(detail.assetNumber),
    description: plain(detail.description),
    assetClass: plain(detail.assetClass),
    acquisitionDate: detail.acquisitionDate,
    placedInServiceDate: detail.placedInServiceDate,
    cost: trimNumber(detail.cost),
    salvageValue: trimNumber(detail.salvageValue),
    businessUsePercent: business === 100 ? '' : trimNumber(detail.businessUsePercent),
    listedProperty: looksLikeListedProperty(detail, detail.books),
    usefulLifeYears: '',
    section179Amount: '',
    bonusPercent: '',
    bonusReducedElection: false,
    assetAccountId: detail.assetAccountId,
    accumulatedDepreciationAccountId: detail.accumulatedDepreciationAccountId,
    depreciationExpenseAccountId: detail.depreciationExpenseAccountId,
    classId: plain(detail.classId),
    locationId: plain(detail.locationId),
    notes: plain(detail.notes),
    customizeBooks: true,
    books: detail.books.map(bookFormFrom),
  };
}

// ---------------------------------------------------------------------------
// Validation

export interface AssetFormTexts {
  nameRequired: string;
  dateRequired: string;
  dateInvalid: string;
  amountInvalid: string;
  costPositive: string;
  amountNegative: string;
  percentRange: string;
  placedBeforeAcquired: string;
  salvageOverCost: string;
  lifeRange: string;
  section179Over: string;
  recoveryPositive: string;
  stateRequired: string;
  duplicateBook: string;
  oneLedgerBook: string;
  ledgerOnBook: string;
  section179NeedsMacrs: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Blank is fine for an optional number; anything else has to read as one. */
function optionalNumber(value: string): number | null | 'invalid' {
  if (value.trim() === '') return null;
  const parsed = parseAmount(value);
  return parsed === null ? 'invalid' : parsed;
}

/**
 * `billLine`: the asset is created from a bill line, which supplies the name,
 * the date and the cost when the form leaves them blank.
 */
export function makeAssetSchema(texts: AssetFormTexts, options: { billLine?: boolean } = {}) {
  const fromBillLine = options.billLine === true;
  const book = z.object({
    book: z.enum(['book', 'federal', 'state']),
    stateCode: z.string(),
    method: z.enum(['straight_line', 'declining_balance', 'macrs_gds', 'macrs_ads', 'expensed', 'none']),
    convention: z.enum(['', 'half_year', 'mid_quarter', 'mid_month', 'full_month']),
    recoveryYears: z.string(),
    section179Amount: z.string(),
    bonusPercent: z.string(),
    postsToLedger: z.boolean(),
  });

  return z
    .object({
      name: z.string(),
      assetNumber: z.string(),
      description: z.string(),
      assetClass: z.string(),
      acquisitionDate: z.string().refine((value) => value === '' || ISO_DATE.test(value), texts.dateInvalid),
      placedInServiceDate: z.string().refine((value) => value === '' || ISO_DATE.test(value), texts.dateInvalid),
      cost: z.string(),
      salvageValue: z.string(),
      businessUsePercent: z.string(),
      listedProperty: z.boolean(),
      usefulLifeYears: z.string(),
      section179Amount: z.string(),
      bonusPercent: z.string(),
      bonusReducedElection: z.boolean(),
      assetAccountId: z.string(),
      accumulatedDepreciationAccountId: z.string(),
      depreciationExpenseAccountId: z.string(),
      classId: z.string(),
      locationId: z.string(),
      notes: z.string(),
      customizeBooks: z.boolean(),
      books: z.array(book),
    })
    .superRefine((values, ctx) => {
      const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });

      if (!fromBillLine && values.name.trim() === '') issue(['name'], texts.nameRequired);
      if (!fromBillLine && values.acquisitionDate === '') issue(['acquisitionDate'], texts.dateRequired);

      const cost = parseAmount(values.cost);
      if (values.cost.trim() === '') {
        if (!fromBillLine) issue(['cost'], texts.amountInvalid);
      } else if (cost === null) issue(['cost'], texts.amountInvalid);
      else if (cost <= 0) issue(['cost'], texts.costPositive);

      const salvage = optionalNumber(values.salvageValue);
      if (salvage === 'invalid') issue(['salvageValue'], texts.amountInvalid);
      else if (salvage !== null && salvage < 0) issue(['salvageValue'], texts.amountNegative);
      else if (salvage !== null && cost !== null && toCents(salvage) > toCents(cost)) issue(['salvageValue'], texts.salvageOverCost);

      const business = optionalNumber(values.businessUsePercent);
      if (business === 'invalid' || (business !== null && (business < 0 || business > 100))) issue(['businessUsePercent'], texts.percentRange);

      const life = optionalNumber(values.usefulLifeYears);
      if (life === 'invalid' || (life !== null && (life <= 0 || life > 100))) issue(['usefulLifeYears'], texts.lifeRange);

      const bonus = optionalNumber(values.bonusPercent);
      if (bonus === 'invalid' || (bonus !== null && (bonus < 0 || bonus > 100))) issue(['bonusPercent'], texts.percentRange);

      const section179 = optionalNumber(values.section179Amount);
      if (section179 === 'invalid') issue(['section179Amount'], texts.amountInvalid);
      else if (section179 !== null && section179 < 0) issue(['section179Amount'], texts.amountNegative);
      else if (section179 !== null && cost !== null) {
        const businessCost = Math.round(cost * (business === null || business === 'invalid' ? 100 : business)) / 100;
        if (toCents(section179) > toCents(businessCost)) issue(['section179Amount'], texts.section179Over);
      }

      if (values.placedInServiceDate && values.acquisitionDate && ISO_DATE.test(values.acquisitionDate) && values.placedInServiceDate < values.acquisitionDate) {
        issue(['placedInServiceDate'], texts.placedBeforeAcquired);
      }

      if (values.customizeBooks) {
        const seen = new Set<string>();
        let ledgerBooks = 0;
        values.books.forEach((row, index) => {
          const key = `${row.book}:${row.book === 'state' ? row.stateCode.toUpperCase() : ''}`;
          if (seen.has(key)) issue(['books', index, 'book'], texts.duplicateBook);
          seen.add(key);
          if (row.book === 'state' && !/^[A-Za-z]{2}$/.test(row.stateCode)) issue(['books', index, 'stateCode'], texts.stateRequired);
          if (row.postsToLedger) {
            ledgerBooks += 1;
            if (row.book !== 'book') issue(['books', index, 'postsToLedger'], texts.ledgerOnBook);
          }
          const years = optionalNumber(row.recoveryYears);
          const needsYears = row.method !== 'expensed' && row.method !== 'none';
          if (years === 'invalid' || (needsYears && (years === null || years <= 0)) || (years !== null && years > 100)) {
            issue(['books', index, 'recoveryYears'], texts.recoveryPositive);
          }
          const rowBonus = optionalNumber(row.bonusPercent);
          if (rowBonus === 'invalid' || (rowBonus !== null && (rowBonus < 0 || rowBonus > 100))) issue(['books', index, 'bonusPercent'], texts.percentRange);
          const row179 = optionalNumber(row.section179Amount);
          if (row179 === 'invalid') issue(['books', index, 'section179Amount'], texts.amountInvalid);
          else if (row179 !== null && row179 < 0) issue(['books', index, 'section179Amount'], texts.amountNegative);
          if (!isMacrsMethod(row.method) && ((typeof row179 === 'number' && row179 > 0) || (typeof rowBonus === 'number' && rowBonus > 0))) {
            issue(['books', index, 'section179Amount'], texts.section179NeedsMacrs);
          }
        });
        if (ledgerBooks > 1) issue(['books'], texts.oneLedgerBook);
      }
    });
}

// ---------------------------------------------------------------------------
// Payloads

const nonBlank = (value: string): string | undefined => (value.trim() === '' ? undefined : value.trim());
const amountOf = (value: string): number | undefined => {
  const parsed = parseAmount(value);
  return parsed === null ? undefined : parsed;
};

/** One form book as the API takes it; blank numbers and a blank convention are left to the server. */
export function bookInputFrom(row: BookFormValues): BookInput {
  const macrs = isMacrsMethod(row.method);
  const input: BookInput = {
    book: row.book,
    method: row.method,
    recoveryYears: amountOf(row.recoveryYears) ?? 0,
    postsToLedger: row.postsToLedger,
  };
  if (row.book === 'state') input.stateCode = row.stateCode.trim().toUpperCase();
  // MACRS books follow the mid-quarter test whatever convention is sent.
  if (row.convention && !macrs) input.convention = row.convention;
  if (macrs) {
    const section179 = amountOf(row.section179Amount);
    const bonus = amountOf(row.bonusPercent);
    if (section179 !== undefined) input.section179Amount = section179;
    if (bonus !== undefined) input.bonusPercent = bonus;
  }
  return input;
}

/**
 * The create payload: only what was filled in. Facts the user left blank are
 * not sent, so the server applies its defaults (the same-day placed-in-service
 * date, no salvage, full business use, the chart's accounts, the default
 * books). A US-only field is dropped for any other jurisdiction.
 */
export function buildCreateInput(values: AssetFormValues, options: { isUs: boolean }): CreateAssetInput {
  const input: CreateAssetInput = {
    name: values.name.trim(),
    acquisitionDate: values.acquisitionDate,
    cost: amountOf(values.cost) ?? 0,
  };
  const set = <K extends keyof CreateAssetInput>(key: K, value: CreateAssetInput[K] | undefined) => {
    if (value !== undefined) input[key] = value;
  };
  set('assetNumber', nonBlank(values.assetNumber));
  set('description', nonBlank(values.description));
  set('placedInServiceDate', nonBlank(values.placedInServiceDate));
  set('salvageValue', amountOf(values.salvageValue));
  set('usefulLifeYears', amountOf(values.usefulLifeYears));
  set('assetAccountId', nonBlank(values.assetAccountId));
  set('accumulatedDepreciationAccountId', nonBlank(values.accumulatedDepreciationAccountId));
  set('depreciationExpenseAccountId', nonBlank(values.depreciationExpenseAccountId));
  set('classId', nonBlank(values.classId));
  set('locationId', nonBlank(values.locationId));
  set('notes', nonBlank(values.notes));

  if (options.isUs) {
    set('assetClass', nonBlank(values.assetClass));
    set('businessUsePercent', amountOf(values.businessUsePercent));
    if (values.listedProperty) input.listedProperty = true;
  }
  if (values.customizeBooks) {
    input.books = values.books.map(bookInputFrom);
  } else if (options.isUs) {
    set('section179Amount', amountOf(values.section179Amount));
    set('bonusPercent', amountOf(values.bonusPercent));
    if (values.bonusReducedElection) input.bonusReducedElection = true;
  }
  return input;
}

/** The from-bill-line payload: the same blanks rule, with the name, date and cost left to the bill line when blank. */
export function buildFromBillLineInput(
  values: AssetFormValues,
  options: { isUs: boolean; billItemId: string; reclass: boolean },
): FromBillLineInput {
  const { name, acquisitionDate, cost, ...rest } = buildCreateInput(values, { isUs: options.isUs });
  const input: FromBillLineInput = { ...rest, billItemId: options.billItemId };
  if (values.name.trim() !== '') input.name = name;
  if (values.acquisitionDate !== '') input.acquisitionDate = acquisitionDate;
  if (values.cost.trim() !== '') input.cost = cost;
  if (options.reclass) input.reclass = true;
  return input;
}

const sameBooks = (a: readonly BookFormValues[], b: readonly BookFormValues[]): boolean =>
  a.length === b.length &&
  a.every((row, index) => {
    const other = b[index];
    return (
      !!other &&
      row.book === other.book &&
      row.stateCode.toUpperCase() === other.stateCode.toUpperCase() &&
      row.method === other.method &&
      (isMacrsMethod(row.method) || row.convention === other.convention) &&
      amountOf(row.recoveryYears) === amountOf(other.recoveryYears) &&
      (amountOf(row.section179Amount) ?? 0) === (amountOf(other.section179Amount) ?? 0) &&
      (amountOf(row.bonusPercent) ?? 0) === (amountOf(other.bonusPercent) ?? 0) &&
      row.postsToLedger === other.postsToLedger
    );
  });

/**
 * The update payload: only what changed from the stored asset. Once
 * depreciation is posted (`locked`) the financial facts and the books cannot
 * change, so they are never sent; the rest stays editable.
 */
export function buildUpdateInput(
  values: AssetFormValues,
  original: AssetFormValues,
  options: { locked: boolean; isUs: boolean },
): UpdateAssetInput {
  const input: UpdateAssetInput = {};
  const text = (key: 'name' | 'assetNumber' | 'description' | 'classId' | 'locationId' | 'notes') => {
    const next = values[key].trim();
    if (next === original[key].trim()) return;
    if (key === 'name') input.name = next;
    else input[key] = next === '' ? null : next;
  };
  text('name');
  text('assetNumber');
  text('description');
  text('classId');
  text('locationId');
  text('notes');

  if (options.locked) return input;

  if (values.acquisitionDate !== original.acquisitionDate) input.acquisitionDate = values.acquisitionDate;
  const placed = values.placedInServiceDate || values.acquisitionDate;
  if (placed !== (original.placedInServiceDate || original.acquisitionDate)) input.placedInServiceDate = placed;
  if (amountOf(values.cost) !== amountOf(original.cost)) input.cost = amountOf(values.cost);
  if ((amountOf(values.salvageValue) ?? 0) !== (amountOf(original.salvageValue) ?? 0)) input.salvageValue = amountOf(values.salvageValue) ?? 0;
  if (options.isUs && (amountOf(values.businessUsePercent) ?? 100) !== (amountOf(original.businessUsePercent) ?? 100)) {
    input.businessUsePercent = amountOf(values.businessUsePercent) ?? 100;
  }
  if (values.assetAccountId !== original.assetAccountId && values.assetAccountId) input.assetAccountId = values.assetAccountId;
  if (values.accumulatedDepreciationAccountId !== original.accumulatedDepreciationAccountId && values.accumulatedDepreciationAccountId) {
    input.accumulatedDepreciationAccountId = values.accumulatedDepreciationAccountId;
  }
  if (values.depreciationExpenseAccountId !== original.depreciationExpenseAccountId && values.depreciationExpenseAccountId) {
    input.depreciationExpenseAccountId = values.depreciationExpenseAccountId;
  }
  if (!sameBooks(values.books, original.books)) {
    input.books = values.books.map(bookInputFrom);
    if (values.listedProperty) input.listedProperty = true;
  }
  return input;
}
