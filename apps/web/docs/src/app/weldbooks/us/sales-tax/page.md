---
title: Sales tax
nextjs:
  metadata:
    title: Sales tax
    description: Register in a state, choose a sales tax engine (manual, Stripe Tax or Avalara), set up rates and zones, and charge the right sales tax on invoices and bills in WeldBooks.
screenshots_todo:
  - file: weldbooks-us-register-state.png
    shows: Sales tax agencies → Register in a state, Registration step, with the state "at a glance" panel
  - file: weldbooks-us-tax-engine.png
    shows: Tax engine screen with Manual, Stripe Tax and Avalara AvaTax options and the manual-engine warning
  - file: weldbooks-us-zones.png
    shows: An agency's Zones tab with an origin zone and a zone of ZIP ranges, with combined rates
  - file: weldbooks-us-invoice-sales-tax.png
    shows: A US invoice with the sales tax panel open, showing state, county and city components and a line's Sales tax options
  - file: weldbooks-us-nexus-monitor.png
    shows: Sales Tax Center → Nexus with a state approaching and one over its threshold
---

WeldBooks charges sales tax only in the states where you tell it you are registered, at the rate for the address you ship to. You choose how the rate is found: rates you keep yourself, or a tax provider that looks up every address. {% .lead %}

---

## How sales tax works in WeldBooks

- **Only where you are registered.** Each state you collect in is an **agency** in WeldBooks. A sale shipped to a state without a registered agency gets no tax, and the invoice says why.
- **By address.** The rate comes from the ship-to address, or the bill-to address when there is no ship-to. In a state that taxes by the seller's location, a sale shipped within that state uses the rate at your own location instead.
- **By date.** The rate is the one that applied on the invoice date, not today's, so back-dated invoices and credit memos get the right rate.
- **Frozen once finalized.** A draft recalculates when you change it. Once an invoice is finalized, its tax never changes, whatever happens to rates later.
- **Never zero by accident.** If the tax can't be calculated (no address, no rate, or the provider is unreachable), you can save a draft, but you can't finalize or send it until the tax is calculated.

WeldBooks does not decide where you have to register. The [nexus monitor](#where-you-may-need-to-register) shows how close you are to each state's threshold, but registering is your decision, made with the state.

---

## Register in a state

1. In WeldBooks, open **Sales tax agencies**. From the Sales Tax Center you can also click **Set up agencies** when you have none yet.
2. Click **Register in a state** and choose the state.
3. WeldBooks shows the state **at a glance**: who runs the tax, its online portal, whether it taxes at the seller's or the buyer's address, whether it is a Streamlined Sales Tax member, whether you may report on a cash basis, the usual due day and any discount for filing on time. These are the usual rules: check them against your registration notice.
4. On the **Registration** step, fill in:
   - **Status**: **Registered** (tax is charged), **Pending** (you applied, no tax yet) or **Monitoring** (you only watch your sales there, no tax).
   - **Registration or permit number**.
   - **Registered from**: tax is charged only on documents dated on or after this date.
   - **Filing frequency**: monthly, quarterly, semiannual or annual, as the state told you.
   - **First filing period starts**: leave blank to start in the month your registration begins.
   - **Return due day**: the day of the month after the period. Use 31 for the last day of the month.
   - **Reporting basis**: accrual or cash. Cash is offered only where the state allows it.
   - The portal address and notes are optional.
5. Click **Register**.

WeldBooks creates a sales tax payable account for the agency, so the balance sheet shows what you owe each state. It also adds shipping and handling rules from how the state usually treats them. Confirm those rules before you rely on them.

Some states have cities or districts that collect their own tax (for example Colorado's home-rule cities). Tick **This is a local agency** on the state step to register with one of those separately.

### Change or close a registration

Open the agency to see its registration, filing setup and ledger accounts. Use **Change status** to **Mark registered**, **Mark pending**, **Monitor only** or **Close registration**. Closing stops tax on documents dated after today and keeps the history. An agency that ever collected tax can't be deleted; WeldBooks closes it instead.

---

## Choose a tax engine

The **Tax engine** screen (the button on **Sales tax agencies**) decides how WeldBooks works out the tax:

| Engine | How it works | Good for |
| --- | --- | --- |
| **Manual** | You enter the rates, zones and rules yourself. No extra cost. | A business that collects in one or two states |
| **Stripe Tax** | Stripe calculates the rate for every US address on your own Stripe account. Stripe bills you per calculation. | Sellers in many states |
| **Avalara AvaTax** | Avalara calculates the rate for every US address. Includes an address check. | Businesses that already have an Avalara account |

{% callout type="warning" title="With the manual engine the rates are your responsibility" %}
WeldBooks uses exactly the jurisdictions, rates, zones and rules you enter, and keeping them current is up to you. Rates change often, and an outdated or missing rate means you charge the wrong tax. If you sell into many states, use Stripe Tax or Avalara.
{% /callout %}

### Stripe Tax

1. In your Stripe dashboard, create a restricted API key with read and write access to Tax.
2. Choose **Stripe Tax**, paste the key under **Stripe API key** and click **Save engine settings**.
3. Click **Check registrations**. Stripe Tax only calculates in states where you have a registration in Stripe, so the check lists states registered in WeldBooks but missing in Stripe (Stripe won't calculate there) and the other way round (click **Create agency** to add them here).

Stripe Tax calculates sales tax only. To accrue [use tax](#use-tax-on-bills) with Stripe Tax, also enter that state's jurisdictions and rates as you would for the manual engine.

### Avalara AvaTax

1. Choose **Avalara AvaTax** and enter your **Account ID**, **License key** and **Company code**.
2. Choose **Sandbox (testing)** or **Production** and save.
3. Run **Check registrations** as above. Use **Address check** to see how Avalara reads an address before an invoice depends on it.

Credentials are encrypted before they are stored and are never shown again. Enter new ones to replace them, or click **Remove credentials** to forget them and switch back to the manual engine.

---

## Set up rates for the manual engine

Open an agency. Its tabs hold everything the manual engine uses for that state.

### Jurisdictions and rates

A jurisdiction is a taxing authority: the state, a county, a city or a special district.

1. Click **Add jurisdiction**. Add the state first, then each county, city or district tax you collect.
2. Give it a name, and if you have them, its FIPS or Streamlined Sales Tax **Code** and the **Reporting code** the state return asks for.
3. Enter the **First rate** and the day it starts. Start it on the day your registration begins, so invoices dated back to then are taxed correctly.

Rates are dated. When a rate changes, click **Add rate** and enter the new rate with its start date; tick **End the current rate the day before this one starts** so the two don't overlap. **Show rate history** lists every rate with its status.

### Zones

A zone is the set of jurisdictions that apply together at an address, matched on the buyer's ZIP code.

1. On the **Zones** tab, click **Add zone**.
2. Choose its **Jurisdictions**, for example the state, the county and the city.
3. Enter the **ZIP codes**, separated by commas. Write a range as `78710-78799`. Use five-digit ZIP codes, not ZIP+4.
4. For the zone where your business is, tick **This is my own location**. It is used for sales within the state when the state taxes at the seller's location.
5. If two zones cover the same ZIP code, the one with the lower **Priority** number wins.

A ZIP code that is in no zone is charged the state rate only, and the invoice shows a warning that the address could not be matched.

### Taxability rules

Without a rule, every product is taxable at 100%. Add a rule on the **Taxability rules** tab when a state treats a kind of product differently:

- **Taxable**: turn off when the product isn't taxed in this state.
- **Taxable share (%)**: when only part of the price is taxed. For example, Texas taxes SaaS on 80% of the price.
- **Applies to**: any buyer, business use or personal use. Some states tax software only for business buyers, or at another rate.
- **Rate for this product (%)**: replaces the combined rate for this product.
- **Starts on** and **Ends on**: for a change in the law, enter the day it starts. Earlier documents keep the old treatment.

The examples on these screens illustrate how the fields work. Check the actual rules with the state.

---

## Product tax codes

Each invoice and bill line has a tax code that says what kind of product it is. A line takes its product's code when the product has one, and **General goods** otherwise.

| Code | For |
| --- | --- |
| General goods | Physical products with no special treatment |
| Software as a service | Hosted software the customer uses online |
| Digital goods | Downloads, e-books, music and video |
| Services | General services |
| Professional services | Consulting, legal, accounting and similar |
| Shipping | Shipping and delivery charges |
| Handling | Handling, packaging and service fees |
| Groceries | Food and drink for home consumption |
| Prepared food | Restaurant meals and heated food |
| Clothing | Apparel and footwear |
| Prescription drugs | Drugs sold on a prescription |
| Non-taxable | Never taxed |

Put shipping on its own line with the **Shipping** code, so each state's treatment of shipping applies.

---

## Sales tax on invoices

1. Create an invoice as usual. Give it a ship-to address with a state and ZIP code (or a bill-to address with them). An invoice can't be finalized without one.
2. The sales tax panel shows the tax your engine calculated, with **Show breakdown** for the state, county, city and district parts. It is an estimate until you finalize.
3. Open a line's **Sales tax options** to change:
   - **Tax code**: the kind of product.
   - **Used by**: business or personal use. The default comes from the customer's **Use** setting.
   - **Price includes sales tax**: the tax is backed out of the price. The invoice still prints the tax amount.
   - **Override the tax**: set the tax by hand. A reason is required, and the override stays when you edit the draft.
4. Finalize the invoice. Its tax is now fixed.

Under **Sales tax** on the invoice you can also:

- **Ship from a different address**: the origin matters in states that tax by the seller's location. By default it is your business address.
- **Sold through a marketplace facilitator**: the marketplace collects and pays the tax, so none is charged here. The sale still counts toward your nexus thresholds.

If the panel shows **Check the sales tax**, read the note. Common ones: you are not registered in the ship-to state, the ZIP code matches no zone, the customer's exemption certificate expired, or no rates are set up for the address.

With Stripe Tax or Avalara, WeldBooks records the finalized invoice with the provider. If that fails, the invoice detail shows it and offers **Retry tax commit**.

Customers who don't pay sales tax are handled with [exemption certificates](/weldbooks/us/exemption-certificates).

### Credit memos

A credit memo for an invoice follows that invoice's tax line by line, at the original rates. Change quantities or prices to credit part of a line, or remove lines you don't credit. You can't add a line that wasn't on the original invoice.

### Recurring invoices

The tax of a recurring invoice is calculated each time an invoice is generated, from the customer's address on that day.

---

## Sales tax on bills

Sales tax a vendor charges you is part of the cost of what you bought. On a US bill it is posted to the line's expense or asset account, not to a tax account you can reclaim.

### Use tax on bills

When a vendor charged no sales tax on something you use yourself, you may owe use tax to your state instead. On the bill line, tick **Accrue use tax**. WeldBooks calculates it at the **Delivery address** (your business address by default) and accrues it when the bill is approved. It isn't part of what you pay the vendor: it goes to the agency's use tax payable account and shows on the next return as use tax due.

If you have no active registration in the delivery state, WeldBooks still accrues the use tax and warns you. Whether you owe use tax on a purchase depends on the state; ask your accountant if you're unsure.

---

## Where you may need to register

In most states you have to collect sales tax once your sales into the state pass a threshold (economic nexus). Open the **Sales Tax Center** and go to **Nexus** to see your sales into each state against its threshold.

- **Register now**: over the threshold, with no registration in WeldBooks.
- **Approaching**: at 80% or more of a threshold.
- **Over, and registered**: over the threshold, and you collect there.

Click a state for the details: the measurement window (for example the previous or current calendar year, or a rolling 12 months), the sales threshold and any transaction count, which sales count, and whether marketplace sales count. Points the research could not confirm are marked **Check with the state**. Click **Register** to start an agency for that state.

Thresholds and rules change. Use the monitor as a warning, and confirm with the state or your accountant before you decide.

---

## Next steps

- [Exemption certificates](/weldbooks/us/exemption-certificates)
- [Sales tax returns](/weldbooks/us/sales-tax-returns)
- [WeldBooks for US businesses](/weldbooks/us)
