const { withInfoPlist } = require('@expo/config-plugins');
const { withAppBuildGradle } = require('@expo/config-plugins');

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
    const isRelease = process.env.EAS_BUILD === 'true' || process.env.CI === 'true';
    const message =
      'WeldAgent has no EAS project yet. Run `pnpm --filter weldagent-app exec eas init` ' +
      '(or set EAS_PROJECT_ID) before building or publishing updates.';
    if (isRelease) throw new Error(message);
    console.warn(`[weldagent-app] ${message}`);
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

/** Store builds must not allow plaintext HTTP. Dev/preview keep it for local app-api. */
const withProductionCleartext = (config) => {
  if (process.env.EAS_BUILD_PROFILE !== 'production') return config;

  const plugins = (config.plugins || []).map((plugin) => {
    if (!Array.isArray(plugin) || plugin[0] !== 'expo-build-properties') return plugin;
    return [
      'expo-build-properties',
      {
        ...plugin[1],
        android: {
          ...plugin[1]?.android,
          usesCleartextTraffic: false,
        },
      },
    ];
  });

  return { ...config, plugins };
};

/** iOS URL scheme for the Google Sign-In callback — same as WeldBooks. */
const withGoogleSignInUrlScheme = (config) => {
  const iosUrlScheme = process.env.EXPO_PUBLIC_CLERK_GOOGLE_IOS_URL_SCHEME;
  if (!iosUrlScheme) return config;

  return withInfoPlist(config, (config) => {
    const existing = config.modResults.CFBundleURLTypes || [];
    const alreadyAdded = existing.some((entry) =>
      entry.CFBundleURLSchemes?.includes(iosUrlScheme),
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

/** @clerk/expo reads these from extra; env-only injection is unreliable with app.config.js. */
const withClerkGoogleExtra = (config) => {
  config.extra = {
    ...config.extra,
    EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID: process.env.EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID,
    EXPO_PUBLIC_CLERK_GOOGLE_IOS_CLIENT_ID: process.env.EXPO_PUBLIC_CLERK_GOOGLE_IOS_CLIENT_ID,
    EXPO_PUBLIC_CLERK_GOOGLE_ANDROID_CLIENT_ID: process.env.EXPO_PUBLIC_CLERK_GOOGLE_ANDROID_CLIENT_ID,
  };
  return config;
};

// Exclude duplicate META-INF resources that cause mergeReleaseJavaResource to fail.
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
      (match) => `${match}\n${packagingBlock}`,
    );

    config.modResults.contents = contents;
    return config;
  });
};

module.exports = ({ config }) =>
  withAndroidPackagingExcludes(
    withGoogleSignInUrlScheme(withClerkGoogleExtra(withProductionCleartext(withEasProject(config)))),
  );
