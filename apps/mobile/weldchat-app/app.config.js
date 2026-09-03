const fs = require('fs');
const path = require('path');
const { withAndroidManifest } = require('@expo/config-plugins');

const PROJECT_ROOT = __dirname;

/**
 * Attach Firebase / FCM config files when present.
 *
 * Android push needs `google-services.json` for package `com.weldsuite.weldchat`
 * (create the Android app in the shared Firebase project `weldsuite`, then drop
 * the downloaded file here). iOS needs `GoogleService-Info.plist` the same way.
 * Do NOT copy other WeldSuite app Firebase files — wrong package / bundle id.
 */
const withFirebaseConfigFiles = (config) => {
  const androidFile = path.join(PROJECT_ROOT, 'google-services.json');
  const iosFile = path.join(PROJECT_ROOT, 'GoogleService-Info.plist');

  if (fs.existsSync(androidFile)) {
    config.android = {
      ...config.android,
      googleServicesFile: './google-services.json',
    };
  } else {
    console.warn(
      '[weldchat-app] Missing google-services.json — Android Expo push tokens ' +
        'will fail until you add a Firebase Android app for com.weldsuite.weldchat ' +
        'and upload the FCM V1 key via `eas credentials`. See store/README.md.',
    );
  }

  if (fs.existsSync(iosFile)) {
    config.ios = {
      ...config.ios,
      googleServicesFile: './GoogleService-Info.plist',
    };
  }

  return config;
};

// Strip the FOREGROUND_SERVICE_MEDIA_PROJECTION permission. The RealtimeKit /
// WebRTC native SDK injects it (for screen-share), but the WeldChat mobile app
// has NO screen-share feature — declaring it triggers a Google Play
// foreground-service review for a capability the app doesn't ship. We remove it
// via the manifest merger so it never reaches the final APK/AAB. The mic + camera
// FGS types remain (used by live voice/video calls).
const withMediaProjectionPermissionRemoved = (config) => {
  return withAndroidManifest(config, async (config) => {
    const manifest = config.modResults.manifest;

    if (!manifest.$['xmlns:tools']) {
      manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools';
    }

    const PERM = 'android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION';
    manifest['uses-permission'] = manifest['uses-permission'] || [];
    // Drop any existing (allowed) declaration...
    manifest['uses-permission'] = manifest['uses-permission'].filter(
      (p) => p?.$?.['android:name'] !== PERM,
    );
    // ...and add an explicit tools:node="remove" so a library-merged copy is stripped too.
    manifest['uses-permission'].push({
      $: { 'android:name': PERM, 'tools:node': 'remove' },
    });

    return config;
  });
};

// Strip the SYSTEM_ALERT_WINDOW (draw-over-other-apps) permission. A native
// dependency (WebRTC / RealtimeKit) injects it, but WeldChat draws no overlays
// — the incoming-call UI is a plain React Native <Modal>, and background calls
// arrive via push notifications. SYSTEM_ALERT_WINDOW is the permission class
// used for overlay-phishing, so we remove it from the release manifest. (The
// debug variant keeps it; React Native's dev menu overlay needs it.)
const withSystemAlertWindowRemoved = (config) => {
  return withAndroidManifest(config, async (config) => {
    const manifest = config.modResults.manifest;

    if (!manifest.$['xmlns:tools']) {
      manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools';
    }

    const PERM = 'android.permission.SYSTEM_ALERT_WINDOW';
    manifest['uses-permission'] = manifest['uses-permission'] || [];
    manifest['uses-permission'] = manifest['uses-permission'].filter(
      (p) => p?.$?.['android:name'] !== PERM,
    );
    manifest['uses-permission'].push({
      $: { 'android:name': PERM, 'tools:node': 'remove' },
    });

    return config;
  });
};

/** Ensure USE_FULL_SCREEN_INTENT is declared for heads-up incoming-call notifications. */
const withFullScreenIntent = (config) => {
  return withAndroidManifest(config, async (config) => {
    const manifest = config.modResults.manifest;
    const PERM = 'android.permission.USE_FULL_SCREEN_INTENT';
    manifest['uses-permission'] = manifest['uses-permission'] || [];
    const exists = manifest['uses-permission'].some(
      (p) => p?.$?.['android:name'] === PERM && !p?.$?.['tools:node'],
    );
    if (!exists) {
      manifest['uses-permission'].push({
        $: { 'android:name': PERM },
      });
    }
    return config;
  });
};

module.exports = ({ config }) => {
  config = withFirebaseConfigFiles(config);
  config = withMediaProjectionPermissionRemoved(config);
  config = withSystemAlertWindowRemoved(config);
  config = withFullScreenIntent(config);
  return config;
};
