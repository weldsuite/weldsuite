# WeldHR, Review Notes and Demo Account

Reviewers can't see anything without a workspace that has WeldHR and an employee
record linked to the account. A plain sign-up lands on the no-workspace screen,
which reviewers reject as "app does not work". So both stores need a ready demo login.

## Demo workspace (production)

Create once, in **production** (`app.weldsuite.org`), and keep it alive:

1. Workspace **WeldHR Demo** with WeldHR installed (and payroll on, so the Pay screen shows)
2. The existing review accounts `appleverification@weldsuite.org` (App Store) and `googleverification@weldsuite.org` (Google Play), with email + password sign-in (no SSO, no 2FA, no email code):
   role with My HR **and** the team permissions (`leave:approve`, `declarations:approve`, `employees:read`),
   so Home, Schedule, Absence, Expenses, Announcements and the Team views all have content
3. Linked employee record with: a manager, leave balances, two approved and one pending leave request,
   a week of shifts and one open shift, two expense claims (one with a receipt), one payslip,
   one announcement, one onboarding task
4. Two or three colleagues with requests waiting for approval
5. Clock-in **without** a location requirement, so the reviewer is not asked for location
   (mention the feature in the notes instead)

Store the password in WeldPass (shared vault "App Review"), never in this repo.

## App Store Connect → App Review Information

- Sign-in required: **Yes**, username `appleverification@weldsuite.org`, password from WeldPass
- Notes:

> WeldHR is the employee app for companies that use WeldSuite HR. Accounts are created by the employer; the demo account above belongs to a demo company with sample data.
>
> To try: Home → Clock in. Absence → + → request leave. Expenses → + → new claim, attach a receipt photo. Profile (tap the workspace at the top of Home) → Pay for payslips. As a manager, the account can approve the pending requests from the Absence and Expenses tabs.
>
> Location: only requested when an employer requires employees to be at a work location to clock in, and only at that moment. It is off in the demo workspace.
>
> Account deletion: Profile → Delete account.

## Lessons from WeldFlow's rejection (April 2026)

App Review rejected WeldFlow 1.0 for three things; WeldHR is set up to avoid each:

- **5.1.1(v) account deletion**: reviewers signed up and landed on "Create your workspace" with no way to delete the account. WeldHR has Delete account there and in Profile.
- **2.1(a) bug**: "Go to weldsuite.com" opened a server test page (weldsuite.com is not the website). WeldHR links to https://app.weldsuite.org. Check the link still works before submitting.
- **2.1(b) business model**: Apple asked how paid features work. Answer up front in the review notes (below) so the review does not stall. Reviews happen on an **iPad** as well (`supportsTablet: true`), so test the no-workspace and sign-in screens there.

### Business model answers (check the facts before pasting)

> 1. Users: employees and managers of companies that use WeldSuite. The company is the customer; employees never pay.
> 2. Purchases: the company subscribes to WeldSuite on the web (app.weldsuite.org), billed per workspace. Nothing can be bought in the app, and the app does not link to or mention pricing.
> 3. Previously purchased features: the HR module of the company's workspace (leave, shifts, expenses, payslips), available to the employees the company gives access to.
> 4. None. The app unlocks no paid content; it is a client for the employer's workspace (guideline 3.1.3(c), enterprise services sold to organisations).
> 5. Accounts are created by the employer's invitation, or by signing up for free. Creating an account costs nothing.

## Play Console → App content → App access

- "All or some functionality is restricted": **Yes**
- Instructions: username `googleverification@weldsuite.org`, its password from WeldPass, and the same notes as above
