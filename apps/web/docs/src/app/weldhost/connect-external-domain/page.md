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

1. Open **WeldHost** → **External Domains** (or **Add External Domain** from the domains list).
2. Enter the full domain name (for example `example.com`).
3. Submit the form.

WeldHost creates a pending zone and shows the verification steps you need at your registrar.

---

## Verify ownership

Depending on the domain, WeldHost may ask you to:

- Add a **TXT** verification record at your current DNS provider, **or**
- Temporarily confirm control through your registrar's API

Follow the on-screen instructions exactly. Verification can take a few minutes to propagate.

---

## Point nameservers to WeldHost

After verification, update **nameservers** at your registrar to the values WeldHost shows (for example `ns1.weldhost.net` and `ns2.weldhost.net`).

1. Log in to your registrar (where you bought the domain).
2. Find **Nameservers** or **DNS** settings for the domain.
3. Replace existing nameservers with the WeldHost pair.
4. Save changes.

Propagation can take up to 48 hours, though it is often much faster. The domain status in WeldHost changes to **Active** when cutover completes.

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
