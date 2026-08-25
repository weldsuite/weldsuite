---
title: WeldConnect
nextjs:
  metadata:
    title: WeldConnect
    description: Automations, workflows, and integrations in WeldConnect.
---

WeldConnect automates work across WeldSuite and external services — triggers, actions, and execution history. {% .lead %}

---

## What you can do

- **Workflows** — visual or step-based automations
- **Triggers** — events that start a run (new deal, form submit, webhook, schedule)
- **Actions** — send email, update CRM, call APIs, branch on conditions
- **History** — see each run, success/failure, and logs for debugging
- **Templates** — start from common patterns

The sidebar lists workflows, templates, variables, and analytics.

---

## Connectors

WeldConnect **Connectors** import live data from first-party apps (Shopify, WooCommerce, Moneybird). After the first import, the provider pushes changes over webhooks; a periodic catch-up fills gaps.

- **Shopify / WooCommerce** — products, orders, and customers.
- **Moneybird** — contacts, sales invoices, products, and purchase invoices/receipts into WeldBooks. Moneybird stays the book of record: imported invoices and bills do not post to the WeldSuite ledger.

Connect from WeldConnect → Connectors, or from Settings → Integrations.

---

## Typical flow

1. Create a **workflow** from blank or template.
2. Choose a **trigger** (for example "Deal moved to Won").
3. Add **actions** (notify Slack channel, create task, send mail).
4. **Test** with sample data, then **publish**.
5. Monitor **History** for failures.

---

## Next steps

- [WeldCRM overview](/weldcrm) — common trigger source for sales automations
- [Settings overview](/settings) — API keys and integration credentials
