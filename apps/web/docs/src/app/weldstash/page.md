---
title: WeldStash
nextjs:
  metadata:
    title: WeldStash
    description: Inventory, warehouses, pick lists, and packing in WeldStash.
---

WeldStash tracks stock across locations and supports pick, pack, and ship workflows. {% .lead %}

---

## What you can do

- **Products** — your catalog: SKUs, barcodes, prices, images and sales tax codes
- **Suppliers** — vendor records and purchase context
- **Warehouses** — multiple storage locations
- **Stock levels** — on-hand quantities per SKU and location
- **Pick lists** — batch picking for orders
- **Packing** — pack picked orders, print packing slips, and mark them shipped
- **Shipping labels** (WeldSuite EU) — PostNL and DHL Parcel labels for every box, delivery to a pickup point, return labels, customs papers for parcels leaving the EU, and tracking until delivery

---

## Typical flow

1. Define **warehouses** and **products**.
2. Receive stock (adjust quantities or import).
3. Generate **pick lists** from open orders.
4. **Pack** orders and print packing slips from the packing view.
5. **Create labels** (WeldSuite EU): choose the carrier, the boxes and their weight, and print the labels.
6. **Mark as shipped**: WeldStash issues the picked stock and marks the order shipped. Under **Shipments** you follow each parcel until it is delivered.

---

## Connect a carrier (WeldSuite EU)

Go to **Settings → Apps → WeldStash → Carriers** and connect PostNL or DHL Parcel:

- **Your own contract**: enter the API key and customer details from your carrier account. The carrier bills you directly.
- **WeldSuite's contract** (where offered): no carrier account needed. Each label is paid from your workspace credits.

A parcel leaving the EU needs customs papers: the label dialog lists the picked products, and you add each line's HS code and country of origin.

---

## Next steps

- [WeldBooks overview](/weldbooks) — purchase documents and COGS
