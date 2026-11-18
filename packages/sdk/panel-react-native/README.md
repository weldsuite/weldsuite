# @weldsuite/panel-react-native

The React Native SDK for WeldPanel, WeldSuite's product analytics: screens,
app opens and installs, your own custom events, identified users and their
profiles, groups (companies, accounts) and super properties. Events are
batched, retried with back-off and, with consent, kept on the device while it
is offline. No ids are kept or sent until the person consents (unless the
project needs no consent). No native code and no runtime dependencies besides
`react-native` itself. MIT licensed.

## Install

```sh
npm install @weldsuite/panel-react-native @react-native-async-storage/async-storage
```

`@react-native-async-storage/async-storage` is optional: the SDK takes any
storage with `getItem`, `setItem` and `removeItem` returning promises. Without
one, everything lives in memory until the app is closed.

## Start

Create the client once, outside your components, with your project token
(WeldPanel → Settings → Install):

```ts
// analytics.ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createWeldPanel } from '@weldsuite/panel-react-native';

export const panel = createWeldPanel({
  token: 'wpk_…',
  storage: AsyncStorage,
  // React Native core can't read these: pass them in, for example from expo-application.
  app: { id: 'com.acme.shop', version: '2.1.0', build: '210' },
});
```

`createWeldPanel()` returns at once. It loads the project's settings from the
collector and the stored state from `storage` in the background (`panel.ready`
resolves when both are done) and keeps the calls made in the meantime: consent,
opt-out, `identify()`, super properties and groups are applied first, then the
launch events, then your events. If the settings can't be loaded (offline), the
SDK goes by what it stored last time, and asks for consent when it has nothing.

Options:

| Option | Default | |
|---|---|---|
| `token` | | The project token, `wpk_…`. |
| `apiHost` | `https://pnl.weldsuite.org` | The collector. |
| `storage` | memory | `AsyncStorage` or anything with the same three methods. |
| `app` | | `{ id, version, build }`: the bundle id (sent as `$app_id`, WeldPanel's "host" for app events), version and build. |
| `flushAt` | `20` | Send as soon as this many events wait (at most 100). |
| `flushIntervalMs` | `10000` | Send at the latest this long after an event was queued. |
| `captureLifecycle` | `true` | `$app_opened`, `$app_backgrounded`, `$app_installed`, `$app_updated`. |
| `maxQueue` | `1000` | Events kept waiting while offline; the oldest are dropped first. |
| `debug` | `false` | Warn in the console about dropped events and properties, and failed sends. |

## Screens

Call `screen(name)` whenever the person moves to another screen. With React
Navigation:

```tsx
import { NavigationContainer, useNavigationContainerRef } from '@react-navigation/native';
import { useRef } from 'react';
import { panel } from './analytics';

export function App() {
  const navigation = useNavigationContainerRef();
  const current = useRef<string | undefined>(undefined);

  const onScreen = () => {
    const name = navigation.getCurrentRoute()?.name;
    if (name && name !== current.current) panel.screen(name);
    current.current = name;
  };

  return (
    <NavigationContainer ref={navigation} onReady={onScreen} onStateChange={onScreen}>
      {/* … */}
    </NavigationContainer>
  );
}
```

`screen()` sends a `$screen` event, and every later event carries the screen
as `$screen_name`, its title, and its URL `app://<app id>/<screen>` (spaces as
`-`). WeldPanel shows app events by screen the way it shows web events by page.

## API

| Call | Does |
|---|---|
| `track(name, props?)` | A custom event. `name`: starts with a letter or digit, then letters, digits, spaces and `_ . : / -`, at most 100 characters. `props`: flat, at most 50 keys like identifiers, values strings (cut to 2048 characters), finite numbers, booleans or `null`. Invalid events and properties are dropped. |
| `screen(name, props?)` | The person is on this screen now: sends `$screen`. |
| `identify(userId)` | Who the person is (1 to 255 characters). Sends `$identify` with the anonymous and the user id, then adds `user_id` to every event, also on later launches. With a different id than before, it first starts a new anonymous id, so two people sharing a device don't merge. Needs consent. |
| `reset()` | Forget the user id, super properties and groups, and start a new anonymous id and session. Call it on log out. |
| `people.set(props)` / `people.set_once(props)` | The identified user's profile; `email` and `name` are the profile's own `$email` and `$name`, `$avatar` and `$created` can be set too. Needs consent and `identify()`. |
| `people.unset(key or keys)`, `people.increment(key, by = 1)` or `people.increment({ key: by })` | Remove properties; add to numeric ones. |
| `register(props)` | Super properties: sent with every event from now on, kept between launches (with consent). |
| `registerOnce(props)` | Only those not registered yet. |
| `unregister(key)` | Stop sending one. |
| `group(type, key, props?)` | The person belongs to this group (`group('company', 'acme', { name: 'Acme' })`). Every later event carries `$group_<type>: key`, and the group's profile gets `props`. `type`: lower case letters, digits and `_`, starting with a letter; at most 5 types per project. Needs consent: before it the membership is kept in memory only and nothing about groups is sent. |
| `groups.set / set_once(type, key, props)`, `groups.unset(type, key, keys)` | A group's profile, without joining it. `name` is the group's `$name`. |
| `resetGroups()` | Leave every group. |
| `consent.grant()` / `consent.revoke()` | See below. |
| `optOut()` / `optIn()` | Send nothing at all, now and on later launches, until `optIn()`. Opting out deletes what is stored. |
| `flush()` | Send waiting events now. Never rejects. |
| `getDistinctId()` | The user id once identified, else the anonymous id; `null` without consent. |
| `getSessionId()` | The current session (a new one starts after 30 minutes without events); `null` without consent. |
| `ready` | Resolves when the SDK has started. |
| `shutdown()` | Remove the app state listener and timers; later calls do nothing. |

The SDK never throws into your app.

### What every event carries

Besides its own properties: `$screen_name`, `$os` (`ios`, `android`),
`$os_version`, `$device_type` (`mobile` or `tablet`), `$device_model` (`iPhone`
or `iPad` on iOS, maker and model on Android), `$app_id`, `$app_version`,
`$app_build`, `$screen_width`, `$screen_height` and `$locale`, those that are
known; your super properties; and `$group_<type>` for each group. When there
are more than 50, the event's own properties go first, then groups, then super
properties, then the device's.

### App lifecycle

- `$app_opened`: at start, and each time the app comes back to the foreground.
- `$app_backgrounded`: when it goes to the background. Waiting events are sent
  right away, since the app may not come back.
- `$app_installed`: the first launch the SDK may remember (with consent).
- `$app_updated`: `app.version` differs from the one stored; `previous_version`
  holds the old one.

Turn them off with `captureLifecycle: false`; sending on background stays.

## Consent

What the SDK does before consent depends on the project's consent mode
(WeldPanel → Settings):

- **Consent required** (the default): until `consent.grant()`, events are sent
  without an anonymous id, session or user id, nothing is written to storage,
  and `identify()` and `people.*` are dropped. WeldPanel counts these people
  with a daily-rotating, cookieless hash. Group operations are still sent: they
  describe a company, not the person.
- **No consent needed**: the SDK behaves as if consent was given.

`consent.grant()` creates the ids and from then on keeps them, the user id,
super properties, groups and unsent events in `storage` (one record per
project, `weldpanel:<token>`, and `weldpanel:<token>:queue`). Events collected
before it still leave without ids. `consent.revoke()` deletes what is stored
and goes back to sending without ids. `optOut()` stops everything and is
remembered (`weldpanel:optout`).

## Delivery

Events are sent as JSON to `POST {apiHost}/e` in batches of at most 100 events
and 64 KiB. A failed send (no network, a timeout, a 5xx or 429) keeps the
batch and tries again after 1 s, 2 s, 4 s … up to a minute; a batch the
collector refuses (another 4xx) is dropped. With consent, waiting events are
kept in `storage` and sent on the next launch if the app is closed first.
