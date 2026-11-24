# WeldPass, notes for App Review and Play review

## Notes (paste into App Review Information → Notes)

WeldPass is the password manager of WeldSuite, a business platform. Sign-in
happens on WeldSuite's own sign-in page (WeldID), opened in the system browser
sheet; there is no account creation inside the app beyond that page.

To review:

1. Tap "Sign in" and sign in with the demo account below.
2. The Items tab lists the demo workspace's logins, notes and cards. Open
   "GitHub (demo)": tap the eye next to the password. The app asks for Face ID
   or the device passcode first, then shows it.
3. Copy the password: it is removed from the clipboard after 30 seconds.
4. The two-factor code under the login counts down and changes every 30 seconds.
5. Generator tab: generate a password and see its strength.
6. Settings → Password health lists weak and reused passwords in the demo data.

The app is always locked with Face ID / Touch ID or the passcode while signed
in. On a simulator without enrolled biometrics, use Features → Face ID →
Enrolled, then Matching Face.

## Demo account

A WeldID account on WeldSuite EU (`app.weldsuite.eu`) in a demo workspace with
WeldPass, a personal vault and one shared vault ("Marketing (demo)") with a
few logins, one with a 2FA secret, one with a weak password and two sharing a
password, a secure note and a card.

- Email: (fill in before submitting; keep the password out of this repo)
- Password: (in the team's password manager, not here)

## Play Console → App access

"All or some functionality is restricted": yes. Instructions: as above, with
the same demo account.
