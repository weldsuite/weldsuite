---
title: Set up a US company
nextjs:
  metadata:
    title: Set up a US company
    description: Create a US entity in WeldBooks with its legal form, tax classification, EIN, accounting method, fiscal year and a chart of accounts mapped to the federal return.
screenshots_todo:
  - file: weldbooks-us-new-entity.png
    shows: Entities → New Entity with United States chosen, showing the Legal form and tax return, Tax identifiers and Accounting cards
  - file: weldbooks-us-tax-line-mapping.png
    shows: Chart of Accounts → Tax line mapping for a Schedule C entity, with a few lines expanded
  - file: weldbooks-us-remap-tax-lines.png
    shows: The Remap tax lines? dialog after changing an LLC's tax classification to S corporation
---

A US entity tells WeldBooks how your business is organized and which federal return it files. WeldBooks uses that to build your chart of accounts, map each account to a line of the return and set the defaults of every report. {% .lead %}

---

## Create the entity

1. Open **WeldBooks** and go to **Entities** (under Settings in the module sidebar).
2. Click **New Entity**.
3. Under **Jurisdiction**, choose **United States**. The page switches to the **New US entity** form.
4. Fill in the cards described below, then click **Create entity**.

If WeldBooks has no entity yet, it opens a short **Create entity** dialog instead. You can choose the United States there, then open the entity from **Entities** afterwards to fill in its legal form, tax IDs and accounting settings. An entity created this way starts with the equity accounts of a sole proprietor; for a partnership or corporation, check the equity section of your chart once the legal form is set and add the accounts you need.

### Business

- **Display name**: the name you see in WeldBooks.
- **Legal name**: printed on invoices.
- **Base currency**: US entities keep their books in US dollars.

### Legal form and tax return

Choose the **Entity type**, then the **Tax classification**. The classification is how the IRS taxes the business, and it decides which return the entity files. Under the field, WeldBooks shows the return that goes with your choice.

| Entity type | Tax classification | Federal return |
| --- | --- | --- |
| Sole proprietorship | Sole proprietor | Schedule C (Form 1040) |
| LLC with one member | Disregarded entity (the default), S corporation or C corporation | Schedule C, Form 1120-S or Form 1120 |
| LLC with two or more members | Partnership (the default), S corporation or C corporation | Form 1065, Form 1120-S or Form 1120 |
| Partnership | Partnership | Form 1065 |
| S corporation | S corporation | Form 1120-S |
| C corporation | C corporation | Form 1120 |
| Nonprofit organization | Tax-exempt organization | Form 990 |

WeldBooks only records the classification. An LLC that wants to be taxed as a corporation makes that election with the IRS itself (Form 2553 for an S corporation, Form 8832 for a C corporation). Ask your accountant which classification applies to you.

**Doing business as (DBA)** is optional. It is printed under the legal name on invoices and reports.

### Tax identifiers

- **EIN**: your Employer Identification Number, entered as XX-XXXXXXX. It is printed on invoices and on the 1099s you send. WeldBooks checks the format and the first two digits.
- **State tax ID**: your sales tax or state withholding registration number, if you have one.
- **Social Security number**: only for a sole proprietor without an EIN. It is stored encrypted and never shown in full. People with the **Tax IDs: reveal** permission can click **Reveal** to see it for a few seconds, and every reveal is logged.

### Accounting

- **Accounting method**: **Accrual** or **Cash**. This is the default basis of every report. You can still switch any report to the other basis.
- **Time zone**: decides which day it is for dates, due dates and the fiscal year. By default WeldBooks picks the time zone of your state.
- **Fiscal year**: either **Starts on the 1st of a month** (choose the month), or **52–53 weeks**. For a 52–53-week year, choose the month it ends in, the weekday it ends on, and whether it is the last such weekday of the month or the one nearest to the end of the month.

WeldBooks shows the dates of your current fiscal year under the fields, so you can check them before you save.

### Address and options

Enter the business address with its state. Under **Options**:

- **Make this the workspace default entity** selects it when you open WeldBooks.
- **Seed standard chart of accounts + tax rates for this jurisdiction** creates the US chart described below. Leave it on unless you plan to import your own chart.

---

## What WeldBooks sets up for you

The seeded chart uses US numbering: 1000 assets, 2000 liabilities, 3000 equity, 4000 income, 5000 cost of goods sold, 6000–7000 expenses and 8000–9000 other income and expenses. The equity section follows your tax classification:

- **Sole proprietor or disregarded LLC**: owner's capital, owner's investment and owner's draws.
- **Partnership**: partners' capital.
- **S corporation**: common stock, additional paid-in capital, retained earnings, the accumulated adjustments account and shareholder distributions.
- **C corporation**: common stock, additional paid-in capital, treasury stock, retained earnings and dividends declared.
- **Nonprofit**: net assets with and without donor restrictions.

Every income and expense account points at a line of your return (a **tax line**). Expense accounts that usually hold payments to contractors also carry a **1099 box**: for example **Contract labor** and **Legal fees** report in box 1 of the 1099-NEC, and **Rent, buildings** in box 1 of the 1099-MISC. See [1099s](/weldbooks/us/1099).

---

## Change the entity later

Open **Entities** and click the entity to edit it. Besides the fields above you can maintain its address, contact details, bank details (with the routing number) and lock dates.

### When the tax classification changes

If you change the classification, for example because your LLC elected S corporation status, the entity files a different return. WeldBooks then asks **Remap tax lines?**:

1. Click **Remap tax lines** to point every account at its default line of the new return.
2. Tick **Also replace lines I set by hand on the new return** only if you want to drop your own choices too.
3. The result lists what changed and any income or expense accounts that have no default on the new return. Click **Open tax line mapping** to map those by hand.

You can also click **Not now** and remap later from the tax line mapping.

---

## Map accounts to tax lines

1. Go to **Chart of Accounts** and click **Tax line mapping**.
2. Each line of your return lists the accounts that report on it. **Accounts without a tax line** are listed at the top.
3. Click **Change tax line** on an account to move it, or **Apply default mapping** to reset the defaults.

On a single account, the **Tax reporting** card shows its **Tax line** and its **1099 box**. Set the 1099 box to **Omit (never reported on a 1099)** for accounts that should never count toward a 1099.

---

## Fiscal periods for a 52–53-week year

With a 52–53-week fiscal year, the periods follow weeks rather than calendar months: twelve periods of 4, 4 and 5 weeks per quarter. In a 53-week year the extra week falls in period 12.

Open **Fiscal periods** and choose the fiscal year. The screen lists each period with its dates and weeks, and whether it exists yet. Click **Create missing periods** (the button shows how many) to add the ones that don't. Tick **Also create quarters** and **Also create the whole year** if you close and lock by quarter or year.

---

## Classes and locations

Classes and locations let you report profit by department, product line, site or region.

1. Go to **Settings** in the WeldBooks sidebar and click **Manage** on the **Classes and locations** card.
2. Add classes and locations. A value can have a parent, and an inactive value stays on past bookings but can't be used for new ones.
3. Tag invoice, bill and journal lines with a class or location, then filter reports by them. See [Reports and tax calendar](/weldbooks/us/reports).

---

## Next steps

- [Set up sales tax](/weldbooks/us/sales-tax)
- [Connect your bank](/weldbooks/us/bank-feeds)
- [WeldBooks for US businesses](/weldbooks/us)
