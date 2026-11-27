# WeldMail e2e flows (Maestro)

Black-box flows for the native WeldMail apps (`apps/ios/Apps/WeldMail`,
`apps/android/apps/weldmail`), ported from the Expo app's `.maestro`
flows. They select on accessibility identifiers, which are the Android test
tags too, so one flow runs on both: the inbox (filters, pull to refresh, the
mailbox menu), opening an email, the composer, search with a filter,
settings with subscriptions and the outbox, and a send-and-receive round
trip. The Expo app's "forgot password" flow has no native counterpart: the
native apps sign in on WeldID's own page.

```
config.yaml          # runs everything in flows/
flows/               # one journey per file, numbered
subflows/login.yaml  # WeldID's sign-in page, from a fresh install
```

- `MAESTRO_TEST_EMAIL` / `MAESTRO_TEST_PASSWORD`: a WeldID account on the EU
  test cluster (`app.test.weldsuite.eu`), password sign-in, two-step
  verification off, in one workspace with WeldMail, a mailbox and at least
  one email in its inbox.
- `MAESTRO_TEST_MAILBOX`: the mailbox the round trip writes to (optional).
- `APP_ID`: `com.weldsuite.weldmail.dev` (the Android debug build, the
  default) or `com.weldsuite.weldmail` (iOS, an Android release build).
- The flows assert English text: run them on a device set to English.

```bash
maestro test apps/mobile-shared/maestro/weldmail --exclude-tags writes   # read-only
maestro test apps/mobile-shared/maestro/weldmail                         # + a mail to itself
```
