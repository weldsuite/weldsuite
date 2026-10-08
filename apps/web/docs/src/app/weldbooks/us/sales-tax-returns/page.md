---
title: Sales tax returns
nextjs:
  metadata:
    title: Sales tax returns
    description: Prepare each state's sales tax return in the WeldBooks Sales Tax Center, check it against your books, record the filing and the payment, and handle changes after filing.
screenshots_todo:
  - file: weldbooks-us-sales-tax-center.png
    shows: Sales Tax Center overview with estimated tax due, overdue periods, due within 14 days and two agency cards
  - file: weldbooks-us-return-worksheet.png
    shows: A calculated return with the stepper, the worksheet (gross sales, deductions, taxable sales, tax due) and Tax by location
  - file: weldbooks-us-pre-file-check.png
    shows: The Checks tab of a reviewed return with the pre-file check and the liability check
---

The Sales Tax Center lists every filing period of every state agency you are registered with. For each period WeldBooks builds the return worksheet from your books, checks it, and records the filing and the payment. You file the return yourself on the state's website. {% .lead %}

---

## The Sales Tax Center

Open the **Sales Tax Center** in WeldBooks. Its tabs are **Overview**, **Returns**, **Reports**, **Certificates** and **Nexus**.

The **Overview** shows:

- **Estimated tax due**: the tax on each agency's open period that no return counts yet.
- **Overdue periods**: periods past their due date with no filed return. File these as soon as you can; the state may charge penalties and interest.
- **Due within 14 days**.
- A card per agency with its next period, the estimated sales and use tax, and the last return you filed. Click **Open return** (or **Continue** on one you started).

The **Returns** tab lists every period of every agency with its due date, status (**Upcoming**, **In progress**, **Due**, **Overdue**, **Filed**, **Paid**) and the total due. Filter by agency or status, or pick **Needs attention**.

Periods follow each agency's filing frequency, first period start and due day. If an agency shows no periods, set its first period start on the agency.

---

## Prepare a return

A return goes through five steps: **Calculate**, **Review**, **Pre-file check**, **File** and **Pay**. The button at the top of the return always shows the next one.

### 1. Calculate

Click **Calculate return**. WeldBooks builds the worksheet from the tax recorded on your invoices, credit memos, bills and journal entries for the period:

- **Gross sales** shipped into the state;
- **Deductions** by reason: sales for resale, to nonprofits, to government, to manufacturers, agricultural, other exempt, non-taxable sales, exempt freight, marketplace-facilitated sales, returns and allowances, and bad debts written off;
- **Taxable sales**, **Sales tax due**, **Use tax due** and **Total tax due**;
- **Tax by location**: the tax per county, city or district with the reporting code, since many states want local tax broken out.

The **Documents** tab lists every document counted on the return, with its jurisdiction rows. If documents change before you file, click **Recalculate**.

An agency on the cash basis counts sales when they are paid, not when they are invoiced.

### 2. Review

Check the worksheet against what the state's form asks for. Then add **Adjustments** where needed:

| Type | Usually |
| --- | --- |
| Vendor discount | Negative: a discount some states give for filing and paying on time |
| Prepayment credit | Negative |
| Penalty | Positive |
| Interest | Positive |
| Rounding | Either |
| Other | Either |

Positive amounts increase what you pay, negative amounts reduce it. Each adjustment can post to its own ledger account. Where the state offers a vendor discount, WeldBooks proposes it; it only holds when you file and pay on time, so remove it if you will be late.

Click **Save adjustments**, then **Mark as reviewed**.

### 3. Pre-file check

The **Checks** tab runs two checks once the return is reviewed:

- **Pre-file check** compares the net sales on the return with the income posted for that state, and lists the documents behind any difference: income posted without tax data, invoices without a ship-to state, and entries made directly on the payable account. It is skipped for a cash-basis return, which doesn't line up with the income of the period.
- **Liability check** compares the agency's payable account in the ledger with what the tax records say you owe, and lists the entries that explain any difference.

You can still file when a check finds something, but look at each finding first.

### 4. File

1. Click **Open state portal** and file the return on the state's website, using the worksheet.
2. Back in WeldBooks, click **File return**. Enter the **Confirmation number** the portal gave you and the **Date filed**, then click **Mark as filed**.

WeldBooks does not send the return to the state. Marking it filed records that you did, and ties every document counted on the return to it, so the filed return can't change afterwards. Adjustments are locked from then on.

If you file after the due date, WeldBooks tells you. Add any penalty and interest as adjustments before you record the payment. If documents were posted or changed after you calculated, WeldBooks asks you to recalculate and review before filing.

### 5. Pay

Click **Record payment**, choose the **Bank account** you paid from, and enter the **Amount paid**, the **Payment date** and a **Reference** (for example the payment confirmation or check number). WeldBooks posts a journal entry that settles the agency's payable account and pays from that bank account.

If the amount differs from the total due, give the reason; the difference is posted to the rounding account. A return that shows a credit is refunded rather than paid: enter the refund as a negative amount.

You can **Export CSV** of the worksheet at any step, and keep **Notes** for your own records. **Delete return** removes the worksheet and adjustments of an unfiled return; the ledger doesn't change and you can open the return again.

---

## Changes after filing

A filed return never changes. When a document dated in a filed period is posted or changed later (a late credit memo, an invoice voided back into the period), it shows on the return's **Exceptions** tab as a change after filing. You have two options:

- **Carry forward**: select the rows (or **Carry forward all open**) and the next return of the agency counts them. Recalculate that return to pick them up.
- **Amend return**: WeldBooks creates an amended return for the same period. It counts the changes and pays only the difference from the filed return. File the amendment on the state's portal as well.

On a cash-basis return, payments recorded after filing for invoices dated in the period can only be picked up by amending. Which option a state accepts can differ: check with the state.

---

## Sales tax reports

The **Reports** tab has four reports for any date range:

- **Liability**: per agency, what you collected and accrued, what is filed and paid, and what is still owed, compared with the agency's payable account. **Show jurisdictions** splits it further.
- **Sales summary**: gross, taxable, exempt, non-taxable and marketplace sales with the tax charged, grouped by ship-to state, customer or jurisdiction, plus exempt sales by reason.
- **Exceptions**: documents whose sales tax needs a second look, such as a sale with no ship-to state, tax charged in a state where you are not registered, a taxable sale without tax, or tax set by hand.
- **Provider reconciliation**: with Stripe Tax or Avalara, the tax the provider calculated for each invoice against your books.

---

## Reminders

Owners and admins get an in-app reminder when a return is due within 7 days, due tomorrow or today, and when it is overdue. The [tax calendar](/weldbooks/us/reports#tax-calendar) lists the same due dates next to your income tax deadlines; a period you mark filed here is shown as done there.

---

## Next steps

- [Exemption certificates](/weldbooks/us/exemption-certificates)
- [Reports and tax calendar](/weldbooks/us/reports)
- [Sales tax](/weldbooks/us/sales-tax)
