# WeldHR, Privacy

The live privacy policy is **https://weldsuite.org/privacy** and covers all WeldSuite
products. Link that URL in both consoles; do not paste text into the store forms.
Before submitting, check the policy names the HR data below (absence and sick
leave, payslips, receipts, location at clock-in): App Review compares the policy
with the privacy label.

## What the app collects and why

| Data | When | Why | Stored where |
| --- | --- | --- | --- |
| Name, email, user id | Sign-in | Account, showing who did what | Clerk + WeldSuite master DB |
| Employee record (job, department, manager, start date, employee number) | Always, read-only | Profile, team views | Employer's tenant DB |
| Leave, sick leave, shifts, clock times | When the member uses those screens | App functionality | Employer's tenant DB |
| Expense claims + receipt photos | When the member files a claim | App functionality | Tenant DB + R2 (no public URL) |
| Payslips, annual statements | Read only, when payroll is on | App functionality | Tenant DB / R2 |
| **Precise location** | Only at clock in/out, only when the workspace requires being at a work location | Checking the member is at work | Stored with the clock entry (`clock_in_latitude` …) in the tenant DB |
| Push token | After the member allows notifications | Delivering notifications | WeldSuite master DB |
| App performance (expo-observe) | Always | Diagnostics | Expo |
| Product analytics (Mixpanel) | Only if `EXPO_PUBLIC_MIXPANEL_TOKEN` is set for the build; it is not today | Analytics | Mixpanel |

Not collected: contacts, browsing history, audio, video, health data from the
device (sick leave is entered by the member, not read from HealthKit), the photo
library as a whole (Android uses the system photo picker; iOS only the photo
picked), advertising identifiers. No tracking across apps, so no App Tracking
Transparency prompt.

Sharing: none for advertising. Processors: Clerk (authentication), Apple APNs /
Google FCM / Expo push (notifications), Cloudflare and Neon (hosting), Expo
(diagnostics). The employer is the controller of the HR data; WeldSuite processes
it on their behalf.

Deletion: Profile → **Delete account** (also on the no-workspace screen) deletes
the WeldSuite account and every workspace membership, and the workspaces the
person was the only member of. It is refused, with an explanation, while they are
the only admin of a workspace that still has other members (app-api `/api/account`). The employer's HR records
about the person (leave, payslips, claims) stay with the employer, which the
dialog says; those are removed through the employer.

## App Store Connect → App Privacy answers

"Do you or your third-party partners collect data from this app?" **Yes.**

For every type below: **Linked to the user: Yes. Used for tracking: No.**

| Category → type | Purposes |
| --- | --- |
| Contact Info → Name | App Functionality |
| Contact Info → Email Address | App Functionality |
| Location → Precise Location | App Functionality |
| Sensitive Info | App Functionality (sick leave / absence reasons count as health-related HR data; declaring it is the safe answer) |
| Financial Info → Other Financial Info | App Functionality (expense amounts, payslips) |
| User Content → Photos or Videos | App Functionality (receipt photos) |
| User Content → Other User Content | App Functionality (leave notes, shift requests) |
| Identifiers → User ID | App Functionality |
| Identifiers → Device ID | App Functionality (push token) |
| Diagnostics → Performance Data | App Functionality |

If a build ships with a Mixpanel token, add **Usage Data → Product Interaction** for Analytics.

## iOS privacy manifest

Expo generates `PrivacyInfo.xcprivacy` from the native modules' own manifests at
prebuild. Check the archive's manifest in Xcode's privacy report before the first
submission; add `ios.privacyManifests` to `app.json` only if a required-reason
API shows up without a declared reason.
