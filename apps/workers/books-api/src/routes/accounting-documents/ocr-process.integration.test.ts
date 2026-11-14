/**
 * POST /:id/process reads a stored purchase invoice into fields with the
 * model, matches the supplier, and stores the result; a file it cannot read
 * is refused and the document marked failed.
 *
 * The model is the shared mock (`@weldsuite/ai/testing`), so the conformance
 * run drives both backends: this worker sends the PDF to Claude through the
 * gateway (`/messages`), the Rust server to Mistral OCR with a document
 * annotation (`/ocr`). Both answer the same fields.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createMockModel } from "@weldsuite/ai/testing";
import { createTestApp, permissions } from "@weldsuite/worker-kit/testing";
import { createPgliteDb } from "@weldsuite/worker-kit/testing/pglite";
import { createMemoryR2 } from "@weldsuite/worker-kit/testing/r2";
import { schema, type Database } from "@weldsuite/worker-kit/db";
import { accountingDocumentsRoutes } from "./index";
import { normalizeOcrResult } from "../../services/accounting-ocr";

const ORG = "org_test_default"; // the harness's clerkOrgId
const PDF_KEY = `workspaces/${ORG}/accounting/1_ocr/invoice.pdf`;
const NOT_A_PDF_KEY = `workspaces/${ORG}/accounting/1_ocr/broken.pdf`;
const FOREIGN_KEY = "workspaces/org_other/accounting/1_ocr/invoice.pdf";
const IBAN = "NL91ABNA0417164300";

/** What the model reads off the invoice. No vendor name or VAT number: only the IBAN matches a contact. */
const FIELDS = {
  vendor: {
    name: null,
    address: null,
    taxNumber: null,
    kvkNumber: null,
    iban: IBAN,
    bic: null,
  },
  invoiceNumber: "F-2026-12",
  invoiceDate: "24-08-2026",
  dueDate: "2026-09-23",
  currency: "EUR",
  lineItems: [
    {
      description: "Printer paper",
      quantity: 2,
      unitPrice: 5,
      taxRate: 21,
      total: 10,
    },
  ],
  subtotal: 10,
  taxBreakdown: [{ rate: 21, taxableAmount: 10, taxAmount: 2.1 }],
  totalTax: 2.1,
  total: 12.1,
  paymentReference: "RF18 5390 0754 7034",
  iban: IBAN,
  confidence: { overall: 0.92 },
};

const mock = createMockModel({
  chat: { json: FIELDS },
  ocr: {
    pages: ["# Invoice F-2026-12\n\nPrinter paper 2 x 5.00"],
    annotation: FIELDS,
  },
});

const bucket = createMemoryR2();
let db: Database;

beforeAll(async () => {
  vi.stubGlobal("fetch", mock.fetch);
  db = (await createPgliteDb()).db;
  await db
    .insert(schema.parties)
    .values({
      id: "acn_ocr",
      displayName: "Paper Supplier",
      role: "supplier",
      iban: IBAN,
    });
  await bucket.put(
    PDF_KEY,
    new TextEncoder().encode(
      "%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer\n%%EOF\n",
    ),
  );
  await bucket.put(
    NOT_A_PDF_KEY,
    new TextEncoder().encode("this is not a pdf at all, just text"),
  );
  const base = {
    fileName: "invoice.pdf",
    mimeType: "application/pdf",
    status: "pending",
  };
  await db.insert(schema.documents).values([
    { id: "doc_ocr", fileKey: PDF_KEY, ...base },
    { id: "doc_ocr_foreign", fileKey: FOREIGN_KEY, ...base },
    { id: "doc_ocr_broken", fileKey: NOT_A_PDF_KEY, ...base },
    { id: "doc_ocr_csv", fileKey: PDF_KEY, ...base, mimeType: "text/csv" },
  ] as Array<typeof schema.documents.$inferInsert>);
}, 60_000);

afterAll(() => {
  vi.unstubAllGlobals();
});

const process = (id: string) =>
  createTestApp("/api/accounting-documents", accountingDocumentsRoutes, {
    env: { ...mock.env, PRIVATE_STORAGE: bucket } as never,
    context: { permissions: permissions("invoices:update"), tenantDb: db },
  }).request(`/api/accounting-documents/${id}/process`, { method: "POST" });

async function row(id: string) {
  const [doc] = await db
    .select()
    .from(schema.documents)
    .where(eq(schema.documents.id, id));
  return doc;
}

describe("POST /api/accounting-documents/:id/process", () => {
  it("reads the invoice, matches the supplier by IBAN and stores the result", async () => {
    const res = await process("doc_ocr");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    const expected = normalizeOcrResult(FIELDS);
    expect(body.data).toEqual({
      id: "doc_ocr",
      status: "processed",
      ocrResult: expected,
      matchedContactId: "acn_ocr",
    });
    expect(expected.invoiceDate).toBe("2026-08-24");

    const doc = await row("doc_ocr");
    expect(doc?.status).toBe("processed");
    expect(doc?.ocrResult).toEqual(expected);
    expect(doc?.matchedContactId).toBe("acn_ocr");
    expect(doc?.ocrModel).toBeTruthy();
    expect(doc?.ocrProcessedAt).toBeTruthy();
    expect(mock.calls.length).toBeGreaterThan(0);
  });

  it("never reads another workspace's file", async () => {
    const res = await process("doc_ocr_foreign");
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(`File not found: ${FOREIGN_KEY}`);
    expect((await row("doc_ocr_foreign"))?.status).toBe("failed");
  });

  it("refuses a file that is not a readable PDF", async () => {
    const res = await process("doc_ocr_broken");
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("That file is not a readable PDF.");
    expect((await row("doc_ocr_broken"))?.status).toBe("failed");
  });

  it("refuses a declared type OCR cannot read", async () => {
    const res = await process("doc_ocr_csv");
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(
      "OCR reads PDF files and JPEG, PNG and WebP images.",
    );
    expect((await row("doc_ocr_csv"))?.status).toBe("failed");
  });

  it("404s an unknown document", async () => {
    expect((await process("doc_ocr_nobody")).status).toBe(404);
  });
});
