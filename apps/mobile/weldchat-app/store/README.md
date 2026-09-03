# WeldChat — App Store / Play Store + push setup

## Done in-repo

- [x] EAS project id `04074d63-4e69-4cf0-b8a6-f695f7a3dfad`
- [x] `updates.url` synced to `https://u.expo.dev/04074d63-4e69-4cf0-b8a6-f695f7a3dfad`
- [x] Production `eas.json` env: `EXPO_PUBLIC_APP_API_URL`, `EXPO_PUBLIC_REALTIME_URL`, Clerk live key
- [x] Android notification channels `chat` + `incoming_call` (client + orchestrator)
- [x] `expo-notifications` plugin
- [x] iOS `UIBackgroundModes`: `remote-notification`, `audio`
- [x] Android `USE_FULL_SCREEN_INTENT` for heads-up incoming-call notifications
- [x] `app.config.js` auto-attaches Firebase files when you drop them in

**Closed-app calls = tap-to-answer Expo push** (not CallKit / ConnectionService). Incoming ring push is sent for **DM** calls only.

## Credentials status (EAS `@weldsuite/weldchat-app`)

- [x] Firebase client files in app dir (`google-services.json`, `GoogleService-Info.plist` for `com.weldsuite.weldchat`)
- [x] Android **FCM V1** — Google service account `firebase-adminsdk-fbsvc@weldsuite.iam.gserviceaccount.com` assigned on EAS
- [x] iOS **APNs** push key `L3MNADNB6H` (team WeldReach B.V.) assigned on EAS

`app.config.js` attaches the Firebase client files on prebuild / EAS build.

### First device build (required for push)

Expo Go cannot register push tokens on SDK 53+. Use a dev client or preview build:

```bash
eas build --profile preview --platform ios
eas build --profile preview --platform android
```

On device: sign in → Settings → enable notifications → **kill the app** → place a DM
voice/video call from the web platform → expect a high-priority Expo push → tap opens
`/call-room?callId=…` and joins the RealtimeKit room.

## Build / submit

```bash
eas build --profile production --platform all
eas submit --profile production --platform ios
eas submit --profile production --platform android
```

## Pre-submission checklist

- [ ] `npx expo-doctor` passes
- [ ] Golden path: login → channels / DMs → send message
- [ ] Foreground: incoming DM call shows Accept/Decline modal + ringtone
- [ ] Killed app: DM call push arrives; tap joins call
- [ ] Caller cancels while ringing → callee notification dismissed
- [ ] Missed / declined call → missed-call notification opens the DM
- [ ] Deep link `weldchat://` resolves
- [ ] Privacy policy URL `https://weldsuite.org/privacy`
