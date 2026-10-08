---
title: WeldBooks for US businesses
nextjs:
  metadata:
    title: WeldBooks for US businesses
    description: Keep the books of a US company in WeldBooks, with sales tax, exemption certificates, 1099s, bank feeds, check and ACH payments, fixed assets and payroll imports.
---

WeldBooks keeps the full books of a US business: invoices and bills, bank feeds, sales tax, 1099s and the reports your accountant needs for your income tax return. {% .lead %}

{% quick-links %}

{% quick-link title="Set up a US company" icon="installation" href="/weldbooks/us/setup" description="Legal form, tax classification, EIN, accounting method and fiscal year." /%}

{% quick-link title="Sales tax" icon="presets" href="/weldbooks/us/sales-tax" description="Register in a state, pick a tax engine and charge the right tax." /%}

{% quick-link title="1099s" icon="plugins" href="/weldbooks/us/1099" description="Collect W-9s, review who gets a form and prepare the IRIS files." /%}

{% quick-link title="Bank feeds" icon="theming" href="/weldbooks/us/bank-feeds" description="Connect your bank, import statements and reconcile." /%}

{% /quick-links %}

---

## What changes for a US entity

Everything in WeldBooks belongs to an **entity**: the legal business whose books you keep. When an entity's jurisdiction is **United States**, WeldBooks works the American way:

- **Sales tax instead of VAT.** You charge sales tax only in the states where you are registered to collect it. Buyers never reclaim sales tax, so the sales tax a vendor charges you is part of what you paid for the item.
- **US terms.** Suppliers are called **Vendors**, credit notes are **Credit Memos**, and the tax ID is your **EIN**.
- **A chart of accounts for your legal form.** Every income and expense account points at a line of the federal return your business files, so your accountant gets a [tax return worksheet](/weldbooks/us/reports#tax-return-worksheet).
- **Cash or accrual.** Every financial report can switch between the two.
- **1099 reporting.** Vendor tax IDs, W-9s, the year-end review and the files for the IRS.
- **US banking.** Routing numbers, checks, ACH files, Positive Pay and statement files in OFX, QFX, QBO and BAI2.
- **US formats.** Dates as MM/DD/YYYY, amounts in US dollars and invoices on Letter paper.

---

## The guides

| Guide | What it covers |
| --- | --- |
| [Set up a US company](/weldbooks/us/setup) | Entity type, tax classification, EIN, accounting method, fiscal year, tax lines, classes and locations |
| [Sales tax](/weldbooks/us/sales-tax) | Agencies, the tax engine, rates and zones, product tax codes, tax on invoices and bills, use tax, the nexus monitor |
| [Exemption certificates](/weldbooks/us/exemption-certificates) | Tax-exempt customers, expiry per state, the 90-day window for missing certificates |
| [Sales tax returns](/weldbooks/us/sales-tax-returns) | The Sales Tax Center: periods, worksheet, checks, filing and payment |
| [1099s](/weldbooks/us/1099) | Vendor tax info, W-9 requests, the 1099 Center, IRIS files, corrections, backup withholding |
| [Bank feeds and reconciliation](/weldbooks/us/bank-feeds) | Bank connections, statement import, Undeposited Funds and deposits, statement reconciliation |
| [Checks and ACH payments](/weldbooks/us/checks-and-ach) | Payment runs, check printing, NACHA files, approvals, holds, Positive Pay |
| [Fixed assets](/weldbooks/us/fixed-assets) | Assets, book and tax depreciation, MACRS, section 179, bonus, disposals |
| [Payroll import](/weldbooks/us/payroll-import) | Bring payroll from Gusto, ADP and others into the ledger |
| [Reports and tax calendar](/weldbooks/us/reports) | Cash or accrual, comparisons, exports, the tax return worksheet and due dates |

---

## WeldBooks prepares, you file

WeldBooks prepares your sales tax returns, your 1099 files and the worksheet for your income tax return. It does not file anything with a state or the IRS for you: you submit returns on the state's portal and upload 1099 files in the IRS's IRIS portal, then record that in WeldBooks.

{% callout type="warning" title="Not tax advice" %}
WeldBooks applies the rules you set up and the rules it ships with, but it does not tell you what you owe or where you have to register. Tax rules differ per state and change over time. Amounts and dates in these guides are as of October 2026. Check anything you are unsure about with your accountant or the state's revenue department.
{% /callout %}

---

## Who can do what

Workspace owners and admins can use all of the US features. Other members need these permissions, which an admin grants under [Team and permissions](/settings/team-and-permissions):

| Permission | What it allows |
| --- | --- |
| **Taxes: view** | See sales tax, tax returns and 1099s |
| **Taxes: create, edit, delete** | Manage agencies, rates, certificates, returns and 1099 filings |
| **Taxes: file** | Mark tax returns and 1099s as filed and record their payment |
| **Tax IDs: reveal** | Show a full TIN, SSN or bank account number. Every reveal is logged. |
| **Banking: manage** | Approve payment runs, print checks, make ACH files, verify vendor bank details, undo a reconciliation |

---

## Reminders

Once a day WeldBooks checks each US entity and sends an in-app notification to the workspace owners and admins when:

- a sales tax return is due within 7 days, due tomorrow or today, or overdue;
- a deadline on the [tax calendar](/weldbooks/us/reports#tax-calendar) is 14 days or 3 days away;
- a customer's exemption certificate expires within 30 days;
- your sales into a state have crossed its nexus threshold.

Each reminder is sent once.

---

## Next steps

- [Set up a US company](/weldbooks/us/setup)
- [WeldBooks overview](/weldbooks)
