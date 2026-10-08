---
title: 1099s
nextjs:
  metadata:
    title: 1099s
    description: Collect vendor TINs and W-9s, review who gets a 1099-NEC or 1099-MISC, create the IRIS upload files, send recipient copies, file corrections and handle backup withholding in WeldBooks.
screenshots_todo:
  - file: weldbooks-us-vendor-tax-reporting.png
    shows: A vendor's Tax reporting section with Report this vendor on Form 1099, a stored TIN (last four), the W-9 fields and Request W-9 online
  - file: weldbooks-us-1099-review.png
    shows: 1099 Center → Review for a tax year, with the summary cards, the deadline headline and a list of vendors with statuses
  - file: weldbooks-us-1099-filing.png
    shows: A generated 1099-NEC filing with its steps, recipients, IRIS upload file and Download copies
---

At the end of the year you report what you paid contractors and other vendors on Form 1099-NEC or 1099-MISC. WeldBooks adds up the payments, shows who needs a form and what is missing, and prepares the files you upload to the IRS and the copies you send your vendors. {% .lead %}

---

## Who goes on a 1099

WeldBooks counts the payments you made in the calendar year to vendors marked as 1099 vendors, and compares each box with the IRS reporting threshold for that year:

| Payments made in | Most boxes (nonemployee compensation, rents, other income) | Royalties | Attorney gross proceeds, fish purchases |
| --- | --- | --- | --- |
| 2025 | $600 or more | $10 or more | $600 or more |
| 2026 | $2,000 or more | $10 or more | $600 or more |

The 2026 change comes from the One Big Beautiful Bill Act; from 2027 the $2,000 amount is indexed for inflation. The 1099 Center always shows the amounts it uses for the year you are looking at.

WeldBooks leaves out:

- **Payments by credit card, debit card or a payment network** such as PayPal, and payments from a credit card account. The processor reports those on a 1099-K.
- **Payments made through payroll**: your payroll provider files those forms.
- **Corporations**, except payments for legal services (attorneys stay reportable) and medical and health care payments.
- Accounts and bill lines set to **Omit** from 1099 reporting.

The 1099 Center also tells you when the number of information returns you file means you must file them electronically. This is how WeldBooks applies the rules; your accountant can confirm what applies to your payments.

---

## Set up your vendors

Open the vendor (under **Vendors**) and edit it. The **Tax reporting** section holds what WeldBooks needs:

1. Tick **Report this vendor on Form 1099**.
2. Choose the **Default form** (1099-NEC or 1099-MISC) and the **Default box**.
3. Under **Taxpayer identification number (TIN)**, choose the type (**EIN**, **SSN** or **ITIN**) and enter the number.
4. Fill in the **Form W-9** fields: the name on line 1, the business name on line 2, the **Federal tax classification** (and for an LLC, how it is taxed), any exempt payee or FATCA code, and the date you received the W-9.
5. Tick **Law firm or attorney** for legal fees, which stay reportable even when the firm is a corporation.
6. Upload the **Scan of the signed W-9** (PDF or image, up to 10 MB). A W-9 carries a TIN, so it is never sent to document recognition or AI.
7. Tick **Agreed to receive 1099s electronically** only after the vendor agreed to electronic delivery and received the required disclosures. Otherwise you print and mail their copy.

The **Vendors** list has a **1099** filter for **1099 vendors** and **1099 vendors without a TIN**.

### TINs are protected

A TIN is stored encrypted. After you save, only the last four digits are shown. People with the **Tax IDs: reveal** permission can click **Reveal** to see it for a few seconds, and **Reveal history** shows everyone who did, with the files that included it.

### Request a W-9 online

Instead of chasing a paper form, send the vendor a link to fill in and sign their W-9 online:

1. On the vendor, under **Form W-9**, click **Request W-9 online**. Save a new vendor first.
2. Optionally enter the vendor's email, so you remember who it was for, and choose when the link expires (7 to 90 days; 30 by default).
3. Click **Create link**, then **Copy link** and send it to the vendor yourself. WeldBooks doesn't email it, and the link is shown only once.
4. The vendor opens the link without signing in, fills in the form (Rev. March 2024), types their name as signature and submits. The details and TIN land on the vendor record, marked **Filled in online**.

A link works once. A new request replaces any pending one, and **Cancel request** withdraws it. A vendor the IRS has told is subject to backup withholding can't submit the form online and has to give you a W-9 another way.

### Which box a payment lands in

A box set on the bill line wins. Otherwise the box of the line's expense account is used, and otherwise the vendor's default box. The US chart of accounts comes with sensible defaults (contract labor and legal fees in NEC box 1, rent in MISC box 1, royalties in MISC box 2); change an account's box on its **Tax reporting** card.

---

## Review the year

Open the **1099 Center** in WeldBooks and pick the **Tax year**. The **Review** tab shows:

- **To file**: vendors that go on a form, by form;
- **Need attention**: a missing TIN or address, payments with no box, or a failed TIN match;
- **Below threshold**, **Corporations** and **Backup withheld**;
- the due dates for the year, with **Show all due dates** for the full list.

Each vendor has a status such as **Goes on a form**, **Below the threshold**, **Needs a TIN** or **Needs an address**, with a quick fix (**Add TIN**, **Add address**, **Mark as 1099 vendor**, **Set a box**). Click **Payments** to see which payments and bank lines make up each box, which were left out and why, and which have no box yet.

---

## File the forms

Recipient copies, and the 1099-NEC for the IRS, are due on January 31 (the next business day when that falls on a weekend; for 2026 payments that is February 1, 2027). The 1099-MISC for the IRS is due later. The 1099 Center shows each date.

### 1. Create the filing

On the **Filings** tab, click **Create 1099-NEC filing** or **Create 1099-MISC filing**. The filing starts as a **Draft** that follows your books.

- **Refresh from the books** picks up payments you recorded since.
- Click a recipient's **Edit** to add a manual adjustment to a box (with a reason), leave the recipient off the form, or add state details such as the payer's state number and state tax withheld.
- Recipients that still need a TIN or an address are listed at the top.

When it looks right, click **Mark as reviewed**.

### 2. Generate

Click **Generate**. The recipients, their addresses and TINs are frozen into the filing as they are now. After this the filing can only be corrected, not edited.

### 3. Upload to IRIS

The IRS takes 1099s through IRIS, its Information Returns Intake System. The older FIRE system closes on November 19, 2026, so WeldBooks only prepares IRIS files.

1. Click **IRIS upload file**, then **Create files**. The IRIS Taxpayer Portal takes CSV files of up to 100 recipients and one form type per file, so WeldBooks splits the filing into as many files as needed.
2. If the portal rejects the column layout, download the current template from IRIS and choose it under **IRIS template (optional)**; WeldBooks then uses its header row.
3. Download each file and upload it in the IRIS Taxpayer Portal.

The files contain full TINs: creating them needs the **Taxes: file** and **Tax IDs: reveal** permissions, and is recorded in the reveal log. Keep the files somewhere safe and delete them when you are done.

Most states receive the forms through the IRS's Combined Federal/State Filing program. When a recipient's state wants the form filed directly, the recipient's row says **File directly with** that state.

### 4. Send the recipient copies

Click **Download copies** for **Copy B** for every recipient, **Copies 1 and 2** for the states, **Copy C** for your records, or all of them. Copies show only the last four digits of the recipient's TIN. Print and mail them, or email the PDF only to vendors who agreed to electronic delivery, and keep the form available to them until October 15. Record each delivery from the recipient's row menu.

### 5. Mark as filed

After IRIS accepted the upload, click **Mark as filed** and enter the **IRS confirmation number** (the receipt ID IRIS shows) and the date.

### Corrections

To change a recipient after filing, choose **Correct** in their row menu. The filed form stays as it was; WeldBooks adds a corrected line with the new amounts, or with the name, address and TIN taken from the vendor again. The filing shows **Correction pending** until you create the **IRIS file for the corrections**, upload it and click **Mark corrections as filed**.

---

## TIN matching

The IRS TIN Matching service tells you whether a vendor's name and TIN agree before you file.

1. On the **TIN matching** tab, click **Create TIN matching file** and download it. It contains full TINs.
2. Upload it in IRS e-Services (TIN Matching needs its own e-Services access).
3. Paste the results file back, or choose it, and click **Apply results**.

Vendors get an **IRS match** or **IRS mismatch** status. For a mismatch, WeldBooks suggests asking the vendor for a new W-9 and, if none arrives in time, turning on backup withholding. The IRS's B notice rules set the exact steps; check them with your accountant.

---

## Backup withholding

When a 1099 vendor has no TIN, or the IRS tells you the TIN is wrong, you may have to withhold 24% of what you pay them.

- Turn on **Subject to backup withholding** on the vendor, or use **Turn on backup withholding** from the 1099 review.
- From the payment that brings the year's total to the reporting threshold, WeldBooks withholds 24% when you record a payment: the bills are settled in full, the bank pays the rest, and the withheld amount goes to the **Backup withholding payable** account.
- Vendors with an exempt payee code, corporations other than attorneys, and payments by card or payment network are not withheld from.
- The withheld amount is reported in box 4 of the 1099. The **Form 945** tab shows the year's backup withholding by month and by vendor, with the deposit due dates.

[Payment runs](/weldbooks/us/checks-and-ach) can't withhold yet: a vendor on backup withholding is put on hold in the run until a manager releases it to pay in full, or you pay that vendor separately.

---

## Next steps

- [Pay vendors by check or ACH](/weldbooks/us/checks-and-ach)
- [Reports and tax calendar](/weldbooks/us/reports)
- [WeldBooks for US businesses](/weldbooks/us)
