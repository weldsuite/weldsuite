/**
 * What leaves the system on a 1099: the IRIS upload files (the only place full
 * TINs are written out, besides the TIN-matching file), the recipient copy
 * data (last four digits only) and the IRS TIN-matching round trip.
 *
 * Every full TIN that is decrypted for an output gets a `tax_id_reveals` row
 * before the content is returned: no log row, no file.
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { decryptField } from '@weldsuite/db/lib/crypto';
import { hasContextPermission } from '@weldsuite/permissions/server';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { atomically } from '@weldsuite/worker-kit/atomically';
import type { Form1099Type } from '@weldsuite/books-domain/jurisdictions/us/form-1099';
import { isTinType, maskTin, type TinType } from '@weldsuite/books-domain/jurisdictions/us/identifiers';
import {
  FORM_1099_COPIES,
  form1099PdfCopies,
  type Form1099Copy,
} from '@weldsuite/books-domain/us-compliance/form-1099-pdf-data';
import { generateIrisCsv, type IrisRecipient } from '@weldsuite/books-domain/us-compliance/iris-csv';
import {
  buildTinMatchingFiles,
  parseTinMatchingResults,
  tinMatchAccountNumber,
  type TinMatchRecord,
} from '@weldsuite/books-domain/us-compliance/tin-matching';
import { readSensitive, requireKeyring, type PartyW9 } from '../vendor-tax-data';
import { Form1099Error } from './errors';
import { linesForFile, loadFiling, loadLines, type LineRow } from './filings';
import { loadEntityOrThrow } from './load';
import { loadPayer } from './payer';
import { TIN_MATCH_PROBLEMS } from './summary';

type KeyEnv = { DATABASE_ENCRYPTION_KEY?: string; DATABASE_ENCRYPTION_KEY_V2?: string };

function amountsOf(line: LineRow, form: Form1099Type): IrisRecipient['boxes'] {
  const boxes: IrisRecipient['boxes'] = {};
  for (const [code, value] of Object.entries(line.boxes)) {
    if (code.startsWith(`${form}_`)) (boxes as Record<string, number>)[code] = value;
  }
  return boxes;
}

function recipientAddress(line: LineRow) {
  const a = line.recipient?.address ?? {};
  return {
    line1: a.line1 ?? '',
    line2: a.line2 ?? null,
    city: a.city ?? '',
    state: a.state ?? '',
    zip: a.postalCode ?? '',
    country: a.country && a.country !== 'US' ? a.country : null,
  };
}

function statesOf(line: LineRow): IrisRecipient['states'] {
  if (!line.stateCode) return [];
  return [
    {
      code: line.stateCode,
      payerStateNumber: line.stateIdNumber,
      withheld: line.stateWithheld === null ? null : Number(line.stateWithheld),
      income: line.stateIncome === null ? null : Number(line.stateIncome),
    },
  ];
}

// ---------------------------------------------------------------------------
// IRIS
// ---------------------------------------------------------------------------

export interface IrisFileResult {
  files: Array<{ filename: string; content: string; recordCount: number; warnings: string[] }>;
  taxYear: number;
  formType: Form1099Type;
  /** The filing is a correction run: only the corrections go in the file. */
  correctionsOnly: boolean;
}

/** Parses the header row of the IRIS template, given as a JSON array or as one CSV line. */
export function parseTemplateHeaders(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (Array.isArray(raw)) return raw.map((h) => String(h).trim());
  const text = String(raw).trim();
  if (text.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.map((h) => String(h).trim());
    } catch {
      // not JSON: read it as a CSV line
    }
  }
  const headers: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        current += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else current += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      headers.push(current.trim());
      current = '';
    } else current += ch;
  }
  headers.push(current.trim());
  return headers;
}

export async function buildIrisFiles(
  db: Database,
  env: KeyEnv,
  args: { entityId: string; filingId: string; userId: string; templateHeaders?: string[] },
): Promise<IrisFileResult> {
  const filing = await loadFiling(db, args.entityId, args.filingId);
  if (!['generated', 'filed', 'corrected'].includes(filing.status)) {
    throw new Form1099Error('conflict', `Generate the filing before creating the IRIS file; this one is ${filing.status}.`);
  }
  const form = filing.formType as Form1099Type;
  const lines = linesForFile(filing, await loadLines(db, filing.id));
  if (lines.length === 0) throw new Form1099Error('conflict', 'There are no recipients to put in the file.');

  const entity = await loadEntityOrThrow(db, args.entityId);
  const payer = await loadPayer(db, entity, { env, revealSsn: true, userId: args.userId, reason: 'iris_file' });
  if (payer.issues.length > 0 || !payer.tin || !payer.address) {
    throw new Form1099Error('conflict', 'The payer details are incomplete', { issues: payer.issues });
  }

  const keyring = requireKeyring(env);
  const recipients: IrisRecipient[] = [];
  for (const line of lines) {
    if (!line.recipientTinEncrypted) {
      throw new Form1099Error('conflict', `${line.recipient?.name ?? line.partyId} has no TIN on this filing`, { lineId: line.id });
    }
    const tin = await decryptField(line.recipientTinEncrypted, keyring);
    recipients.push({
      id: line.recipient?.name ?? line.id,
      legalName: line.recipient?.name ?? '',
      businessName: line.recipient?.businessName ?? null,
      tinType: isTinType(line.recipient?.tinType) ? (line.recipient!.tinType as TinType) : 'ein',
      tin,
      address: recipientAddress(line),
      accountNumber: line.recipient?.accountNumber ?? null,
      corrected: line.isCorrected,
      boxes: amountsOf(line, form),
      states: statesOf(line),
    });
  }

  // No log row, no file.
  await db.insert(schema.taxIdReveals).values(
    lines.map((line) => ({
      id: generateId('tir'),
      entityId: args.entityId,
      subjectType: 'form_1099_line',
      subjectId: line.id,
      field: 'tin',
      revealedBy: args.userId,
      reason: 'iris_file',
    })),
  );

  const files = generateIrisCsv({
    taxYear: filing.taxYear,
    form,
    payer: {
      name: payer.name,
      nameLine2: payer.nameLine2,
      tinType: payer.tinType,
      tin: payer.tin,
      address: payer.address,
      phone: payer.phone,
      email: payer.email,
    },
    recipients,
    templateHeaders: args.templateHeaders,
  });
  return {
    files: files.map(({ filename, content, recordCount, warnings }) => ({ filename, content, recordCount, warnings })),
    taxYear: filing.taxYear,
    formType: form,
    correctionsOnly: filing.status === 'corrected',
  };
}

// ---------------------------------------------------------------------------
// Recipient copies
// ---------------------------------------------------------------------------

export function parseCopies(raw: string | undefined): Form1099Copy[] | undefined {
  if (!raw) return undefined;
  const copies = raw
    .split(',')
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);
  const allowed = FORM_1099_COPIES as readonly string[];
  const bad = copies.find((c) => !allowed.includes(c));
  if (bad) throw new Form1099Error('bad_request', `Unknown copy ${bad}; use ${FORM_1099_COPIES.join(', ')}`);
  return copies as Form1099Copy[];
}

/** Layout data for the jsPDF renderer: the recipient's TIN is only its last four digits. */
export async function buildCopies(
  db: Database,
  env: KeyEnv,
  c: unknown,
  args: { entityId: string; filingId: string; lineId: string; copies?: Form1099Copy[]; userId: string },
) {
  const filing = await loadFiling(db, args.entityId, args.filingId);
  const lines = await loadLines(db, filing.id);
  const line = lines.find((l) => l.id === args.lineId);
  if (!line) throw new Form1099Error('not_found', `Filing line ${args.lineId} not found`);
  if (!line.recipient?.tinLast4 || !isTinType(line.recipient.tinType)) {
    throw new Form1099Error('conflict', 'This recipient has no TIN on the filing yet');
  }
  const form = filing.formType as Form1099Type;
  const entity = await loadEntityOrThrow(db, args.entityId);

  // A payer SSN is printed in full only for someone who may reveal it; otherwise truncated.
  const mayReveal = await hasContextPermission(c, 'tax_ids:reveal');
  const payer = await loadPayer(db, entity, { env, revealSsn: mayReveal, userId: args.userId, reason: 'form_1099_copy' });
  const warnings = [...payer.issues];
  let payerTin = payer.tin;
  if (!payerTin) {
    payerTin = payer.tinMasked ?? '';
    if (payer.tinType === 'ssn') warnings.push('The payer TIN is an SSN and is printed truncated: revealing it needs the tax_ids:reveal permission.');
  }
  if (!payer.address) throw new Form1099Error('conflict', 'The accounting entity needs an address before forms can be printed');

  const address = recipientAddress(line);
  const copies = form1099PdfCopies({
    form,
    taxYear: filing.taxYear,
    payer: {
      name: payer.name,
      nameLine2: payer.nameLine2,
      address: payer.address,
      phone: payer.phone,
      tinType: payer.tinType,
      tin: payerTin,
    },
    recipient: {
      name: line.recipient.name,
      businessName: line.recipient.businessName ?? null,
      address,
      tinType: line.recipient.tinType as TinType,
      tinLast4: line.recipient.tinLast4,
      accountNumber: line.recipient.accountNumber ?? null,
    },
    boxes: amountsOf(line, form),
    corrected: line.isCorrected,
    states: statesOf(line),
    copies: args.copies,
  });
  return {
    taxYear: filing.taxYear,
    formType: form,
    lineId: line.id,
    recipientTin: maskTin(line.recipient.tinLast4, line.recipient.tinType as TinType),
    copies,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// TIN matching
// ---------------------------------------------------------------------------

export async function buildTinMatching(
  db: Database,
  env: KeyEnv,
  args: { entityId: string | null; userId: string; all?: boolean; partyIds?: string[] },
) {
  const keyring = requireKeyring(env);
  const parties = await db
    .select()
    .from(schema.parties)
    .where(
      and(
        eq(schema.parties.is1099Vendor, true),
        isNull(schema.parties.deletedAt),
        args.partyIds && args.partyIds.length > 0 ? inArray(schema.parties.id, args.partyIds) : undefined,
      ),
    );
  const candidates = parties.filter(
    (p) => p.tinLast4 && p.sensitiveEncrypted && (args.all || args.partyIds?.length || p.tinMatchStatus !== 'match'),
  );

  const records: TinMatchRecord[] = [];
  const tinParties: string[] = [];
  for (const party of candidates) {
    const tin = (await readSensitive(party, keyring)).tin;
    if (!tin) continue;
    const w9 = party.w9 as PartyW9 | null;
    records.push({
      partyId: party.id,
      tinType: isTinType(party.tinType) ? party.tinType : 'unknown',
      tin,
      name: w9?.legalName?.trim() || party.displayName || '',
    });
    tinParties.push(party.id);
  }

  const built = buildTinMatchingFiles(records);
  const skippedIds = new Set(built.skipped.map((s) => s.partyId));
  const included = tinParties.filter((id) => !skippedIds.has(id));
  if (included.length > 0) {
    await db.insert(schema.taxIdReveals).values(
      included.map((id) => ({
        id: generateId('tir'),
        entityId: args.entityId,
        subjectType: 'party',
        subjectId: id,
        field: 'tin',
        revealedBy: args.userId,
        reason: 'tin_matching',
      })),
    );
  }
  const names = new Map(parties.map((p) => [p.id, p.displayName ?? '']));
  return {
    files: built.files,
    recordCount: included.length,
    skipped: built.skipped.map((s) => ({ ...s, name: names.get(s.partyId) ?? null })),
  };
}

const RESULT_TO_STATUS: Record<string, string> = {
  match: 'match',
  mismatch: 'mismatch',
  not_issued: 'not_issued',
  invalid: 'invalid',
};

export async function applyTinMatchingResults(db: Database, text: string) {
  const parties = await db
    .select({
      id: schema.parties.id,
      displayName: schema.parties.displayName,
      tinLast4: schema.parties.tinLast4,
      backupWithholding: schema.parties.backupWithholding,
    })
    .from(schema.parties)
    .where(isNull(schema.parties.deletedAt));
  const accountToParty: Record<string, string> = {};
  for (const party of parties) if (party.tinLast4) accountToParty[tinMatchAccountNumber(party.id)] = party.id;
  const byId = new Map(parties.map((p) => [p.id, p]));

  const parsed = parseTinMatchingResults(text, { accountToParty });
  const now = new Date();
  const updates: Array<{ id: string; status: string }> = [];
  const unknown: Array<{ line: number; accountNumber: string }> = [];
  const stale: Array<{ partyId: string; name: string | null }> = [];
  const ignored: Array<{ line: number; code: number; reason: string }> = [];

  for (const result of parsed.results) {
    const party = result.partyId ? byId.get(result.partyId) : undefined;
    if (!party) {
      unknown.push({ line: result.line, accountNumber: result.accountNumber });
      continue;
    }
    const status = RESULT_TO_STATUS[result.status];
    if (!status) {
      ignored.push({ line: result.line, code: result.code, reason: 'The IRS reports a duplicate request; no result for this record.' });
      continue;
    }
    // The TIN changed since the file went out: the result is about the old one.
    if (result.tinLast4 && party.tinLast4 && result.tinLast4 !== party.tinLast4) {
      stale.push({ partyId: party.id, name: party.displayName });
      continue;
    }
    updates.push({ id: party.id, status });
  }

  const latest = new Map(updates.map((u) => [u.id, u.status]));
  if (latest.size > 0) {
    await atomically(db, (h) =>
      [...latest].map(([id, status]) =>
        h.update(schema.parties).set({ tinMatchStatus: status, tinMatchedAt: now, updatedAt: now }).where(eq(schema.parties.id, id)),
      ),
    );
  }

  const byStatus: Record<string, number> = {};
  for (const status of latest.values()) byStatus[status] = (byStatus[status] ?? 0) + 1;
  const problems = [...latest]
    .filter(([, status]) => TIN_MATCH_PROBLEMS.includes(status))
    .map(([id, status]) => {
      const party = byId.get(id)!;
      return {
        partyId: id,
        name: party.displayName,
        status,
        backupWithholding: Boolean(party.backupWithholding),
        suggestion: party.backupWithholding
          ? 'Backup withholding is already on.'
          : 'Send a first B notice and ask for a new W-9; turn on backup withholding if none arrives within 30 business days.',
      };
    });
  return {
    updated: [...latest.keys()],
    byStatus,
    problems,
    stale,
    unknownAccounts: unknown,
    ignored,
    unreadable: parsed.unreadable,
  };
}
