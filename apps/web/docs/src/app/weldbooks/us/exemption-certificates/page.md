---
title: Exemption certificates
nextjs:
  metadata:
    title: Exemption certificates
    description: Record the sales tax exemption certificates your customers give you, see when they expire per state, and follow up on exempt sales that still have no certificate.
screenshots_todo:
  - file: weldbooks-us-add-certificate.png
    shows: Add an exemption certificate form with a customer, two states, reason Resale and a scan on file
  - file: weldbooks-us-certificate-reports.png
    shows: Sales Tax Center → Certificates with the Expiring and Missing tabs
---

Customers who buy for resale, nonprofits and government buyers often don't pay sales tax. They give you an exemption certificate, and WeldBooks stops charging them tax in the states the certificate covers. {% .lead %}

---

## What a certificate does

When an invoice is calculated, WeldBooks looks for a valid certificate of the customer that covers the ship-to state on the invoice date. If it finds one:

- no sales tax is charged;
- the invoice prints the reason and the certificate number, for example "Exempt sale: Resale. Certificate no. 12-3456";
- the sale still appears on the sales tax return, as gross sales and as an exempt deduction with its reason.

Without a valid certificate for that state, the sale is taxed. If the customer's certificate has expired, the invoice says so.

---

## Add a certificate

1. Open **Exemption certificates** and click **Add certificate**. You can also open the customer, go to the **Exemptions** tab and click **Add certificate** there.
2. Choose the **Customer** and the **States covered**. A certificate only exempts sales shipped to the states you choose.
3. Choose the **Reason for the exemption**: Resale, Nonprofit, Government, Manufacturing, Agricultural or Other.
4. Choose the **Certificate form**: the Streamlined Sales Tax certificate (F0003), the Multistate Tax Commission uniform certificate, a state-specific form, or other.
5. Enter the **Certificate number**, **Issued on** and **Received on** dates.
6. Enter **Expires on**, or leave it blank if the certificate has no end date (see the next section).
7. Under **Coverage**, choose **Blanket** (every purchase) or **Single purchase** and pick the invoice it covers.
8. Set the **Status** to **Valid**, or **Pending** while you wait for the customer to return a complete form. A pending certificate does not exempt anything yet.
9. Upload the **Scan of the certificate** (a PDF or image up to 10 MB) and click **Add certificate**.

Certificates are filed as tax forms. Their scans are never sent to document recognition or AI.

---

## When a certificate expires

A certificate's own **Expires on** date always wins. Without one, WeldBooks applies the state's rule where it knows one, for example:

- **Florida**: an annual resale certificate is valid until 31 December of the year it was issued.
- **Washington**: a reseller permit is valid for 48 months after it was issued (24 for contractors and new businesses: enter the expiry date for those).
- **Streamlined Sales Tax states**: a blanket certificate on form F0003 stays valid while the customer's purchases are no more than 12 months apart.

Because one certificate can cover several states with different rules, the certificate's page shows **Valid per state**, with the date it stops covering each one.

These are the rules WeldBooks applies. What a state accepts, and for how long, can differ for your situation: check with the state.

### Revoke or remove a certificate

On the certificate, click **Revoke** to stop using it: sales to the customer are taxed again in every state it covers, until you click **Mark valid again** or add a new certificate. **Delete** removes it; sales already made on it keep pointing at it.

---

## A customer's default use

Some states tax a purchase differently depending on whether the buyer uses it for business or personally. Set the customer's **Use** to **Business** or **Personal** on the customer form. New invoice lines for that customer start with it, and you can change it per line.

---

## Expiring and missing certificates

Open the **Sales Tax Center** and go to **Certificates**.

### Expiring

Certificates that stop covering a state within the number of days you choose, and the ones that lapsed in the last year, with the date each was last used. Ask those customers for a new certificate before the old one ends. WeldBooks also sends owners and admins a reminder when a certificate expires within 30 days.

### Missing

Exempt sales that have no certificate on file. Under the Streamlined Sales Tax rules, you are protected if you get a complete certificate within 90 days of the sale. The **Missing** tab shows each sale with its **Cure deadline** and the time left.

Once a sale is past its deadline, the sales tax return counts it as taxable, and the return's worksheet tells you how much tax that adds. Follow up with the customer well before the deadline. States outside the Streamlined agreement can have other rules: check with the state.

---

## Next steps

- [Sales tax returns](/weldbooks/us/sales-tax-returns)
- [Sales tax](/weldbooks/us/sales-tax)
