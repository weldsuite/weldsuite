/**
 * SPED ECD export for a Brazilian entity: the posted journal of a fiscal year
 * as the leiaute 9 file (packages/domains/books/src/jurisdictions/br/ecd.ts).
 *
 * WeldBooks keeps no year-end closing entries, so result accounts carry their
 * balances across years in the ledger. The file starts every year with the
 * result accounts at zero and the earlier years' result in retained earnings,
 * and closes the year with a generated encerramento entry.
 */

import { and, asc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { brSettingsOf, buildEcd, type EcdEntry, type EcdResult, type EcdSignatory } from '@weldsuite/books-domain/jurisdictions/br';
import { accountForRole, loadEntityAccounts } from './accounting-posting';

type EntityRow = typeof schema.entities.$inferSelect;

export class BrEcdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrEcdError';
  }
}

function money(value: string | null | undefined): number {
  return Number.parseFloat(value ?? '0') || 0;
}

/** The fiscal year that ends in `year`, from the entity's fiscal year start month. */
export function fiscalYearRange(entity: Pick<EntityRow, 'fiscalYearStart'>, year: number): { start: string; end: string } {
  const startMonth = entity.fiscalYearStart ?? 1;
  const startYear = startMonth === 1 ? year : year - 1;
  const start = new Date(Date.UTC(startYear, startMonth - 1, 1));
  const end = new Date(Date.UTC(startYear + 1, startMonth - 1, 0));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

export async function buildEntityEcd(db: Database, entity: EntityRow, year: number, signatories: EcdSignatory[]): Promise<EcdResult> {
  if (entity.jurisdictionCode !== 'BR') throw new BrEcdError('The SPED ECD is for Brazilian entities only');
  const cnpj = entity.taxIdentifiers?.vatNumber;
  if (!cnpj) throw new BrEcdError("The entity's CNPJ is missing");
  const settings = brSettingsOf(entity.jurisdictionSettings);
  if (!settings.uf) throw new BrEcdError("The entity's state (UF) is missing");

  const { start, end } = fiscalYearRange(entity, year);
  const from = new Date(`${start}T00:00:00Z`);
  const to = new Date(`${end}T00:00:00Z`);
  to.setUTCDate(to.getUTCDate() + 1);

  const accountRows = await db
    .select({ id: schema.accounts.id, code: schema.accounts.code, name: schema.accounts.name, type: schema.accounts.type })
    .from(schema.accounts)
    .where(and(eq(schema.accounts.entityId, entity.id), isNull(schema.accounts.deletedAt)));
  const codeById = new Map(accountRows.map((a) => [a.id, a.code]));
  const typeByCode = new Map(accountRows.map((a) => [a.code, a.type]));

  const accounts = await loadEntityAccounts(db, entity.id);
  const retained = accountForRole(accounts, 'retained_earnings');
  if (!retained) throw new BrEcdError('No retained earnings account (Lucros ou prejuízos acumulados) in the chart');

  // Opening balances: everything posted before the year; earlier results go to retained earnings.
  const before = await db
    .select({
      accountId: schema.journalLines.accountId,
      net: sql<string>`coalesce(sum(coalesce(${schema.journalLines.baseCurrencyDebit}, ${schema.journalLines.debit}) - coalesce(${schema.journalLines.baseCurrencyCredit}, ${schema.journalLines.credit})), 0)`,
    })
    .from(schema.journalLines)
    .innerJoin(schema.journalEntries, eq(schema.journalLines.journalEntryId, schema.journalEntries.id))
    .where(and(eq(schema.journalLines.entityId, entity.id), lt(schema.journalEntries.date, from), eq(schema.journalEntries.status, 'posted')))
    .groupBy(schema.journalLines.accountId);
  const openingBalances: Record<string, number> = {};
  for (const row of before) {
    const code = codeById.get(row.accountId);
    if (!code) continue;
    const type = typeByCode.get(code);
    const target = type === 'revenue' || type === 'expense' ? retained.code : code;
    openingBalances[target] = (openingBalances[target] ?? 0) + Number.parseFloat(row.net);
  }

  const entryRows = await db
    .select({ id: schema.journalEntries.id, number: schema.journalEntries.entryNumber, date: schema.journalEntries.date, description: schema.journalEntries.description })
    .from(schema.journalEntries)
    .where(
      and(
        eq(schema.journalEntries.entityId, entity.id),
        eq(schema.journalEntries.status, 'posted'),
        gte(schema.journalEntries.date, from),
        lt(schema.journalEntries.date, to),
      ),
    )
    .orderBy(asc(schema.journalEntries.date));
  const entries: EcdEntry[] = [];
  const ids = entryRows.map((e) => e.id);
  const lineRows = [];
  // Large books: fetch the lines in chunks.
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    lineRows.push(
      ...(await db
        .select({
          journalEntryId: schema.journalLines.journalEntryId,
          accountId: schema.journalLines.accountId,
          debit: schema.journalLines.debit,
          credit: schema.journalLines.credit,
          baseDebit: schema.journalLines.baseCurrencyDebit,
          baseCredit: schema.journalLines.baseCurrencyCredit,
          description: schema.journalLines.description,
        })
        .from(schema.journalLines)
        .where(inArray(schema.journalLines.journalEntryId, chunk))),
    );
  }
  const linesByEntry = new Map<string, typeof lineRows>();
  for (const line of lineRows) {
    const list = linesByEntry.get(line.journalEntryId) ?? [];
    list.push(line);
    linesByEntry.set(line.journalEntryId, list);
  }
  for (const e of entryRows) {
    entries.push({
      id: e.number ?? e.id,
      date: e.date.toISOString().slice(0, 10),
      description: e.description,
      lines: (linesByEntry.get(e.id) ?? []).map((l) => ({
        accountCode: codeById.get(l.accountId) ?? '',
        debit: l.baseDebit !== null ? money(l.baseDebit) : money(l.debit),
        credit: l.baseCredit !== null ? money(l.baseCredit) : money(l.credit),
        description: l.description,
      })),
    });
  }

  return buildEcd({
    periodStart: start,
    periodEnd: end,
    company: {
      name: entity.legalName ?? entity.name,
      cnpj,
      uf: settings.uf,
      ie: entity.taxIdentifiers?.registrationNumber && entity.taxIdentifiers.registrationNumber !== 'ISENTO' ? entity.taxIdentifiers.registrationNumber : null,
      municipalityCode: settings.municipalityCode ?? null,
      municipalityName: settings.municipalityName ?? null,
      im: settings.inscricaoMunicipal ?? null,
    },
    accounts: accountRows.map((a) => ({ code: a.code, name: a.name, type: a.type as 'asset' | 'liability' | 'equity' | 'revenue' | 'expense' })),
    openingBalances,
    entries,
    retainedEarningsCode: retained.code,
    signatories,
  });
}
