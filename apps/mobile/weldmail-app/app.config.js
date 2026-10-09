const {
  withInfoPlist,
  withAppBuildGradle,
  withGradleProperties,
} = require('@expo/config-plugins');
const { Buffer } = require('node:buffer');

// Match weldflow/weldchat. Fresh prebuild defaults to 2 GiB heap / 512 MiB
// Metaspace, which OOMs mid-lintVital on GitHub runners
// (`:react-native-keyboard-controller:lintVitalAnalyzeRelease FAILED`).
const GRADLE_JVMARGS =
  '-Xmx4096m -XX:MaxMetaspaceSize=1024m -XX:+HeapDumpOnOutOfMemoryError -Dfile.encoding=UTF-8';

const withIncreasedGradleMemory = (config) => {
  return withGradleProperties(config, (config) => {
    const items = config.modResults;
    const existing = items.find(
      (item) => item.type === 'property' && item.key === 'org.gradle.jvmargs',
    );
    if (existing) {
      existing.value = GRADLE_JVMARGS;
    } else {
      items.push({ type: 'property', key: 'org.gradle.jvmargs', value: GRADLE_JVMARGS });
    }
    return config;
  });
};

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

// Passkeys: iOS only offers the app passkeys for a domain listed under
// `webcredentials:`. Clerk serves the apple-app-site-association file on its
// Frontend API host (Clerk Dashboard → Native applications), which differs per
// instance, so read it from this build's publishable key. Android needs no
// manifest entry: Credential Manager checks the assetlinks.json on that host.
const clerkFrontendApiHost = () => {
  const encoded = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY?.split('_')[2];
  if (!encoded) return null;
  return Buffer.from(encoded, 'base64').toString('utf8').replace(/\$$/, '') || null;
};

const withPasskeyDomain = (config) => {
  const host = clerkFrontendApiHost();
  if (!host) return config;
  const entry = `webcredentials:${host}`;
  const domains = config.ios?.associatedDomains ?? [];
  if (domains.includes(entry)) return config;
  config.ios = { ...config.ios, associatedDomains: [...domains, entry] };
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

const appConfig = ({ config }) => {
  // Explicitly pass EXPO_PUBLIC_CLERK_* env vars into extra so @clerk/expo can find them
  // via Constants.expoConfig.extra (auto-injection can be unreliable with custom app.config.js)
  config.extra = {
    ...config.extra,
    EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID: process.env.EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID,
    EXPO_PUBLIC_CLERK_GOOGLE_IOS_CLIENT_ID: process.env.EXPO_PUBLIC_CLERK_GOOGLE_IOS_CLIENT_ID,
    EXPO_PUBLIC_CLERK_GOOGLE_ANDROID_CLIENT_ID: process.env.EXPO_PUBLIC_CLERK_GOOGLE_ANDROID_CLIENT_ID,
  };

  config = withIncreasedGradleMemory(config);
  config = withGoogleSignInUrlScheme(config);
  config = withPasskeyDomain(config);
  config = withCleartextPolicy(config);
  config = withAndroidPackagingExcludes(config);
  return config;
};

module.exports = appConfig;
