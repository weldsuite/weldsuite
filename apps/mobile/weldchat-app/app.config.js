const { withAndroidManifest } = require('@expo/config-plugins');

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

// Config plugin to add react-native-app-auth intent filter
const withAndroidManifestFixes = (config) => {
  return withAndroidManifest(config, async (config) => {
    const manifest = config.modResults.manifest;

    // Add tools namespace if not present
    if (!manifest.$['xmlns:tools']) {
      manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools';
    }

    // Find the main application
    const application = manifest.application?.[0];
    if (!application) {
      return config;
    }

    // Add the RedirectUriReceiverActivity for OAuth callbacks
    const redirectActivity = {
      $: {
        'android:name': 'net.openid.appauth.RedirectUriReceiverActivity',
        'android:exported': 'true',
      },
      'intent-filter': [
        {
          action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }],
          category: [
            { $: { 'android:name': 'android.intent.category.DEFAULT' } },
            { $: { 'android:name': 'android.intent.category.BROWSABLE' } },
          ],
          data: [
            {
              $: {
                'android:scheme': 'weldchat',
              },
            },
          ],
        },
      ],
    };

    // Check if the activity already exists
    const activities = application.activity || [];
    const existingActivity = activities.find(
      (a) => a.$?.['android:name'] === 'net.openid.appauth.RedirectUriReceiverActivity'
    );

    if (!existingActivity) {
      application.activity = [...activities, redirectActivity];
    }

    return config;
  });
};

module.exports = ({ config }) => {
  // Apply the Android manifest fixes plugin
  config = withAndroidManifestFixes(config);
  // Strip the unused FOREGROUND_SERVICE_MEDIA_PROJECTION permission
  config = withMediaProjectionPermissionRemoved(config);
  // Strip the unused SYSTEM_ALERT_WINDOW (draw-over-other-apps) permission
  config = withSystemAlertWindowRemoved(config);

  return config;
};
