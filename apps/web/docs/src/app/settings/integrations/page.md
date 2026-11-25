---
title: Integrations
nextjs:
  metadata:
    title: Integrations
    description: Connect WeldSuite to the other apps you use, from store and accounting connectors to the apps your workflows post to.
screenshots_todo:
  - file: settings-integrations-page.png
    shows: Settings → Integrations with the category list on the left and cards for Moneybird, Stripe, Slack, Gmail and Google Sheets, at least one showing Connected
---

**Settings** → **Integrations** is where you connect WeldSuite to other apps. Connections belong to the workspace, and they work whichever WeldSuite apps you have installed. {% .lead %}

---

## Open Integrations

Go to **Settings** → **Integrations**. The apps are grouped by category, and a card shows **Connected** once its app is connected. Click a card to open its page, where you connect, test and disconnect it.

Which apps you see depends on your edition. Apps that need a service your edition doesn't run are left out.

---

## What you can connect

| Category | Apps | What the connection does |
| --- | --- | --- |
| **E-Commerce** | WooCommerce, Shopify | Imports products, orders and customers. Updates arrive over webhooks. |
| **Accounting** | Moneybird, Stripe | Imports into WeldBooks. See [Connectors](#connectors). |
| **Warehouse** | Picqer | Syncs products, stock, orders, pick lists and purchases both ways. |
| **ERP** | Odoo | Feeds WeldStash replenishment and sends reorders back as requests for quotation. |
| **Communication**, **Productivity**, **Calendar** | Slack, Gmail, Google Sheets, Google Calendar | Lets workflow steps use the app. See [App steps](/weldconnect/connect-apps). |
| **CRM** | Attio, HubSpot, Salesforce | Syncs contacts and companies with WeldCRM. |
| **Support** | Discord | Turns Discord messages into WeldDesk tickets. |
| **Developer Tools** | GitHub | Links repositories to WeldFlow projects, and lets workflows create issues. |
| **AI** | MCP servers | Gives WeldAgent's AI agents access to your own tools. |

---

## Connect an app

How you connect depends on the app:

- **Sign in at the app**: Moneybird, Stripe, WooCommerce, Slack, Gmail, Google Sheets and Google Calendar. Click **Connect**, sign in at the app and allow the access it asks for. You come back to the app's page in **Settings** → **Integrations**.
- **Paste a key**: Shopify, Picqer and Odoo. Click **Connect** and paste the values from your account at the app, for example Shopify's custom app credentials or Picqer's subdomain and API key. WeldSuite stores them encrypted and never shows them again.
- **GitHub** uses the WeldSuite GitHub App. Install it from the **GitHub** page first.

Once an app is connected, **Test** checks the connection and **Disconnect** removes it. Disconnecting a connector keeps the records it imported.

### Slack and Google Calendar

Slack and Google Calendar each connect in two ways, and their page shows both:

- **Slack**: the **Helpdesk channel** turns conversations in your Slack support channels into WeldDesk tickets, and **Workflow actions** lets workflows post messages.
- **Google Calendar**: the calendar sync keeps your calendars up to date, and **Workflow actions** lets workflows create events.

Connect each one on its own. The helpdesk channel and the calendar sync aren't available on every edition.

### GitHub in workflows

On the **GitHub** page, once the GitHub App is installed, click **Use in workflows** under **Workflow actions** so workflows can create issues and comments through it.

---

## Connectors

Connectors import live data from Shopify, WooCommerce, Moneybird, Stripe, Picqer and Odoo. After the first import, the app pushes changes over webhooks, and a periodic catch-up fills any gaps.

- **Shopify and WooCommerce**: products, orders and customers.
- **Moneybird**: contacts, sales invoices, products and purchase invoices into WeldBooks. Moneybird stays the book of record: imported invoices and bills do not post to the WeldSuite ledger. It can also receive your Stripe sales; see [Send Stripe sales to Moneybird](/weldconnect/stripe-to-moneybird).
  - **Live updates**: changes you make in Moneybird show up in WeldSuite within seconds. The connection's **Settings** tab shows whether live updates are **On** or **Off**. If they are off, click **Turn on live updates**; WeldSuite also sets them up again on its own within a few hours.
  - **Sending to Moneybird**: for contacts, products, sales invoices and bills you can set the direction per object to **Two-way** or **One-way (out to store)**. Only records you make in WeldBooks after switching an object on are created in Moneybird; your existing history is not copied. Records that came from Moneybird are updated in place when you change them in WeldBooks. Invoices made in WeldBooks go to Moneybird once they are sent, as external sales invoices that keep the WeldBooks number (Moneybird does not email them), and bills go once they are approved. Moneybird does not allow sent invoices to be edited, so a sent invoice can only be credited in Moneybird. Choose the revenue ledger (invoices and products) and the expense ledger (bills) in the push settings.
  - **Bank accounts and bank transactions** always come from Moneybird: bank data arrives through the bank feed there, so these two objects cannot be sent. When you reconcile a bank line in WeldBooks, Moneybird receives it as the payment's bank link.
- **Stripe**: finalized invoices, payments, fees and payouts into WeldBooks.
- **Picqer**: products, stock, warehouses, orders, pick lists and purchases, both ways.
- **Odoo**: products, suppliers, stock, purchase orders and sales history for WeldStash replenishment.

---

## Permissions

To connect, change or disconnect an app you need the integration permissions (**Connect integrations**, **Edit integrations**, **Disconnect integrations**). GitHub needs **Manage GitHub integration**. Ask a workspace admin if you don't see the buttons; see [Team and permissions](/settings/team-and-permissions).

---

## Apps outside the EU

On the EU edition, cards for apps that keep your data outside the EU are labelled **Leaves the EU**. An admin has to switch the app on under **Settings** → **Services outside the EU** before anyone can connect it.

---

## Next steps

- [App steps: Slack, Google and GitHub](/weldconnect/connect-apps)
- [Send Stripe sales to Moneybird](/weldconnect/stripe-to-moneybird)
