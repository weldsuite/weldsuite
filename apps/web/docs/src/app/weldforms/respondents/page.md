---
title: Who can respond
nextjs:
  metadata:
    title: Who can respond
    description: Choose whether anyone, people with a verified email, or workspace members can answer a form.
---

Set who may fill in a form under **Settings** > **Respondents**. {% .lead %}

---

{% figure src="/images/help/weldforms-respondents.png" alt="The form Settings tab with the respondent options" caption="Respondent options are on the form Settings tab." /%}

## Anyone with the link

The default. Respondents are anonymous. WeldForms protects the form with a bot check, a hidden honeypot field, a minimum time between start and submit, and rate limits per IP address and per form. You can lower the rate limits.

"One response per browser" is offered as a **soft limit**: it stops casual repeats, but a determined person can get around it. Use a stronger mode when it matters.

## Verified email

Respondents enter an email address and a 6-digit code sent to it. The code is valid for 10 minutes and allows 5 tries, after which the address is locked for 15 minutes.

Options:

- **One response per email**
- **Let respondents edit their response** until the form closes

An invitation link counts as verified, because the link is personal.

## Workspace members only

The public link sends members to WeldSuite, where the form opens inside the platform and is answered with their own session. Options:

- **One response per member**
- **Anonymous to the owner**: for pulse and HR surveys. The response stores no member, only a keyed code that enforces one response per person, so nobody can see who said what.

{% callout title="Pick the mode for the question you ask" %}
Only verified email, invitations and members-only can enforce a single response per person. Anonymous links can only limit repeats softly.
{% /callout %}
