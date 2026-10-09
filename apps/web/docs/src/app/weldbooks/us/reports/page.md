---
title: Reports and tax calendar
nextjs:
  metadata:
    title: Reports and tax calendar
    description: Run WeldBooks reports on a cash or accrual basis with comparisons and CSV or PDF export, prepare the tax return worksheet for your accountant, and follow every tax due date on the tax calendar.
screenshots_todo:
  - file: weldbooks-us-profit-loss-cash.png
    shows: Profit and loss on a cash basis compared with the previous year, with the report toolbar visible
  - file: weldbooks-us-tax-worksheet.png
    shows: Tax return worksheet for a Schedule C entity, with lines expanded and the Reconciliation with the books card
  - file: weldbooks-us-tax-calendar.png
    shows: Tax calendar for the year with overdue, due soon and done deadlines
---

Every WeldBooks report can run on a cash or an accrual basis. For a US entity WeldBooks also prepares a worksheet that lines up your books with your income tax return, and a calendar of every tax due date. {% .lead %}

---

## Cash or accrual

The journal is always kept on the accrual basis. Reports can show either basis:

- **Accrual basis** counts income when you invoice and expenses when a bill is approved.
- **Cash basis** counts them when they are paid. Unpaid invoices and bills don't show, and receivables and payables carry no balance. A partial payment is spread over the lines of the invoice or bill in proportion to their amounts, so its share of sales tax goes to sales tax. Money received or paid that isn't applied to a document shows as unapplied cash.

The entity's **Accounting method** sets the default (see [Set up a US company](/weldbooks/us/setup)). Change it per report with **Basis** in the report toolbar. The basis is printed on exported reports.

---

## The report toolbar

All WeldBooks reports share one toolbar, above the report. Which options it shows depends on the report:

| Option | What it does | Reports |
| --- | --- | --- |
| **Basis** | Accrual or cash | P&L, balance sheet, trial balance, general ledger |
| **Compare** | Adds the **Previous period** or **Previous year** with the change in amount and percent | P&L, balance sheet, trial balance, cash flow |
| **Columns** | **By month** or **By quarter** instead of one total | P&L |
| **Class** and **Location** | Filter by the [classes and locations](/weldbooks/us/setup#classes-and-locations) on your lines | P&L, balance sheet, trial balance, general ledger |
| **Export** | **Download CSV** or **Download PDF** | Every report |

Date ranges default to your fiscal year, so a business whose year starts in July sees July to June. Comparison and month or quarter columns can't be combined.

---

## Tax return worksheet

The tax return worksheet is the trial balance of a fiscal year, grouped by the lines of the federal return your entity files: Schedule C, Form 1065, Form 1120-S, Form 1120 or Form 990. It is meant for the accountant who prepares your return.

1. Open a report, then click **Reports** in the page header to see all reports, and choose **Tax return worksheet**.
2. Choose the **Fiscal year**. Tick **Include accounts with no activity** to see every account.
3. Each line of the return shows its total and, expanded, the accounts behind it. Where only part of an expense is deductible (meals, for example), the worksheet shows the deductible share and where the rest goes.
4. **Accounts without a line on this return** lists accounts with activity that aren't on any line. Click **Map accounts** to give them one.
5. **Reconciliation with the books** checks that net income per books equals the lines' net income, less what isn't deductible, plus the unmapped accounts. It shows **Reconciles** when everything adds up.

Export it as CSV or PDF for your accountant. The worksheet follows your [tax line mapping](/weldbooks/us/setup#map-accounts-to-tax-lines); it doesn't fill in or file the return.

---

## Tax calendar

The **Tax calendar** lists every tax due date of the year for the entity, with what is done and what is late:

- the income tax return for your entity type, and the extended due date if you extend;
- estimated tax: Form 1040-ES for the owners of a sole proprietorship or pass-through entity, the four corporate installments for a C corporation;
- information returns: the 1099s and W-2s;
- payroll: Forms 941, 940 and 945;
- each sales tax return of each agency.

Due dates follow the federal rules and move to the next business day when they fall on a weekend or a legal holiday. Use **Previous year** and **Next year** to move between years.

Click **Mark done** on a deadline when you have met it, optionally with a note such as a confirmation number. Sales tax returns you mark filed in the [Sales Tax Center](/weldbooks/us/sales-tax-returns) are marked done automatically. A deadline links to the screen where you handle it, such as the sales tax returns or the 1099 forms.

Owners and admins get a reminder 14 days and 3 days before each deadline. State deadlines can differ from the federal ones, and extensions change the dates: check them with your tax preparer.

---

## Next steps

- [Set up a US company](/weldbooks/us/setup)
- [Sales tax returns](/weldbooks/us/sales-tax-returns)
- [WeldBooks for US businesses](/weldbooks/us)
