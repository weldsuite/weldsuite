const { withAppBuildGradle } = require('@expo/config-plugins');

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
      'WeldSocial has no EAS project yet. Run `pnpm --filter weldsocial-app exec eas init` ' +
      '(or set EAS_PROJECT_ID) before building or publishing updates.';
    if (isRelease) throw new Error(message);
    console.warn(`[weldsocial-app] ${message}`);
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

module.exports = ({ config }) => {
  config = withAndroidPackagingExcludes(config);
  config = withEasProject(config);

  return config;
};
