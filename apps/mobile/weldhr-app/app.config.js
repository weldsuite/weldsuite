const fs = require('node:fs');
const path = require('node:path');
const {
  withAppBuildGradle,
  withGradleProperties,
  withAndroidManifest,
} = require('@expo/config-plugins');

const PROJECT_ROOT = __dirname;

// Match weldflow/weldchat. Fresh prebuild defaults OOM mid-lintVital on GHA.
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

/**
 * Android push needs `google-services.json` for package `com.weldsuite.weldhr`
 * (Firebase project `weldsuite`). Without it, `expo-notifications` still merges
 * `ExpoFirebaseMessagingService`, and FCM token refresh on first launch can kill
 * the process with "Default FirebaseApp is not initialized".
 *
 * When the file is present → wire googleServicesFile.
 * When missing → strip the FCM service so the app can open (push stays disabled).
 * Same as weldflow-app; see store/README.md for where the file comes from.
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
      '[weldhr-app] Missing google-services.json for com.weldsuite.weldhr — ' +
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

/** Must match the scaffold placeholder in app.json before `eas init` runs. */
const PLACEHOLDER_PROJECT_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Resolves the EAS project id and keeps `updates.url` derived from it.
 *
 * The two have to agree — a mismatched pair produces an app that builds fine
 * and then silently never receives an OTA update. Deriving the URL here makes
 * that impossible, and building for release with the placeholder still in place
 * now fails loudly instead of shipping a broken updates endpoint.
 *
 * `EAS_PROJECT_ID` in the environment wins, so CI can inject it without
 * touching the committed config.
 */
const withEasProject = (config) => {
  const projectId =
    process.env.EAS_PROJECT_ID || config.extra?.eas?.projectId || PLACEHOLDER_PROJECT_ID;

  if (projectId === PLACEHOLDER_PROJECT_ID) {
    // `expo start` and prebuild stay usable so local development isn't blocked;
    // only a real build/submit needs a provisioned project.
    const isRelease = process.env.EAS_BUILD === 'true' || process.env.CI === 'true';
    const message =
      'WeldHR has no EAS project yet. Run `pnpm --filter weldhr-app exec eas init` ' +
      '(or set EAS_PROJECT_ID) before building or publishing updates.';
    if (isRelease) throw new Error(message);
    console.warn(`[weldhr-app] ${message}`);
    return config;
  }

  return {
    ...config,
    extra: { ...config.extra, eas: { ...config.extra?.eas, projectId } },
    updates: {
      ...config.updates,
      url: `https://u.expo.dev/${projectId}`,
      checkAutomatically: 'ON_LOAD',
      fallbackToCacheTimeout: 0,
    },
  };
};

const appConfig = ({ config }) => {
  config = withIncreasedGradleMemory(config);
  config = withAndroidPackagingExcludes(config);
  config = withFirebaseOrSafePush(config);
  config = withEasProject(config);

  return config;
};

module.exports = appConfig;
