---
title: Set up a project
nextjs:
  metadata:
    title: Set up a project
    description: Create a WeldPanel project, add the script snippet or npm package to your site, and check that events arrive.
screenshots_todo:
  - file: weldpanel-new-project.png
    shows: The New project dialog with a name, the type set to Website and one allowed domain
  - file: weldpanel-install.png
    shows: The project's Install tab with the Installation status card showing Receiving events, and the Script tag block
---

A project is one website or web app you want to track. Create it, paste one script tag into your site, and the first events show up within a minute or two. {% .lead %}

---

## Create a project

1. Open **WeldPanel**. If WeldPanel is not in your app rail yet, [install it from the App Store](/getting-started/install-apps) first.
2. Click **New project**. It is on the WeldPanel home page when you have no project yet, and on the **Projects** page.
3. Enter a **Name**, for example the name of your site.
4. Choose a **Type**:
   - **Website**: a marketing site, shop or blog. Visitors are mostly anonymous.
   - **Web app**: a product people log in to. You can [recognise those users](/weldpanel/track-events) later.
5. Optionally add **Allowed domains**: only events from these sites are accepted. Use `*.example.com` to include every subdomain. Leave the list empty to accept events from any site.
6. Click **Create project**. The project opens on its **Install** tab.

Creating projects needs the project create permission, which owners and admins have by default. If you cannot create one, ask an owner or admin of the workspace.

---

## Add the snippet to your site

On the **Install** tab, copy the **Script tag** and paste it into the `<head>` of every page you want to track. It has two parts:

```html
<script>
  /* a short stub that defines window.weldpanel and queues calls until the SDK has loaded */
</script>
<script async src="https://pnl.weldsuite.org/s.js" data-project="wpk_…"></script>
```

Always copy the snippet from the **Install** tab: it carries your project's own token. The stub lets your site call `weldpanel.consent.grant()` or `weldpanel.identify()` before the script has loaded, without losing the call.

The **Project token** (`wpk_…`) is safe to put in page source: it can only send data, never read it.

From the first page view, the snippet counts pageviews (also in single-page apps), clicks and form submits, and frustration signals. Before the visitor consents it counts without cookies, see [Consent and cookieless counting](/weldpanel/consent).

### Or use the npm package

For an app that bundles its own code, install the package and initialise it once, at startup:

```bash
npm install @weldsuite/panel-sdk
```

```ts
import { init } from '@weldsuite/panel-sdk';

const panel = init({ token: 'wpk_…' });
panel.track('Signed up', { plan: 'pro' });
```

`init()` returns at once and works the same as `window.weldpanel` from the snippet. It does nothing on the server, so it is safe to call during server rendering.

---

## Check that events arrive

The **Installation status** card at the top of the **Install** tab shows whether your site is sending events:

1. Add the snippet to your site.
2. Open your site in a browser.
3. Wait for the first event to show up. The card changes from **Waiting for the first event** to **Receiving events**, with the time of the last event.

The page checks every 10 seconds. **Receiving events** means an event arrived in the last 24 hours. The **Overview** fills in a minute or two after the first pageview.

### Nothing arrives?

- **Is the script on the page?** Open your browser's developer tools and look for a request to `s.js` on the **Network** tab.
- **Is the domain allowed?** If the project lists **Allowed domains**, events from other sites are dropped. To test on your own computer, add `localhost`.
- **Is the page excluded?** Pages that match an **Excluded pages** pattern send nothing.
- **Is collection paused?** A paused project drops every event.
- **Is an ad blocker on?** Some blockers stop analytics scripts. Test in a browser without one.

Add `data-debug` to the script tag to see in the browser console why an event or call was dropped:

```html
<script async src="https://pnl.weldsuite.org/s.js" data-project="wpk_…" data-debug></script>
```

---

## Project settings

Open **Projects** and click a project. Its tabs:

| Tab | What it holds |
| --- | --- |
| **Install** | Installation status, the script tag, the npm code, the project token and server examples |
| **Server keys** | Keys for sending events from your server, see [Server-side tracking](/weldpanel/server-side). Only for people who can manage projects. |
| **General** | **Name**, **Type** and **Allowed domains** |
| **Privacy & collection** | **Autocapture**, **Consent**, **Masking** and **Excluded pages** |
| **Danger zone** | Pause collection, rotate the token, delete the project |

On **Privacy & collection**:

- **Autocapture**: records clicks and form submits on its own, with the text of the element. Turn it off to send only the events you track yourself. Rage and dead clicks, and click heatmaps, need it on.
- **Consent**: **Wait for consent** or **Track without consent**. See [Consent and cookieless counting](/weldpanel/consent).
- **Masking**: **Strict**, **Balanced** or **Relaxed**. See [Session recordings](/weldpanel/recordings#masking).
- **Excluded pages**: path patterns that are never tracked, for example `/admin/*` or `/checkout/success`. `*` matches any characters.

Only people who can manage WeldPanel projects can change these settings. Everyone else sees the values.

---

## Pause, rotate or delete

On the **Danger zone** tab:

- **Pause collection**: the collector drops events from this project until you click **Resume collection**. Your site keeps working.
- **Rotate token**: issues a new project token. The snippet on your site stops working at once, so paste the new snippet straight away.
- **Delete project**: type the project's name to confirm. Events from your site are rejected from then on, and the project disappears from WeldPanel. This cannot be undone from here.
