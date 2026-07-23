# Bank Statement Samples

Test fixtures for the WeldBooks bank-statement importer (`apps/api-worker/src/services/bank-parsers/`). Upload any of these at `/weldbooks/banking/import` to exercise the full import + auto-reconcile flow.

All samples cover the same 7-transaction week of April 2026 against account `NL91ABNA0417164300` (EUR). If your entity has invoices numbered `INV-0001` / `INV-0002`, auto-reconcile will match them against the two incoming payments automatically.

| File | Format | Parser path |
|------|--------|-------------|
| `generic-statement.csv` | Generic headered CSV | `bank-parsers/csv.ts` → `parseGenericCSV()` |
| `ing-statement.csv` | Dutch ING CSV (native format detection) | `bank-parsers/csv.ts` → `parseINGCSV()` |
| `statement.sta` | SWIFT MT940 | `bank-parsers/mt940.ts` |

## Transaction breakdown

| Date | Description | Amount | Type |
|------|-------------|-------:|------|
| 2026-04-03 | Invoice payment received (Acme Widgets BV, `INV-0001`) | +€1,815.00 | Incoming, matches invoice |
| 2026-04-05 | Office rent April (Rent NL BV) | −€1,500.00 | Outgoing, good reconciliation-rule test |
| 2026-04-08 | SaaS subscription (Figma Inc) | −€49.00 | Outgoing |
| 2026-04-12 | Invoice payment received (Jane Doe Freelance, `INV-0002`) | +€605.00 | Incoming, matches invoice |
| 2026-04-15 | Bank fees | −€12.50 | Outgoing |
| 2026-04-18 | Coffee supplies (Nespresso) | −€78.40 | Outgoing |

The `generic-statement.csv` adds a zero-amount "opening balance adjustment" row for a running-balance sanity check.

## Suggested reconciliation rule to test with

- **Name:** Office rent
- **Conditions:** `description contains "rent"` (or `counterpartyName contains "Rent NL"`)
- **Actions:** Category → `4210 Huur`, Contact → Rent NL BV
- **Priority:** 10

Re-import the statement and the rent line should auto-categorize.
