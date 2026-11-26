# Privacy practices: purpose and permissions

For the Chrome Web Store's **Privacy practices** tab (and Edge's equivalent).
The manifest is built by `src/manifest/manifest.ts`; `manifest.test.ts` fails
on any change to this set until ADR PASS-009 is amended, so this file and the
manifest can't drift apart silently.

## Single purpose

> WeldPass fills, saves and updates the logins a person keeps in WeldPass,
> WeldSuite's password manager, on the websites where they sign in.

## Permission justifications

**`storage`**

> Keeps the sign-in session with the person's WeldSuite server (the refresh
> token in local storage; the short-lived access token in session storage,
> which is memory only), which server and workspace they chose, and their
> settings (whether inline menus and save prompts show, and the sites where
> they don't). A login waiting for "save this login?" is kept in session
> storage for at most five minutes and is never written to disk.

**`identity`**

> Signs the person in to WeldSuite with OpenID Connect (authorization code with
> PKCE) through `chrome.identity.launchWebAuthFlow`, redirecting to the
> extension's own `chromiumapp.org` address. The extension shows no password
> form of its own.

**`scripting`**

> Runs the form filler in the active tab when the person presses Fill, Save or
> Fill into page in the toolbar popup, and brings the content script into
> tabs that were already open when the extension was installed or updated.

**`activeTab`**

> Gives the toolbar popup the address of the tab it was opened on, to list the
> logins saved for that site, without the broader `tabs` permission.

**`favicon`**

> Shows each saved login's website icon in the toolbar popup, so people can
> spot the right login at a glance. The icons come from the browser's own
> favicon cache, so showing them sends no request to those websites or to any
> other service, and nothing about the person's saved logins leaves the
> browser. Chrome may show "Read the icons of the websites you visit" when the
> extension is installed.

**Host permissions: `https://app.weldsuite.eu/*`, `https://auth.weldsuite.eu/*`**

> WeldSuite EU's API (the person's saved logins) and its sign-in server. The
> extension talks to no other server.

**Optional host permissions: `https://*/*`, `http://localhost/*`**

> Asked for only when the person chooses "Use your own server" and types the
> address of their organisation's self-hosted WeldSuite, and then only for
> that server and its sign-in server. Plain `http` is allowed only for
> `localhost`.

**Content script on `https://*/*` and `http://localhost/*`, in all frames**

> Shows the WeldPass icon in login, sign-up and one-time-code fields, fills the
> login the person picks from the WeldPass menu, and notices when a login form
> is submitted so it can offer to save or update that login. It runs on every
> site because people sign in on every site. It can't ask for a password: a
> password reaches a page only after the person picks a login in the
> extension's own menu, which the page can't read or script, and only if the
> site matches that login. Plain `http` pages other than `localhost` get
> nothing.

**Web accessible resources: `menu.html`, `prompt.html` (dynamic URL)**

> The inline menu and the save bar are extension pages shown in a frame, so the
> page they appear on can't read the list of logins or the bar's contents. The
> dynamic URL changes per browser session, so sites can't probe for the
> extension at a fixed address.

## Remote code

> No. All code is in the package. The extension loads no scripts from the
> network and evaluates none (`script-src 'self'`).
