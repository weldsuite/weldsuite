/**
 * POST /:id/process matches the supplier by the VAT number the model reads:
 * a party has no tax number of its own, it is its company's `vat_number`.
 * The vendor's name is matched against the party's display name. Before
 * this, a result with a VAT number or a vendor name made the route answer
 * 500 (it asked for `parties.taxNumber` and `parties.name`, which don't
 * exist).
 *
 * Its own file because the shared mock model answers one set of fields per
 * file; conformance runs it on both backends like ocr-process.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createMockModel } from "@weldsuite/ai/testing";
import { createTestApp, permissions } from "@weldsuite/worker-kit/testing";
import { createPgliteDb } from "@weldsuite/worker-kit/testing/pglite";
import { createMemoryR2 } from "@weldsuite/worker-kit/testing/r2";
import { schema, type Database } from "@weldsuite/worker-kit/db";
import { accountingDocumentsRoutes } from "./index";
import { matchVendorToContact, normalizeOcrResult } from "../../services/accounting-ocr";

const ORG = "org_test_default"; // the harness's clerkOrgId
const PDF_KEY = `workspaces/${ORG}/accounting/1_ocr/vat-invoice.pdf`;
const VAT = "NL123456789B01";

/** A vendor with a name and a VAT number, and no IBAN. */
const FIELDS = {
  vendor: {
    name: "Office 100% Supplies",
    address: null,
    taxNumber: VAT,
    kvkNumber: null,
    iban: null,
    bic: null,
  },
  invoiceNumber: "OS-77",
  invoiceDate: "2026-10-01",
  dueDate: null,
  currency: "EUR",
  lineItems: [{ description: "Toner", quantity: 1, unitPrice: 40, taxRate: 21, total: 40 }],
  subtotal: 40,
  taxBreakdown: [{ rate: 21, taxableAmount: 40, taxAmount: 8.4 }],
  totalTax: 8.4,
  total: 48.4,
  paymentReference: null,
  iban: null,
  confidence: { overall: 0.9 },
};

const mock = createMockModel({
  chat: { json: FIELDS },
  ocr: { pages: ["# Invoice OS-77\n\nToner 1 x 40.00"], annotation: FIELDS },
});

const bucket = createMemoryR2();
let db: Database;

beforeAll(async () => {
  vi.stubGlobal("fetch", mock.fetch);
  db = (await createPgliteDb()).db;
  await db.insert(schema.companies).values({
    id: "cmp_vat",
    name: "Office Supplies Holding",
    displayName: "Office Supplies Holding",
    vatNumber: VAT,
  } as typeof schema.companies.$inferInsert);
  await db.insert(schema.parties).values([
    // Matched by its company's VAT number; its own name differs.
    { id: "acn_vat", displayName: "OSH Purchasing", role: "supplier", kind: "company", companyId: "cmp_vat" },
    // Its name contains the vendor's only if `%` were a wildcard.
    { id: "acn_wild", displayName: "Office 1000 Supplies", role: "supplier" },
  ] as Array<typeof schema.parties.$inferInsert>);
  await bucket.put(
    PDF_KEY,
    new TextEncoder().encode("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer\n%%EOF\n"),
  );
  await db.insert(schema.documents).values({
    id: "doc_vat",
    fileKey: PDF_KEY,
    fileName: "vat-invoice.pdf",
    mimeType: "application/pdf",
    status: "pending",
  } as typeof schema.documents.$inferInsert);
}, 60_000);

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/accounting-documents/:id/process — vendor match", () => {
  it("matches the supplier by its company's VAT number", async () => {
    const res = await createTestApp("/api/accounting-documents", accountingDocumentsRoutes, {
      env: { ...mock.env, PRIVATE_STORAGE: bucket } as never,
      context: { permissions: permissions("invoices:update"), tenantDb: db },
    }).request("/api/accounting-documents/doc_vat/process", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data).toEqual({
      id: "doc_vat",
      status: "processed",
      ocrResult: normalizeOcrResult(FIELDS),
      matchedContactId: "acn_vat",
    });
  });

  it("matches a vendor name against display names, wildcards taken literally", async () => {
    const result = normalizeOcrResult({ ...FIELDS, vendor: { ...FIELDS.vendor, taxNumber: null } });
    expect(await matchVendorToContact(db, schema, result)).toBeNull();

    const exact = normalizeOcrResult({ ...FIELDS, vendor: { ...FIELDS.vendor, name: "PURCHASING", taxNumber: null } });
    expect(await matchVendorToContact(db, schema, exact)).toBe("acn_vat");
  });
});
