/**
 * The payment settings form of a bank account, free of React: the shape of the
 * form (every field a string or a boolean, so inputs stay controlled), how the
 * stored settings fill it, and the update request a changed form makes.
 *
 * The server merges by section and key and `null` clears a key, so the request
 * carries only what changed. The EIN is write-only: it is sent when typed and
 * never read back.
 */
import { z } from 'zod';
import { routingNumberProblem } from '@/app/weldbooks/banking/components/routing-number';
import { einProblem } from '@/lib/weldbooks/us-entity';
import type {
  AchSecCode,
  BankPaymentSettings,
  CheckAlignment,
  CheckLayoutId,
  UpdatePaymentSettingsInput,
} from '@/lib/api/domains/weldbooks-payment-runs';

export interface SettingsFormValues {
  nextCheckNumber: string;
  layout: CheckLayoutId;
  printMicr: boolean;
  micrLayout: 'business' | 'personal';
  checkNumberWidth: string;
  bankName: string;
  /** One address line per row of the text area. */
  bankAddress: string;
  fractionalNumerator: string;
  signatureLineText: string;
  dx: string;
  dy: string;
  micrDx: string;
  micrDy: string;

  immediateDestination: string;
  immediateDestinationName: string;
  immediateOrigin: string;
  immediateOriginName: string;
  companyName: string;
  /** Write-only: becomes the company identification ("1" + EIN). */
  ein: string;
  odfiRoutingNumber: string;
  balanced: boolean;
  offsetBankAccountId: string;
  defaultSecCode: AchSecCode;
  sameDayAllowed: boolean;
  entryDescription: string;
  holdWindowDays: string;
  requirePrenotes: boolean;

  positivePayFormat: string;
}

const text = (value: string | null | undefined): string => value ?? '';
const num = (value: number | null | undefined): string => (value === null || value === undefined ? '' : String(value));

/** The form as the stored settings fill it. */
export function toFormValues(settings: BankPaymentSettings): SettingsFormValues {
  const check = settings.checkSettings;
  const ach = settings.achSettings;
  return {
    nextCheckNumber: num(settings.nextCheckNumber),
    layout: check.layout,
    printMicr: check.printMicr,
    micrLayout: check.micrLayout,
    checkNumberWidth: String(check.checkNumberWidth),
    bankName: text(check.bankName),
    bankAddress: check.bankAddressLines.join('\n'),
    fractionalNumerator: text(check.fractionalNumerator),
    signatureLineText: text(check.signatureLineText),
    dx: num(check.alignment.dx),
    dy: num(check.alignment.dy),
    micrDx: num(check.alignment.micrDx),
    micrDy: num(check.alignment.micrDy),

    immediateDestination: text(ach.immediateDestination),
    immediateDestinationName: text(ach.immediateDestinationName),
    immediateOrigin: text(ach.immediateOrigin),
    immediateOriginName: text(ach.immediateOriginName),
    companyName: text(ach.companyName),
    ein: '',
    odfiRoutingNumber: text(ach.odfiRoutingNumber),
    balanced: ach.balanced,
    offsetBankAccountId: text(ach.offsetBankAccountId),
    defaultSecCode: ach.defaultSecCode,
    sameDayAllowed: ach.sameDayAllowed,
    entryDescription: text(ach.entryDescription),
    holdWindowDays: String(ach.holdWindowDays),
    requirePrenotes: ach.requirePrenotes,

    positivePayFormat: settings.positivePayFormat,
  };
}

/** The printer calibration the form describes, in points; a blank field is no shift. */
export function alignmentOf(values: Pick<SettingsFormValues, 'dx' | 'dy' | 'micrDx' | 'micrDy'>): Required<CheckAlignment> {
  const read = (value: string): number => {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : 0;
  };
  return { dx: read(values.dx), dy: read(values.dy), micrDx: read(values.micrDx), micrDy: read(values.micrDy) };
}

const RESERVED_ENTRY_DESCRIPTIONS = ['PAYROLL', 'PURCHASE'];

/** What the form says when a field is wrong; the page passes translated text. */
export interface SettingsMessages {
  nextCheckNumber: string;
  alignment: string;
  numerator: string;
  routing: string;
  routingChecksum: string;
  origin: string;
  ein: string;
  entryDescriptionReserved: string;
  holdWindow: string;
  width: string;
  bankAddress: string;
  tooLong: string;
}

export function createSettingsSchema(messages: SettingsMessages) {
  const offset = z
    .string()
    .refine((v) => v.trim() === '' || (Number.isFinite(Number(v)) && Math.abs(Number(v)) <= 72), messages.alignment);
  const routing = z.string().superRefine((value, ctx) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    const problem = routingNumberProblem(trimmed);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem === 'format' ? messages.routing : messages.routingChecksum });
  });

  return z.object({
    nextCheckNumber: z.string().regex(/^\d{0,9}$/, messages.nextCheckNumber),
    layout: z.enum(['voucher_top', 'voucher_middle', 'voucher_bottom', 'three_per_page']),
    printMicr: z.boolean(),
    micrLayout: z.enum(['business', 'personal']),
    checkNumberWidth: z.string().refine((v) => /^\d+$/.test(v) && Number(v) >= 4 && Number(v) <= 12, messages.width),
    bankName: z.string().max(60, messages.tooLong),
    bankAddress: z.string().refine((v) => v.split('\n').filter((l) => l.trim()).length <= 3 && v.split('\n').every((l) => l.length <= 60), messages.bankAddress),
    fractionalNumerator: z.string().regex(/^(\d{1,2}-\d{1,4})?$/, messages.numerator),
    signatureLineText: z.string().max(60, messages.tooLong),
    dx: offset,
    dy: offset,
    micrDx: offset,
    micrDy: offset,

    immediateDestination: routing,
    immediateDestinationName: z.string().max(23, messages.tooLong),
    immediateOrigin: z.string().regex(/^([A-Za-z0-9 ]{9,10})?$/, messages.origin),
    immediateOriginName: z.string().max(23, messages.tooLong),
    companyName: z.string().max(16, messages.tooLong),
    ein: z.string().refine((v) => einProblem(v) === null && (v.trim() === '' || v.replace(/\D/g, '').length === 9), messages.ein),
    odfiRoutingNumber: routing,
    balanced: z.boolean(),
    offsetBankAccountId: z.string(),
    defaultSecCode: z.enum(['PPD', 'CCD', 'CCD+', 'CTX']),
    sameDayAllowed: z.boolean(),
    entryDescription: z
      .string()
      .max(10, messages.tooLong)
      .refine((v) => !RESERVED_ENTRY_DESCRIPTIONS.includes(v.trim().toUpperCase()), messages.entryDescriptionReserved),
    holdWindowDays: z.string().refine((v) => /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 365, messages.holdWindow),
    requirePrenotes: z.boolean(),

    positivePayFormat: z.string().min(1),
  });
}

const orNull = (value: string): string | null => (value.trim() === '' ? null : value.trim());

function addressLines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/**
 * The update request for a saved form: only the sections and keys that differ
 * from what was loaded. An empty request means nothing changed.
 */
export function toUpdateInput(values: SettingsFormValues, loaded: BankPaymentSettings): UpdatePaymentSettingsInput {
  const before = toFormValues(loaded);
  const input: UpdatePaymentSettingsInput = {};

  if (values.nextCheckNumber !== before.nextCheckNumber) {
    input.nextCheckNumber = values.nextCheckNumber === '' ? null : Number.parseInt(values.nextCheckNumber, 10);
  }

  const check: NonNullable<UpdatePaymentSettingsInput['checkSettings']> = {};
  if (values.layout !== before.layout) check.layout = values.layout;
  if (values.printMicr !== before.printMicr) check.printMicr = values.printMicr;
  if (values.micrLayout !== before.micrLayout) check.micrLayout = values.micrLayout;
  if (values.checkNumberWidth !== before.checkNumberWidth) check.checkNumberWidth = Number.parseInt(values.checkNumberWidth, 10);
  if (values.bankName !== before.bankName) check.bankName = orNull(values.bankName);
  if (values.bankAddress !== before.bankAddress) check.bankAddressLines = addressLines(values.bankAddress);
  if (values.fractionalNumerator !== before.fractionalNumerator) check.fractionalNumerator = orNull(values.fractionalNumerator);
  if (values.signatureLineText !== before.signatureLineText) check.signatureLineText = orNull(values.signatureLineText);
  if (
    values.dx !== before.dx ||
    values.dy !== before.dy ||
    values.micrDx !== before.micrDx ||
    values.micrDy !== before.micrDy
  ) {
    check.alignment = alignmentOf(values);
  }
  if (Object.keys(check).length > 0) input.checkSettings = check;

  const ach: NonNullable<UpdatePaymentSettingsInput['achSettings']> = {};
  if (values.immediateDestination !== before.immediateDestination) ach.immediateDestination = orNull(values.immediateDestination);
  if (values.immediateDestinationName !== before.immediateDestinationName) ach.immediateDestinationName = orNull(values.immediateDestinationName);
  if (values.immediateOrigin !== before.immediateOrigin) ach.immediateOrigin = orNull(values.immediateOrigin);
  if (values.immediateOriginName !== before.immediateOriginName) ach.immediateOriginName = orNull(values.immediateOriginName);
  if (values.companyName !== before.companyName) ach.companyName = orNull(values.companyName);
  if (values.ein.trim() !== '') ach.ein = values.ein.trim();
  if (values.odfiRoutingNumber !== before.odfiRoutingNumber) ach.odfiRoutingNumber = orNull(values.odfiRoutingNumber);
  if (values.balanced !== before.balanced) ach.balanced = values.balanced;
  if (values.offsetBankAccountId !== before.offsetBankAccountId) ach.offsetBankAccountId = orNull(values.offsetBankAccountId);
  if (values.defaultSecCode !== before.defaultSecCode) ach.defaultSecCode = values.defaultSecCode;
  if (values.sameDayAllowed !== before.sameDayAllowed) ach.sameDayAllowed = values.sameDayAllowed;
  if (values.entryDescription !== before.entryDescription) ach.entryDescription = orNull(values.entryDescription);
  if (values.holdWindowDays !== before.holdWindowDays) ach.holdWindowDays = Number.parseInt(values.holdWindowDays, 10);
  if (values.requirePrenotes !== before.requirePrenotes) ach.requirePrenotes = values.requirePrenotes;
  if (Object.keys(ach).length > 0) input.achSettings = ach;

  if (values.positivePayFormat !== before.positivePayFormat) input.positivePayFormat = values.positivePayFormat;

  return input;
}

/** `1•••••6789` for a company identification, which carries the EIN: only the ends are shown. */
export function maskedCompanyId(value: string | null | undefined): string {
  if (!value) return '—';
  if (value.length <= 5) return '•'.repeat(value.length);
  return `${value.slice(0, 1)}${'•'.repeat(value.length - 5)}${value.slice(-4)}`;
}
