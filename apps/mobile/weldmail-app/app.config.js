const { withInfoPlist, withAppBuildGradle } = require('@expo/config-plugins');

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

// Exclude duplicate META-INF resources that break mergeReleaseJavaResource on Android.
const withAndroidPackagingExcludes = (config) => {
  return withAppBuildGradle(config, (config) => {
    if (config.modResults.language !== 'groovy') {
      return config;
    }

    let contents = config.modResults.contents;

    if (contents.includes('META-INF/versions/9/OSGI-INF/MANIFEST.MF')) {
      return config;
    }

    const packagingBlock = `    packaging {\n        resources {\n            excludes += [\n                'META-INF/versions/9/OSGI-INF/MANIFEST.MF',\n                'META-INF/versions/9/OSGI-INF/**',\n            ]\n        }\n    }\n`;

    contents = contents.replace(/android\s*\{/, (match) => `${match}\n${packagingBlock}`);

    config.modResults.contents = contents;
    return config;
  });
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
  config = withCleartextPolicy(config);
  config = withAndroidPackagingExcludes(config);
  return config;
};
