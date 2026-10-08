---
title: Checks and ACH payments
nextjs:
  metadata:
    title: Checks and ACH payments
    description: Pay vendor bills in a batch from WeldBooks by printed check or ACH (NACHA file), with approvals, holds on changed bank details, a check register and Positive Pay files.
screenshots_todo:
  - file: weldbooks-us-payment-run-wizard.png
    shows: New payment run, Bills step, with bills grouped by vendor and one vendor blocked by Bank details changed
  - file: weldbooks-us-payment-run-detail.png
    shows: A pending ACH run with Approvals (1 of 2), Holds and the History panel
  - file: weldbooks-us-print-checks.png
    shows: Print checks for an approved check run on preprinted stock, with Preview and Mark as printed
  - file: weldbooks-us-payment-settings.png
    shows: Payment settings for a checking account with the What is ready card and the Check printing and ACH origination sections
---

A payment run pays several approved bills at once, by check or by ACH. Nothing is paid until the run is approved. Then you print the checks, or download a NACHA file and upload it to your bank. {% .lead %}

Payment runs are for US entities. The screens are **Payment runs**, **Check register**, **Positive Pay** and **Payment settings**.

---

## Before your first run

### Set up the bank account you pay from

Open **Payment settings** and choose the bank account. The **What is ready** card shows what is still missing for **Checks**, **ACH files** and **Positive Pay**.

**Check printing**

- **Next check number**. Check numbers only go forward.
- **Paper layout**: check on top, in the middle or at the bottom with two stubs, or three checks per page. Checks print on Letter paper.
- **Print on blank check stock**: leave this off and use preprinted check stock (see the note below).
- Bank name, the fractional routing number, the bank address and the text under the signature line.
- **Printer alignment**: print the alignment test page on plain paper at 100% scale, hold it against your check stock in front of a light, and shift the print until the boxes sit on the fields.

{% callout type="warning" title="Use preprinted check stock for now" %}
On blank check stock the whole check is printed, including the MICR line of numbers along the bottom. That line needs a special MICR font, which WeldBooks doesn't include yet, so the MICR band stays empty. Use check stock that already has the MICR line printed, or have it printed another way. Don't deposit a check without its MICR line.
{% /callout %}

**ACH origination**: what goes in the NACHA file. Your bank tells you these values:

- **Immediate destination** and **Immediate origin** (left empty, WeldBooks uses the bank account's routing number and your company identification);
- **Company name on statements** (16 characters, shown on the vendor's statement) and the **EIN**, which becomes the company identification;
- **Entry description** (10 characters; "VENDOR PAY" when empty) and the **Default SEC code** for business vendors;
- **Verification hold (days)**: a vendor whose bank details changed in this many days (10 by default) is held until someone verifies the change;
- **Balanced file**: adds an offsetting debit to your account in the same file, if your bank wants one;
- **Allow Same Day ACH**, if your bank supports it;
- **Require prenotes**: send a $0 test entry before the first payment to a new account and hold that payment for three banking days.

**Positive Pay**: the file format your bank expects (see [Positive Pay](#positive-pay)).

### Add your vendors' bank details

To pay a vendor by ACH, open the vendor and fill in **ACH bank details**: the **Routing number** (checked against the ABA checksum), the **Account type** (checking or savings) and the **Account number**, which is stored encrypted.

When a vendor's routing number, account number or type changes, payments to that vendor are held until someone verifies the change. Call the vendor on a phone number you already had, not one from the message that announced the change, then click **Mark as verified** on the vendor. Verifying needs the **Banking: manage** permission.

---

## Create a payment run

1. Open **Payment runs** and click **New payment run**.
2. **How to pay**: choose the **Bank account**, the **Payment date** and the **Method**, and optionally show **Only bills due on or before** a date:
   - **Check**: one approval by default. Check numbers are assigned when the run is approved.
   - **ACH**: two approvals by default. Choose the **SEC code** (per vendor by default: PPD for individuals, the account's default for businesses), and **Same Day ACH** if it is allowed.
3. **Bills**: approved bills with an open balance are listed per vendor. Tick the bills to pay and change the amount to pay part of a bill. Vendors that can't be paid by ACH (no bank details, an invalid routing number, details changed and not verified, or bills already in another run) are marked.
4. **Review**: check the totals and any vendors that will start on hold, then click **Create and submit for approval** (or **Create draft** to finish later).

---

## Approve the run

Someone with the **Banking: manage** permission opens the run and clicks **Approve**. When the last approval is in, WeldBooks records the payments: the bills are paid and the ledger is updated.

- Two approvals means two different people.
- The person who made the run can approve it, but can't be its only approver.
- Fewer than two approvals on an ACH run takes the **Banking: manage** permission when creating it.
- **Reject** sends the run back to draft with your reason, and clears the approvals so far. **Cancel run** closes it; nothing has been paid and the bills can go into another run.

### Holds

A hold keeps a vendor out of the payments until someone looks at it. The run's **Holds** list shows each one:

| Hold | What to do |
| --- | --- |
| No bank details, Invalid routing number | Fix the details on the vendor |
| Bank details changed | Verify the change on the vendor; the hold clears by itself |
| Prenote needed, Prenote pending | The $0 prenote goes in the next file; the payment waits three banking days |
| Bills in another run | Some of the vendor's bills are in another open run |
| Backup withholding | Payment runs can't withhold yet. Pay this vendor separately, or release the hold to pay in full |

A manager can **Release hold** with a reason, except for bank detail holds, which only clear when the vendor is fixed or verified. **Check holds again** refreshes them. Every action on a run is kept in its **History**.

---

## Print the checks

1. On an approved check run, click **Print checks**.
2. Load the check stock so the first check matches the number WeldBooks shows.
3. Select the checks, then **Preview**, **Download PDF** or **Print**.
4. When they printed correctly, click **Mark as printed**.

A printed check can only be voided. To replace a misprinted or lost check, click **Void** on it, give the reason and tick **Reissue a replacement check**: the payment entry is reversed, the bills open again, and the same amount goes out on a new check under the next number. A check that has cleared the bank can't be voided.

The **Check register** lists every check written, voided ones included, in check number order.

---

## Send the ACH file

1. On an approved ACH run, click **Download NACHA file**.
2. Upload the file in your bank's portal. It contains your vendors' account numbers: keep it off shared drives and delete it once the bank has it.
3. When the bank has accepted the file, click **Mark as completed**.

You can download the file again if the upload failed.

---

## Positive Pay

With Positive Pay, your bank only cashes checks that are on the list you send it. To make the list:

1. Open **Positive Pay** and choose the bank account, the file format and the date range.
2. Click **Make and download file**. It holds the checks printed in the range and the checks voided in it.
3. Upload it in your bank's portal.

WeldBooks offers **Generic CSV** and **Generic fixed width** formats, and templates named for Bank of America (CashPro), Chase (ACCESS), Wells Fargo (CEO) and U.S. Bank. Banks don't publish their file layouts, so these templates are a starting point: set the columns to the layout your bank gave you, and run your bank's test before you rely on it.

---

## Next steps

- [1099s](/weldbooks/us/1099)
- [Bank feeds and reconciliation](/weldbooks/us/bank-feeds)
- [WeldBooks for US businesses](/weldbooks/us)
