# WeldHR, Review Notes and Demo Account

Reviewers can't see anything without a workspace that has WeldHR and an employee
record linked to the account. A plain sign-up lands on the no-workspace screen,
which reviewers reject as "app does not work". So both stores need a ready demo login.

## Demo workspace (production)

Create once, in **production** (`app.weldsuite.org`), and keep it alive:

1. Workspace **WeldHR Demo** with WeldHR installed (and payroll on, so the Pay screen shows)
2. Account `appreview@weldsuite.org` with email + password sign-in (no SSO, no 2FA, no email code):
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

- Sign-in required: **Yes**, username `appreview@weldsuite.org`, password from WeldPass
- Notes:

> WeldHR is the employee app for companies that use WeldSuite HR. Accounts are created by the employer; the demo account above belongs to a demo company with sample data.
>
> To try: Home → Clock in. Absence → + → request leave. Expenses → + → new claim, attach a receipt photo. Profile (tap the workspace at the top of Home) → Pay for payslips. As a manager, the account can approve the pending requests from the Absence and Expenses tabs.
>
> Location: only requested when an employer requires employees to be at a work location to clock in, and only at that moment. It is off in the demo workspace.
>
> Account deletion: Profile → Delete account.

## Play Console → App content → App access

- "All or some functionality is restricted": **Yes**
- Instructions: same username, password and notes as above
