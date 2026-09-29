---
title: Connect external domain
nextjs:
  metadata:
    title: Connect external domain
    description: Add a domain you already own and point its nameservers to WeldHost.
---

Connect a domain registered elsewhere (GoDaddy, Namecheap, Cloudflare, etc.) so you manage DNS inside WeldHost. {% .lead %}

---

## Add the domain

1. Open **WeldHost** → **External Domains** (or click **Add External Domain** in the domains list).
2. Enter the full domain name (for example `example.com`).
3. Optionally enter your current registrar, then click **Continue**.

WeldHost shows the verification record you need to add at your current DNS provider.

{% video src="/videos/help/weldhost-connect-external-domain.mp4" poster="/videos/help/weldhost-connect-external-domain.jpg" title="How to connect an external domain" caption="Add the domain, verify ownership, import existing records and note the nameservers to set at your registrar. The registrar-side steps happen on your registrar's own website and are not shown." /%}

---

## Verify ownership

WeldHost gives you a **TXT** record (name, type and value). Add it at your current DNS provider, wait a minute for it to propagate, then click **Verify ownership**. If the first check fails, wait a moment and try again.

---

## Import existing records

WeldHost scans public DNS for the domain and lists the records it found. Keep the ones you want ticked and click **Import records** to copy them into your new zone, or choose **Skip for now** and add them later.

---

## Point nameservers to WeldHost

After the import step, WeldHost shows two **nameservers** (for example `ada.ns.cloudflare.com` and `ken.ns.cloudflare.com`). Update the nameservers at your registrar to exactly those values.

1. Log in to your registrar (where you bought the domain).
2. Find **Nameservers** or **DNS** settings for the domain.
3. Replace existing nameservers with the pair WeldHost shows.
4. Save changes.

Propagation can take up to 48 hours, though it is often much faster. The domain status in WeldHost changes to **Active** when cutover completes. Use **Go to domain** to open it.

---

## Manage DNS

Once nameservers point at WeldHost, open the domain from **My Domains** and use the **DNS Records** tab. See [Add DNS records](/weldhost/manage-dns-records) for day-to-day record changes.

{% callout title="Keep email working" %}
If the domain already receives email, note existing **MX** and **TXT** (SPF/DKIM) records before switching nameservers. Recreate or import them in WeldHost, or enable WeldMail so mail records are managed for you.
{% /callout %}

---

## Next steps

- [Add DNS records](/weldhost/manage-dns-records)
- [Register a domain](/weldhost/register-domain) — if you prefer to register through WeldHost instead
