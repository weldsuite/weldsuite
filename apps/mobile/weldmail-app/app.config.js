const { withAndroidManifest, withInfoPlist } = require('@expo/config-plugins');

// Add iOS URL scheme for Google Sign-In callback
const withGoogleSignInUrlScheme = (config) => {
  const iosUrlScheme = process.env.EXPO_PUBLIC_CLERK_GOOGLE_IOS_URL_SCHEME;
  if (!iosUrlScheme) return config;

  return withInfoPlist(config, (config) => {
    const existing = config.modResults.CFBundleURLTypes || [];
    const alreadyAdded = existing.some((entry) =>
      entry.CFBundleURLSchemes?.includes(iosUrlScheme)
    );

    if (!alreadyAdded) {
      config.modResults.CFBundleURLTypes = [
        ...existing,
        {
          CFBundleURLSchemes: [iosUrlScheme],
        },
      ];
    }

    return config;
  });
};

// Add Android intent filter for OAuth callbacks
const withAndroidManifestFixes = (config) => {
  return withAndroidManifest(config, async (config) => {
    const manifest = config.modResults.manifest;

    if (!manifest.$['xmlns:tools']) {
      manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools';
    }

    const application = manifest.application?.[0];
    if (!application) return config;

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
          data: [{ $: { 'android:scheme': 'weldmail' } }],
        },
      ],
    };

    const activities = application.activity || [];
    const exists = activities.find(
      (a) => a.$?.['android:name'] === 'net.openid.appauth.RedirectUriReceiverActivity'
    );

    if (!exists) {
      application.activity = [...activities, redirectActivity];
    }

    return config;
  });
};

// Disable Android cleartext (HTTP) traffic for packaged builds. Only local dev
// (no EAS profile) and the dev-client `development` profile need cleartext — to
// reach the local http app-api / Metro bundler. `preview` and `production`
// always talk to https endpoints, so cleartext must be off there.
const withCleartextPolicy = (config) => {
  const profile = process.env.EAS_BUILD_PROFILE;
  const allowCleartext = !profile || profile === 'development';
  if (allowCleartext) return config;
  for (const entry of config.plugins || []) {
    if (Array.isArray(entry) && entry[0] === 'expo-build-properties' && entry[1]?.android) {
      entry[1].android.usesCleartextTraffic = false;
    }
  }
  return config;
};

module.exports = ({ config }) => {
  // Explicitly pass EXPO_PUBLIC_CLERK_* env vars into extra so @clerk/expo can find them
  // via Constants.expoConfig.extra (auto-injection can be unreliable with custom app.config.js)
  config.extra = {
    ...config.extra,
    EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID: process.env.EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID,
    EXPO_PUBLIC_CLERK_GOOGLE_IOS_CLIENT_ID: process.env.EXPO_PUBLIC_CLERK_GOOGLE_IOS_CLIENT_ID,
    EXPO_PUBLIC_CLERK_GOOGLE_ANDROID_CLIENT_ID: process.env.EXPO_PUBLIC_CLERK_GOOGLE_ANDROID_CLIENT_ID,
  };

  config = withGoogleSignInUrlScheme(config);
  config = withAndroidManifestFixes(config);
  config = withCleartextPolicy(config);
  return config;
};
