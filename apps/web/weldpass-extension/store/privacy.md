# Privacy practices: data usage

For the Chrome Web Store's **Data usage** section. Draft: check it with
whoever owns the privacy policy before the first submission.

## What the extension collects

The store asks which kinds of user data the extension collects or transmits.
"Collects" there includes sending data to the developer's own servers, which
for WeldPass are the person's own WeldSuite server.

| Category | Collected | What, and why |
| --- | --- | --- |
| Personally identifiable information | Yes | The signed-in person's name and email address, from their WeldSuite sign-in, shown in the extension and kept with the session. |
| Health information | No | |
| Financial and payment information | No | WeldPass can hold cards, but the extension doesn't fill or read them. |
| **Authentication information** | **Yes** | Usernames, passwords and 2FA codes: read from the WeldSuite server to fill a login the person picks, and read from a submitted login form to save or update it in WeldPass when the person agrees. The extension's own sign-in tokens. |
| Personal communications | No | |
| Location | No | |
| Web history | Yes | The origin (scheme, host and port; never the path or query) of a page where the person opens the WeldPass menu or submits a login form, sent to their WeldSuite server to find the logins saved for that site. A saved login also stores the page address without its query or fragment. |
| User activity | No | |
| **Website content** | **Yes** | The values typed in a login form when it is submitted, to offer saving them. |

## Certifications

All three apply:

- The data isn't sold or transferred to third parties outside the approved use
  cases.
- The data isn't used or transferred for purposes unrelated to the item's
  single purpose.
- The data isn't used or transferred to determine creditworthiness or for
  lending.

## Where data goes

Only to the WeldSuite server the person signs in to: WeldSuite EU
(`app.weldsuite.eu` and its sign-in server `auth.weldsuite.eu`) by default,
or their organisation's self-hosted server. No analytics, no error reporting,
no other hosts.

## Privacy policy URL

To be decided: a page on `weldsuite.eu`.
