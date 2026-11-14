---
title: Track events and identify users
nextjs:
  metadata:
    title: Track events and identify users
    description: Send your own events with track(), recognise logged-in users with identify(), keep profiles up to date with people.*, and describe your events in the lexicon.
screenshots_todo:
  - file: weldpanel-lexicon.png
    shows: The Lexicon page on the Events tab with descriptions, a verified event and the Show hidden switch
---

The snippet counts pageviews and clicks on its own. Add your own events for the things that matter to you, such as a sign-up or an order, and tell WeldPanel who your logged-in users are. {% .lead %}

The examples use `weldpanel`, the global the snippet defines. With the npm package, call the same methods on the object `init()` returns.

---

## Events WeldPanel sends on its own

| Event | When |
| --- | --- |
| `$pageview` | A page loads, and on every navigation in a single-page app |
| `$pageleave` | The visitor leaves a page, with how far down they scrolled |
| `$autocapture` | A click on a link, button or similar, or a form submit (when **Autocapture** is on) |
| `$identify` | Your site calls `identify()` |
| `$rageclick`, `$deadclick`, `$quickback`, `$excessivescroll`, `$exception` | Frustration signals and errors, see [Frustration signals](/weldpanel/frustration-signals) |

Names that start with `$` belong to WeldPanel. In the event pickers they are listed under **Built-in events**; yours are under **Your events**.

---

## Track your own events

```js
weldpanel.track('Signed up', { plan: 'pro', seats: 5 });
```

- **The name** starts with a letter or digit, then letters, digits, spaces and `_ . : / -`, at most 100 characters.
- **Properties** are a flat object of at most 50 keys. Keys look like identifiers (`plan`, `seat_count`). Values are text (cut at 2,048 characters), numbers, `true`/`false` or `null`.

An event or property that breaks these rules is dropped. Add `data-debug` to the script tag to see why in the browser console.

Use the same name for the same thing everywhere, for example always `Signed up`, never `signup` on one page and `Sign up` on another. Names and properties then show up once in the pickers and the lexicon.

---

## Identify logged-in users

When someone logs in to your app, tell WeldPanel who they are with your own user id:

```js
weldpanel.identify('user_123');
```

- Use a stable id from your own system, at most 255 characters.
- Events the visitor sent before logging in, in the same browser, count for the user too. One user can have several browsers and devices.
- Calling `identify()` again with the same id does nothing. With a different id, WeldPanel first starts fresh, so two people who share a browser are not merged.
- `identify()` needs consent. Without it, the call is dropped. See [Consent and cookieless counting](/weldpanel/consent).

When the user logs out, call `reset()`. WeldPanel forgets the user id and starts a new anonymous id and visit:

```js
weldpanel.reset();
```

---

## Keep the profile up to date

After `identify()`, set properties on the user's profile. They appear on the profile under **Users**, and you can filter and break down reports by them.

```js
weldpanel.identify('user_123');
weldpanel.people.set({ email: 'jane@example.com', name: 'Jane Doe', plan: 'pro' });
```

| Call | What it does |
| --- | --- |
| `people.set(props)` | Sets properties. `email` and `name` become the profile's email and name. |
| `people.set_once(props)` | Sets only the properties the profile does not have yet, such as the sign-up date. |
| `people.unset('plan')` | Removes one property, or several with an array. |
| `people.increment('logins')` | Adds 1 to a number. `people.increment('credits', -5)` subtracts. `people.increment({ logins: 1, orders: 2 })` does several at once. |

Profile calls follow the same value rules as `track()`, need consent and need `identify()` first. They are sent with the next batch of events.

Set `email` if you use WeldCRM: a CRM person with the same email then shows the user's website activity. See [Users and profiles](/weldpanel/users).

---

## A typical login flow

```js
// After a successful login
weldpanel.identify(user.id);
weldpanel.people.set({ email: user.email, name: user.name, plan: user.plan });
weldpanel.track('Logged in');

// On logout
weldpanel.reset();
```

---

## Describe your events in the lexicon

**Lexicon** (under **Setup**) lists the event and property names WeldPanel has seen in your project, with how often each was seen in the last 30 days. Switch between **Events** and **Properties**, and search by name.

- **Description**: write what an event or property means, so your team uses it the right way.
- **Verified**: mark the names you trust. Pickers show a **Verified** badge next to them.
- **Hidden**: hide noise from the event and property pickers. Hidden names stay in your data. Turn on **Show hidden** to see them again.

Changing the lexicon needs permission to edit reports. Without it, you can read it.
