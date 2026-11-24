# WeldPass, Google Play Data safety

## Overview

- Does your app collect or share any of the required user data types? **Yes**
- Is all of the user data collected by your app encrypted in transit? **Yes** (HTTPS only; `usesCleartextTraffic` is off)
- Do you provide a way for users to request that their data is deleted? **Yes**: items are deleted in the app; the account is deleted through the workspace admin or WeldSuite support.

## Data shared with third parties

None. Data goes only to the WeldSuite server the person signs in to.

## Data collected

| Data type | Collected | Optional | Purpose |
| --- | --- | --- | --- |
| Personal info → Name | Yes | No | App functionality, Account management |
| Personal info → Email address | Yes | No | App functionality, Account management |
| Personal info → User IDs | Yes | No | App functionality, Account management |
| App activity → Other user-generated content (logins, notes, cards) | Yes | No | App functionality |
| App activity → App interactions (each reveal of a password, in the vault's activity) | Yes | No | App functionality, Security |
| Financial info → Payment info (card items a person chooses to save) | Yes | Yes | App functionality |

Not collected: location, contacts, photos, audio, files, calendar, messages,
web browsing, diagnostics, device IDs for advertising.

## Security practices

- Data encrypted in transit: yes.
- Users can request data deletion: yes.
- Independent security review: no (answer as it stands at submission).
