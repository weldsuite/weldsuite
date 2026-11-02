/**
 * Seed for the fiscal document integration tests (pglite): a Brazilian entity
 * (Lucro Presumido, São Paulo) with its tax profiles, a customer company with
 * a CNPJ, and finalized invoices of goods and services.
 *
 * Not a test file: it has no `.test.ts` suffix.
 */

import { BR_TAX_PROFILES, brProfileOf } from '@weldsuite/books-domain/jurisdictions/br';
import { schema, type Database } from '@weldsuite/worker-kit/db';

export interface BrFixture {
  entityId: string;
  customerId: string;
  rates: Record<string, string>;
}

export const ENTITY_CNPJ = '12.345.678/0001-23';
export const CUSTOMER_CNPJ = '99.887.766/0001-55';

export async function seedBrEntity(db: Database, id = 'ent_br'): Promise<BrFixture> {
  await db.insert(schema.entities).values({
    id,
    name: 'Empresa Exemplo',
    legalName: 'Empresa Exemplo Ltda',
    jurisdictionCode: 'BR',
    baseCurrency: 'BRL',
    locale: 'pt-BR',
    taxClassification: 'lucro_presumido',
    taxIdentifiers: { vatNumber: ENTITY_CNPJ, registrationNumber: '123.456.789.110' },
    jurisdictionSettings: { uf: 'SP', municipalityCode: '3550308', inscricaoMunicipal: '12345', issRate: 5 },
  });

  const rates: Record<string, string> = {};
  for (const template of BR_TAX_PROFILES) {
    const profile = brProfileOf(template.jurisdictionMetadata)!;
    const rateId = `rate_${profile.profile}`;
    rates[profile.profile] = rateId;
    await db.insert(schema.taxRates).values({
      id: rateId,
      entityId: id,
      jurisdictionCode: 'BR',
      name: template.name,
      rate: '0',
      type: template.type,
      taxCategoryCode: template.taxCategoryCode,
      isActive: true,
      jurisdictionMetadata: template.jurisdictionMetadata,
    });
  }

  await db.insert(schema.companies).values({ id: 'cmp_customer', name: 'Cliente Comercial Ltda', displayName: 'Cliente Comercial Ltda', vatNumber: CUSTOMER_CNPJ, email: 'compras@cliente.com.br' });
  await db.insert(schema.parties).values({
    id: 'pty_customer',
    kind: 'company',
    companyId: 'cmp_customer',
    displayName: 'Cliente Comercial Ltda',
    role: 'customer',
    billingAddress: { line1: 'Rua das Flores, 123', city: 'Sao Paulo', state: 'SP', postalCode: '01311-000', country: 'BR' },
    brFiscal: { inscricaoEstadual: '140.212.370', icmsContributor: true, municipalityCode: '3550308' },
  });
  return { entityId: id, customerId: 'pty_customer', rates };
}

export interface SeedLine {
  description: string;
  quantity: string;
  unitPrice: string;
  profile: string;
  ncm?: string;
  cfop?: string;
  fiscalData?: Record<string, unknown>;
}

/** A finalized invoice with its lines (the amounts are what the lines say; taxes are recomputed by the issuing code). */
export async function seedInvoice(
  db: Database,
  fx: BrFixture,
  id: string,
  lines: SeedLine[],
  options: { status?: string; type?: string; creditNoteForInvoiceId?: string } = {},
): Promise<void> {
  const total = lines.reduce((sum, l) => sum + Number.parseFloat(l.quantity) * Number.parseFloat(l.unitPrice), 0);
  await db.insert(schema.invoices).values({
    id,
    entityId: fx.entityId,
    invoiceNumber: `INV-${id}`,
    type: options.type ?? 'standard',
    status: options.status ?? 'finalized',
    contactId: fx.customerId,
    contactName: 'Cliente Comercial Ltda',
    contactEmail: 'compras@cliente.com.br',
    issueDate: new Date('2026-10-14T12:00:00Z'),
    dueDate: new Date('2026-11-14T12:00:00Z'),
    currency: 'BRL',
    subtotal: total.toFixed(2),
    total: total.toFixed(2),
    balanceDue: total.toFixed(2),
    creditNoteForInvoiceId: options.creditNoteForInvoiceId,
    // The neighbourhood (bairro) travels in the address's county field.
    billingAddress: { line1: 'Rua das Flores, 123', city: 'Sao Paulo', state: 'SP', postalCode: '01311-000', country: 'BR', county: 'Centro' },
    taxBreakdown: [],
  });
  await db.insert(schema.invoiceItems).values(
    lines.map((line, i) => ({
      id: `${id}_l${i}`,
      entityId: fx.entityId,
      invoiceId: id,
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      taxRateId: fx.rates[line.profile],
      lineTotal: (Number.parseFloat(line.quantity) * Number.parseFloat(line.unitPrice)).toFixed(2),
      sortOrder: i,
      ncm: line.ncm ?? null,
      cfop: line.cfop ?? null,
      fiscalData: line.fiscalData ?? null,
    })),
  );
}

// --- A stand-in for Focus NFe --------------------------------------------------------------

export interface StubCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

type StubHandler = (call: StubCall) => Response | Promise<Response>;

export const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

/**
 * A fetch that answers like Focus NFe: handlers match on method and URL, the
 * newest first, and every call is recorded. A call nothing matches is a 404.
 */
export function createFocusStub() {
  const calls: StubCall[] = [];
  const handlers: Array<{ method: string; pattern: RegExp; handler: StubHandler }> = [];
  // Anything that is not Focus (the conformance harness's own loopback calls) goes out as before.
  const realFetch = globalThis.fetch;
  const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).includes('focusnfe.com.br/')) return realFetch(input, init);
    const call: StubCall = {
      method: init?.method ?? 'GET',
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
    };
    calls.push(call);
    const match = handlers.find((h) => h.method === call.method && h.pattern.test(call.url));
    return match ? match.handler(call) : jsonResponse({ codigo: 'nao_encontrado', mensagem: 'Nao encontrado' }, 404);
  }) as typeof fetch;
  return {
    calls,
    fetch: fetchStub,
    on(method: string, pattern: RegExp, handler: StubHandler) {
      handlers.unshift({ method, pattern, handler });
    },
    callsTo(method: string, pattern: RegExp) {
      return calls.filter((c) => c.method === method && pattern.test(c.url));
    },
  };
}
