---
title: Bank feeds and reconciliation
nextjs:
  metadata:
    title: Bank feeds and reconciliation
    description: Connect your bank to WeldBooks for automatic transactions, import OFX, QFX, QBO, BAI2 and CSV statements, group payments into deposits, and reconcile against your bank statement.
screenshots_todo:
  - file: weldbooks-us-connect-bank.png
    shows: The Connect your bank dialog with the provider choice, the bank search and Business accounts selected
  - file: weldbooks-us-link-accounts.png
    shows: The Link your accounts dialog with one account linked to an existing bank account, one to be created and one skipped
  - file: weldbooks-us-csv-layout.png
    shows: Import bank statement with the CSV layout editor open (date order, negative amounts, debit and credit columns)
  - file: weldbooks-us-statement-reconciliation.png
    shows: The statement reconciliation worksheet with ticked lines, the cleared balance and a difference of 0.00
---

Connect your bank and new transactions arrive in WeldBooks on their own, ready to match and reconcile. You can also import statement files, and reconcile each account against your bank statement the way US bookkeepers do. {% .lead %}

---

## Set up your bank accounts

Go to **Bank Accounts** and click **Add Bank Account**. For a US entity you also set:

- **Account type**: **Checking**, **Savings**, **Credit card**, **Money market** or **Line of credit**. Credit cards and lines of credit are liabilities: the balance is what you owe, and a purchase increases it.
- **Routing number**: nine digits, checked against the ABA checksum.
- **Account number** (or card number): stored encrypted. Only the last four characters are shown afterwards.
- **Next check number**: the number of the next check you print from this account.
- **Ledger account**: pick one, or let WeldBooks create it for you.

---

## Connect a bank feed

1. On **Bank Accounts**, click **Connect bank**. You can also open an account and click **Connect bank feed**.
2. Under **Connect with**, choose how to connect. Each option shows how far back its history goes.
3. Search for **Your bank** and choose **Business accounts** or **Personal accounts**.
4. Click **Continue**. You sign in at your bank (or through the provider's window) and approve access, then come back to WeldBooks.
5. In **Link your accounts**, decide for each account: **Link to an existing bank account**, **Create a new bank account**, or **Do not import this account**. Skipped accounts can be linked later.
6. Under **Import transactions from**, leave the date empty to import all the history the provider offers, or set a date. If you imported statement files into the account before, start after the last imported statement so nothing is counted twice; WeldBooks reminds you of the date.
7. Keep **Start the first sync right away** ticked and click **Link accounts**.

### Which connection you can use

The options depend on your entity's country and on what WeldSuite has enabled there.

| Provider | Where | History on first connection |
| --- | --- | --- |
| Plaid | United States | Up to 730 days (about two years) |
| Stripe | United States | Up to 180 days |
| Ponto | Belgium, the Netherlands and other EU countries | Up to 540 days; bank access is renewed every 180 days |
| Enable Banking | Most European countries, including the UK | Depends on the bank, up to 730 days; access is renewed every 180 days |

History further back than the provider offers has to come from a [statement import](#import-a-statement-file). Bank feeds and statement imports work side by side.

### Day to day

WeldBooks syncs the connection on its own. On the connection you can also:

- **Sync now**, or **Ask the bank for fresh data** where the provider supports an on-demand refresh;
- open **Pending transactions**: transactions the bank reported but hasn't posted yet. They show up for reconciling only once the bank posts them;
- **Add accounts** or **Link accounts** you skipped;
- read **Notes from recent syncs**, such as transactions matched automatically.

### When a connection needs attention

| Status | What to do |
| --- | --- |
| **Reconnect needed** | Click **Reconnect** and sign in at your bank again. What was already imported is not affected. |
| **Expiring soon** | Click **Renew access** before the date shown, to keep transactions coming. |
| **Access revoked** | Access was withdrawn at the bank. Click **Connect again**. |
| **Sync error** | Try **Sync now** in a moment; reconnect if it keeps happening. |

### Disconnect

**Disconnect** stops importing and withdraws WeldBooks' access at the bank. **Remove connection** also removes the connection itself, so the accounts can be linked to a new feed. Either way, everything already imported stays on your bank accounts and in your books.

---

## Import a statement file

1. On **Bank Accounts**, click **Import statement** and choose the bank account.
2. Upload the file. For a US entity WeldBooks reads **OFX**, **QFX** (Quicken), **QBO** (QuickBooks), **BAI2** and **CSV**.
3. Check the preview: the date range, the opening and closing balance, how many lines are new and how many were already imported. WeldBooks warns you when the file seems to belong to another account or is in another currency.
4. Click **Import**. Duplicates are skipped, and lines that match something in your books are reconciled automatically.

### CSV files

US banks don't share one CSV format, so check how a CSV is read before importing. Click **Review CSV layout** to set:

- the **Date order** (month/day/year, day/month/year or year/month/day). When every date in the file could be read either way, WeldBooks asks you to confirm;
- the **Decimal separator** and **Thousands separator**;
- how **Negative amounts** are written: a minus sign, parentheses like `(123.45)`, a trailing minus, or **Separate debit and credit columns**;
- the rows to skip above the header, the delimiter, and which column holds the date, description, amount, check number, payee and reference.

The preview updates as you change the layout. Tick **Remember this layout for this bank account** and the next file from that bank imports without asking.

---

## Match transactions

On **Reconciliation**, WeldBooks suggests a match for each bank line and says why: the exact amount, a matching check number, the customer's or vendor's name, an invoice number in the reference, or a deposit total. For an open invoice or bill, **Record payment and reconcile** records the payment and reconciles the line in one step. For a payment or deposit that is already in your books, the match only links the two; nothing new is posted.

---

## Undeposited Funds and deposits

When you receive checks and cash, you usually take several to the bank at once, and the bank shows one deposit. WeldBooks works the same way:

1. When you record a customer payment, set **Deposit to** to **Undeposited Funds**. The payment waits there instead of hitting the bank account right away.
2. When you go to the bank, click **Make deposit** (on **Bank Accounts** or **Deposits**). Tick the payments you deposit together.
3. Add **Other lines** for cash back, a refund received or a bank fee on the deposit slip. A negative amount is cash back.
4. Choose the bank account and the date, and click **Make deposit**.

The deposit total then matches the single line on your bank statement, and the bank line can be matched to it. **Void deposit** reverses it: its payments go back to Undeposited Funds and the bank line is released.

---

## Reconcile a statement

Reconcile each account against your monthly statement, so you know your books agree with the bank.

1. On **Bank Accounts** or **Reconciliation**, click **Reconcile statement** and choose the account.
2. Enter the **Statement ending date** and **Statement ending balance** (for a card, the balance owed). The first time, also enter the beginning balance: usually the ending balance of the statement before you started using WeldBooks. After that, each reconciliation starts where the last one ended.
3. Tick every deposit and payment that appears on the statement. Reversed entries that cancel each other out are cleared for you.
4. Work until the **Difference** is 0.00. **Save progress** lets you come back later.
5. Click **Finish now**. If a small difference remains that you can explain, such as a bank charge or interest, use **Post adjustment** to post it to an account and finish.

Every finished reconciliation has a **Reconciliation report**: the statement summary, the cleared items and the items still uncleared. Print it or save it as a PDF for your records.

### Undo a reconciliation

If a reconciliation was wrong, someone with the **Banking: manage** permission can click **Undo** on the latest one in the account's reconciliation history. The cleared lines open again and any adjustment entry is reversed. Only the most recent reconciliation of an account can be undone, so undo newer ones first.

---

## Next steps

- [Pay vendors by check or ACH](/weldbooks/us/checks-and-ach)
- [Reports and tax calendar](/weldbooks/us/reports)
- [WeldBooks for US businesses](/weldbooks/us)
