---
title: Share a form
nextjs:
  metadata:
    title: Share a form
    description: Share a WeldForms form by link, QR code, website embed or personal email invitation.
---

Everything for sending a form out is on the **Share** tab. {% .lead %}

---

## Link and QR code

A published form has a public link of the form `https://forms.weldsuite.org/f/<publicId>`. Copy it from the **Share** tab, or download its **QR code** as PNG or SVG for print.

{% figure src="/images/help/weldforms-share.png" alt="The Share tab with the public link, QR code and embed options" caption="The link, the QR code and the embed options in one place." /%}

### Prefill and hidden fields

Add values to the link to prefill answers or fill hidden fields, for example to know which campaign a response came from. The **URL builder** on the Share tab writes the link for you.

### Your own domain

On WeldSuite EU and self-hosted installs, forms can live on your own domain, such as `forms.example.com`. Add it in **Settings → Apps → WeldForms → Custom domains**, then add the DNS records shown there at your DNS provider:

| Record | Why |
| --- | --- |
| **TXT** `_weldforms.forms.example.com` | Proves the domain is yours |
| **CNAME** `forms.example.com` to the address shown | Sends visitors to WeldForms. An apex domain such as `example.com` uses **A** records instead, when your install offers them |

WeldSuite checks the records every few minutes, or straight away with **Check now**, and then sets up a certificate. Once the domain is active:

- **Make primary** to use it in every link WeldSuite gives you: the public link, the QR code, the embed snippet and invitation emails. Links on `forms.weldsuite.org` keep working.
- Choose a **home form** to show at the domain itself (`https://forms.example.com/`). Every other form is at `/f/<publicId>` on the domain.

A domain shows only your workspace's forms. You need the **manage** permission for forms to add or change domains.

---

## Embed on a website

The **embed configurator** shows a live preview and gives you a snippet to paste into your page:

```html
<div data-wf="YOUR_PUBLIC_ID" data-wf-mode="inline"></div>
<script async src="https://forms.weldsuite.org/embed.js"></script>
```

Choose a mode:

| Mode | What respondents see |
| --- | --- |
| **Inline** | The form inside your page, growing to fit its height |
| **Popup** | A dialog, opened by a button or link you add |
| **Slider** | A side panel that slides in |
| **Popover** | A floating button in the corner that opens the form |
| **Full page** | The form fills the page |

Other options, set as `data-wf-*` attributes or in JavaScript, include hidden field values (`data-wf-hidden="source=pricing,plan=pro"`), a fixed height (`data-wf-height`), opening on page load, on exit intent or at a scroll depth, hiding the form after it was submitted, and callbacks for ready, submitted and closed.

In **Settings** you can list the websites that may embed the form. By default any site can.

### In the website builder

If your site is built with WeldSuite, add the **WeldForms form** block to a page, choose the form and a mode, and the embed is placed for you. The block takes a public id, a mode, a height (auto or pixels), the button text and colour of popups, sliders and popovers, hidden fields, and the portal address, which normally stays `https://forms.weldsuite.org`.

---

## Email invitations

Invite people from the **Share** tab: workspace members, WeldCRM people, a CRM list, or pasted email addresses, up to 500 per batch. Each person gets a **personal link**. Opening it starts the form as that person, without a code, and counts as a verified identity.

You see the status per person (sent, opened, started, completed) and a progress bar for the whole batch. You need the **send** permission for forms to invite.

### Reminders

- **By hand**: **Remind everyone who has not answered**. Anyone emailed in the last hour is skipped.
- **Automatic**: send a reminder after a number of days, then every so many days, at most three times and never after the close date.

WeldMail's sending guard checks the whole batch first. If it refuses, nothing is sent and you are told why. You can revoke an invitation to turn its link off.

---

## Next steps

- [Who can respond](/weldforms/respondents)
- [Privacy and safety](/weldforms/privacy-and-safety)
