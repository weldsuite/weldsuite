const fs = require('fs');
const path = require('path');
const { withAppBuildGradle } = require('@expo/config-plugins');

const androidGoogleServicesFile = path.join(__dirname, 'google-services.json');
const iosGoogleServicesFile = path.join(__dirname, 'GoogleService-Info.plist');

// Android push needs FCM, which needs the Firebase config for
// `com.weldsuite.welddesk` (Firebase project `weldsuite`, same as the sibling
// apps). A store build without it installs fine but never gets a push token,
// so fail the production build instead of shipping that silently.
const withGoogleServices = (config) => {
  if (fs.existsSync(iosGoogleServicesFile)) {
    config.ios = { ...config.ios, googleServicesFile: './GoogleService-Info.plist' };
  }
  if (fs.existsSync(androidGoogleServicesFile)) {
    config.android = { ...config.android, googleServicesFile: './google-services.json' };
    return config;
  }
  if (process.env.EAS_BUILD_PROFILE === 'production') {
    throw new Error(
      'google-services.json is missing: register com.weldsuite.welddesk in the `weldsuite` Firebase project and commit the file to apps/mobile/welddesk-app/.',
    );
  }
  return config;
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

// Config plugin to exclude duplicate META-INF resources that cause
// `mergeReleaseJavaResource` to fail when multiple jars (e.g. okhttp3
// logging-interceptor + jspecify) ship the same OSGI-INF manifest.
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

    contents = contents.replace(
      /android\s*\{/,
      (match) => `${match}\n${packagingBlock}`
    );

    config.modResults.contents = contents;
    return config;
  });
};

module.exports = ({ config }) => {
  config = withGoogleServices(config);
  config = withCleartextPolicy(config);
  config = withAndroidPackagingExcludes(config);

  return config;
};
