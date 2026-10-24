---
title: Send Stripe sales to Moneybird
nextjs:
  metadata:
    title: Send Stripe sales to Moneybird
    description: Import your Stripe invoices, payments, fees and payouts into WeldBooks and send them on to Moneybird automatically.
screenshots_todo:
  - file: weldconnect-stripe-connect-dialog.png
    shows: Connect Stripe dialog with the WeldBooks entity, the Import invoices from date, the Connect with Stripe button and the closed Advanced API key section
  - file: weldconnect-moneybird-push-settings.png
    shows: Moneybird connection Settings tab, Send sales to Moneybird section filled in (revenue ledger, Stripe account, fee and transfer ledgers) with the status block showing sent and waiting counts
---

Connect Stripe and Moneybird once, and every paid Stripe invoice ends up in Moneybird with its payment, Stripe's fees and the payout to your bank, without typing anything over. {% .lead %}

---

## How it works

1. **Stripe → WeldBooks.** Each finalized Stripe invoice becomes a sales invoice in WeldBooks, with its lines, the VAT Stripe Tax calculated and the customer. Your Stripe balance shows up as a bank account, **Stripe balance (EUR)**, with a line for every payment, its fee and every payout.
2. **WeldBooks → Moneybird.** Each invoice goes to Moneybird as an *external sales invoice* (externe verkoopfactuur): it keeps Stripe's invoice number and PDF, and Moneybird does not send it again. For every Stripe payout, WeldBooks adds the Stripe lines to a "Stripe" account in Moneybird and books them: the payment against its invoice, the fees on your fee ledger and the payout on your transfer ledger.

New invoices and payouts go over automatically, a few minutes after Stripe reports them. Moneybird stays your bookkeeping: the imported invoices do not post to the WeldBooks ledger.

---

## Before you start

- A **WeldBooks entity** for the company that sells through Stripe.
- A **Moneybird** connection (**Settings** → **Integrations** → **Moneybird**).
- In Moneybird, an account for your Stripe balance: **Bank** → **Add account** → **Other account**, named for example *Stripe*. WeldBooks writes the Stripe lines into it.
- In Moneybird, the ledgers you want to use: revenue, transaction costs (for Stripe's fees) and a transfer ledger such as *Kruisposten* (for payouts on their way to your bank).

---

## Connect Stripe

1. Go to **WeldConnect** → **Connectors** and choose **Stripe**.
2. Pick the **WeldBooks entity** and the date to **import invoices from**. Older Stripe invoices are skipped, so nothing you already booked in Moneybird gets a duplicate.
3. Click **Connect with Stripe** and approve in Stripe.

Stripe asks you to grant WeldSuite full access to your account: that is the only kind of access Stripe offers a platform like WeldSuite. WeldSuite only reads invoices, payouts and balances; it never changes anything in your Stripe account.

{% callout title="Can't connect with one click?" %}
Some Stripe accounts can't be connected this way, for example an account that another platform manages. Open **Advanced: connect with an API key** in the same dialog, paste a restricted key and click **Connect with API key**. Create it in Stripe under **Developers** → **API keys** → **Create restricted key** with *read* access to Invoices, Customers, Charges, Balance, Payouts and Events, and *write* access to Webhook endpoints.
{% /callout %}

The first import starts right away. You can follow it on the connection's **Activity** tab.

---

## Turn on sending to Moneybird

1. Open your **Moneybird** connection and go to the **Settings** tab.
2. Under **Send sales to Moneybird**, switch on **Send imported Stripe sales to Moneybird**.
3. Pick the **revenue ledger** for the invoice lines.
4. Pick the **Stripe account** you created in Moneybird, then the **fee ledger** and the **transfer ledger** for payouts. Leave the Stripe account empty to send only the invoices; Moneybird then marks them paid without the Stripe lines.
5. Optionally set a date to **only send invoices issued on or after**, and choose Moneybird tax rates for reverse charge, sales outside the EU, exempt sales and invoices without VAT. Without a choice, WeldBooks matches the rate by its percentage and name.
6. Click **Save push settings**. Sending starts straight away.

The status block shows how many invoices and payouts were sent and how many are waiting. A large first import is sent in batches every few minutes, because Moneybird limits how fast it accepts new documents.

---

## When something isn't sent

An invoice that Moneybird refuses (most often: no tax rate with the right percentage) is listed under the status with the reason. Fix the cause, for example add the tax rate in Moneybird or pick one in the settings, then click **Send now**. Failed invoices are also retried on their own after a few hours.

Lines WeldBooks can't book on its own, such as refunds and disputes, stay open on the Stripe account in Moneybird. Book those there as usual.

---

## Next steps

- [WeldBooks overview](/weldbooks)
- [WeldConnect overview](/weldconnect)
