---
title: Payroll import
nextjs:
  metadata:
    title: Payroll import
    description: Bring each payroll from Gusto, ADP, QuickBooks Payroll or another provider into the WeldBooks ledger, from a CSV export or a Gusto connection.
screenshots_todo:
  - file: weldbooks-us-payroll-csv-columns.png
    shows: Import payroll from a CSV file, Columns step, with a payroll register's columns matched
  - file: weldbooks-us-payroll-review.png
    shows: The Review step with two balanced payrolls and their journal lines
---

WeldBooks doesn't run payroll. Your payroll provider pays your people and files the payroll taxes; WeldBooks imports each payroll's journal so your ledger and reports include it. {% .lead %}

---

## Import a CSV file

1. Export the payroll from your provider as a CSV file: a payroll register (one row per payroll) or a general ledger export (journal lines). Gusto, ADP, QuickBooks Payroll and most others offer one.
2. In WeldBooks, open **Payroll imports** and click **Import CSV**.
3. **File**: choose the file (comma, semicolon or tab separated, up to 5 MB). WeldBooks shows the first rows. If a mapping you saved before fits the file, it is applied.
4. **Format**: choose what the file contains:
   - **One row per payroll**: the totals of each payroll. WeldBooks builds the journal entry.
   - **A general ledger export**: journal lines with a date, an account, a debit and a credit. Rows with the same date become one payroll.
5. **Columns**: match your file's columns, and the **Date format** if the dates could be read two ways. For a payroll register: the **Pay date**, **Gross wages** and **Net pay**, and where the file has them employer and employee taxes, employee deductions, employer benefits, reimbursements and owner's draw. Gross wages must equal net pay plus employee taxes and deductions.
6. **Accounts**: choose where each part posts. Leave an account on **Default from the chart** to use your chart's payroll accounts. The account the net pay was paid from (your bank or a payroll clearing account) is required. For a general ledger export, each account in the file is matched to your chart by code or name; choose an account for any that don't match.
7. **Review**: every payroll must balance before you can import. Optionally add the pay period, and tick **Remember this mapping for the next file**.
8. Click **Import payrolls**.

Each payroll becomes a journal entry. A payroll that was already imported is skipped, so importing the same file twice doesn't double your wages.

---

## Connect Gusto

The Gusto connection is in beta: it has been tested against recorded Gusto data only, so check the first imports against Gusto before you rely on it.

1. On **Payroll imports**, click **Gusto**, then connect a company.
2. Enter an **Access token** you create in Gusto for your company, the **Company ID** (the company's UUID in Gusto) and the **Environment**. The token is checked with Gusto, stored encrypted and never shown again.
3. Open **Account mapping** and choose the account for each part of a payroll. The net pay account is required.
4. Click **Import payrolls**. Without dates, the import covers the period since the last sync, and the first time from the start of the year. Each processed payroll is imported only once.

**Disconnect** deletes the access token. Payrolls already imported stay in the ledger.

---

## Reverse a payroll

If a payroll was imported wrongly, open it and click **Reverse payroll**. WeldBooks posts a reversing entry, dated the pay date by default so it nets out in the same period. The import stays on the list as reversed. To import the same payroll again, give it a different **Batch label** on the review step.

---

## Payroll and the rest of WeldBooks

- A payroll import is a journal entry, not a payment to a vendor, so contractor pay that comes in through it doesn't count in WeldBooks' [1099 review](/weldbooks/us/1099). A payroll provider that pays your contractors usually files their 1099s too; check with your provider.
- The [tax calendar](/weldbooks/us/reports#tax-calendar) shows the federal payroll due dates (Forms 941, 940 and W-2) next to your other deadlines, for information.

---

## Next steps

- [Reports and tax calendar](/weldbooks/us/reports)
- [WeldBooks for US businesses](/weldbooks/us)
