# WeldHR, Play Store Data Safety Form Answers

Background and the reasoning per data type: `privacy.md`.

## Does your app collect or share any of the required user data types?
**Yes**, collects. **Does not share** (processors acting for WeldSuite are not "sharing" under Play's definition).

## Is all of the user data collected by your app encrypted in transit?
**Yes**, HTTPS/TLS only (cleartext traffic is not allowed in release builds).

## Do you provide a way for users to request that their data is deleted?
**Yes**, in the app (Profile → Delete account) and at https://weldsuite.org/support.
Play also asks for a **web URL** for deletion requests: use https://weldsuite.org/support
(or a dedicated account-deletion page if one exists by then).

## Collected data types

All: collected **Yes**, shared **No**, processed ephemerally **No**.

| Category | Type | Required / optional | Purposes |
| --- | --- | --- | --- |
| Location | Precise location | Optional (only when the workspace requires it at clock-in) | App functionality |
| Personal info | Name | Required | App functionality, Account management |
| Personal info | Email address | Required | App functionality, Account management |
| Personal info | User IDs | Required | App functionality, Account management |
| Personal info | Other info (job title, department, employee number) | Required | App functionality |
| Financial info | Other financial info (expense claims, payslips) | Optional | App functionality |
| Health and fitness | Health info (sick leave reported by the user) | Optional | App functionality |
| Photos and videos | Photos (receipt photos the user picks or takes) | Optional | App functionality |
| Files and docs | Files and docs (receipts, payslip PDFs) | Optional | App functionality |
| App activity | Other user-generated content (leave requests, notes) | Optional | App functionality |
| App info and performance | Diagnostics | Required | Analytics |
| Device or other IDs | Device or other IDs (push token) | Optional | App functionality |

Add **App activity → App interactions** (Analytics) only if a build ships with a Mixpanel token.

## Security practices
- Data is encrypted in transit
- Users can request that data be deleted
- (Optional) Independent security review: No

## Not collected
Approximate location (only precise, see above), contacts, calendar, messages (SMS/email),
audio, video, web browsing, installed apps, payment info, credit score.

## Permissions declarations (App content)
- **Location**: foreground only, `ACCESS_FINE_LOCATION` / `ACCESS_COARSE_LOCATION`; background location is blocked. No declaration form needed for foreground use.
- **Photos and videos**: no `READ_MEDIA_*` permission (blocked in `app.json`), so no Photo and Video Permissions declaration.
- **Camera**: for receipt photos.
- **Advertising ID**: not used; `com.google.android.gms.permission.AD_ID` is blocked in `app.json`, so answer "No".
