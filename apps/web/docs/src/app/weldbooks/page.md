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
- **Moneybird** — optional sync of contacts, sales invoices, products, and purchase invoices. Changes in Moneybird arrive within seconds, and you can choose per object to also send what you create in WeldBooks to Moneybird (see [Connectors](/weldconnect)). Imported documents keep Moneybird’s numbers and do not create journal entries.
- **Stripe** — import paid Stripe invoices, payments, fees and payouts, and [send them on to Moneybird](/weldconnect/stripe-to-moneybird).

Navigation groups sales, purchases, banking, and reporting in the module sidebar.

---

## Typical flow

1. Set up **company details** and **tax rates** in settings.
2. Create **invoices** for your customers.
3. Record **bills** for expenses.
4. **Reconcile** bank feeds monthly.
5. Run **reports** for your accountant.

---

## Matching payments to invoices and bills

You can match a bank transaction from either side:

- **From the transaction**: open **Banking → Reconciliation** and select the transaction. Besides the suggestions, **Match to invoices** (money in) or **Match to bills or credit notes** (money out) lets you search every open document by number, contact or reference and tick one or more. One customer transfer can pay several invoices at once.
- **From the invoice or bill**: open its **Payments** tab and choose **Link bank transaction**. WeldBooks lists the unmatched transactions that fit best first.

When the amounts differ, you choose what happens to the difference:

- **The transaction is less** (the bank kept a fee, the customer took a discount): leave the rest open, or mark the documents paid and book the difference to an account such as **Bank costs**.
- **The transaction is more**: keep the rest as credit for the contact, or book it to an account.

To undo a match, open the payment's menu on the **Payments** tab and choose **Undo bank match**. The transaction goes back to unmatched and, if the match created the payment, every document it paid is open again.

Matching several documents, searching and booking the difference are available on the EU and self-hosted editions.

---

## Money that is not a customer payment

Do **not** create an invoice when the money did not come from a customer. A payment-processor settlement, fee refund, interest credit, or owner deposit is not sales.

Book it against a ledger account instead:

1. Link the bank (or PayPal) account to a GL account such as **Bank**.
2. If the line is already on the statement, open **Banking → Reconciliation**, select it, and **Categorize** it — for example **Other income** (a settlement) or **Bank fees** (a refund of processing fees, which reduces that expense).
3. If it is not on a statement yet, use **Add transaction**, choose **Money in**, and pick the same ledger account so WeldBooks posts it immediately.

You can also post a **journal entry** (debit bank, credit the income or expense account). Categorizing from banking does that for you.

---

## US businesses

For an entity in the United States, WeldBooks adds sales tax, exemption certificates, 1099s, bank feeds, check and ACH payment runs, fixed assets with tax depreciation, payroll imports and a tax return worksheet. Start with [WeldBooks for US businesses](/weldbooks/us).

---

## Next steps

- [WeldBooks for US businesses](/weldbooks/us)
- [Settings overview](/settings)
