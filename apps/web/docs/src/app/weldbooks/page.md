---
title: WeldBooks
nextjs:
  metadata:
    title: WeldBooks
    description: Invoicing, bills, bank reconciliation, and reports in WeldBooks.
---

WeldBooks is accounting for your workspace — sales documents, expenses, ledger, and tax reports. {% .lead %}

---

## What you can do

- **Invoices** and **credit notes** — send to customers, track paid status
- **Bills** and **purchase orders** — record supplier spend
- **Bank accounts** — import transactions and reconcile
- **Chart of accounts** and **journal entries** — double-entry bookkeeping
- **VAT returns** and **financial reports** — P&L, balance sheet, aged receivables
- **Moneybird** — optional inbound sync of contacts, sales invoices, products, and purchase invoices. Imported documents keep Moneybird’s numbers and do not create journal entries.

Navigation groups sales, purchases, banking, and reporting in the module sidebar.

---

## Typical flow

1. Set up **company details** and **tax rates** in settings.
2. Create **invoices** from [WeldCommerce](/weldcommerce) orders or manually.
3. Record **bills** for expenses.
4. **Reconcile** bank feeds monthly.
5. Run **reports** for your accountant.

---

## Money that is not a customer payment

Do **not** create an invoice when the money did not come from a customer. A payment-processor settlement, fee refund, interest credit, or owner deposit is not sales.

Book it against a ledger account instead:

1. Link the bank (or PayPal) account to a GL account such as **Bank**.
2. If the line is already on the statement, open **Banking → Reconciliation**, select it, and **Categorize** it — for example **Other income** (a settlement) or **Bank fees** (a refund of processing fees, which reduces that expense).
3. If it is not on a statement yet, use **Add transaction**, choose **Money in**, and pick the same ledger account so WeldBooks posts it immediately.

You can also post a **journal entry** (debit bank, credit the income or expense account). Categorizing from banking does that for you.

---

## Next steps

- [WeldCommerce overview](/weldcommerce)
- [Settings overview](/settings)
