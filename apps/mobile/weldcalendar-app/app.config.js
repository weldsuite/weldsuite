const fs = require('fs');
const path = require('path');
const {
  withAppBuildGradle,
  withGradleProperties,
  withAndroidManifest,
} = require('@expo/config-plugins');

const PROJECT_ROOT = __dirname;

// Match weldchat's committed android/gradle.properties. Fresh prebuild defaults to
// 2 GiB heap / 512 MiB Metaspace, which OOMs mid-lintVital on GitHub runners
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

const withAndroidPackagingExcludes = (config) => {
  return withAppBuildGradle(config, (config) => {
    if (config.modResults.language !== 'groovy') return config;

    let contents = config.modResults.contents;
    if (contents.includes('META-INF/versions/9/OSGI-INF/MANIFEST.MF')) return config;

    const packagingBlock = `    packaging {\n        resources {\n            excludes += [\n                'META-INF/versions/9/OSGI-INF/MANIFEST.MF',\n                'META-INF/versions/9/OSGI-INF/**',\n            ]\n        }\n    }\n`;

    contents = contents.replace(/android\s*\{/, (match) => `${match}\n${packagingBlock}`);
    config.modResults.contents = contents;
    return config;
  });
};

/**
 * Android push needs `google-services.json` for package `com.weldsuite.weldcalendar`
 * (Firebase project `weldsuite`). Without it, `expo-notifications` still merges
 * `ExpoFirebaseMessagingService`, and FCM token refresh on first launch can kill
 * the process with "Default FirebaseApp is not initialized".
 *
 * When the file is present → wire googleServicesFile.
 * When missing → strip the FCM service so the app can open (push stays disabled).
 */
const withFirebaseOrSafePush = (config) => {
  const androidFile = path.join(PROJECT_ROOT, 'google-services.json');
  const iosFile = path.join(PROJECT_ROOT, 'GoogleService-Info.plist');

  if (fs.existsSync(androidFile)) {
    config.android = {
      ...config.android,
      googleServicesFile: './google-services.json',
    };
  } else {
    console.warn(
      '[weldcalendar-app] Missing google-services.json for com.weldsuite.weldcalendar — ' +
        'stripping ExpoFirebaseMessagingService so release builds do not crash on open. ' +
        'Add the Firebase Android app file, then rebuild.',
    );
    config = withAndroidManifest(config, (config) => {
      const manifest = config.modResults.manifest;
      if (!manifest.$['xmlns:tools']) {
        manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools';
      }
      const application = manifest.application?.[0];
      if (!application) return config;

      application.service = application.service || [];
      const serviceName = 'expo.modules.notifications.service.ExpoFirebaseMessagingService';
      application.service = application.service.filter(
        (s) => s?.$?.['android:name'] !== serviceName,
      );
      application.service.push({
        $: { 'android:name': serviceName, 'tools:node': 'remove' },
      });
      return config;
    });
  }

  if (fs.existsSync(iosFile)) {
    config.ios = {
      ...config.ios,
      googleServicesFile: './GoogleService-Info.plist',
    };
  }

  return config;
};

module.exports = ({ config }) => {
  config = withIncreasedGradleMemory(config);
  config = withAndroidPackagingExcludes(config);
  config = withFirebaseOrSafePush(config);
  return config;
};
