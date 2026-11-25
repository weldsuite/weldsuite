const { withAppBuildGradle, withGradleProperties } = require('@expo/config-plugins');

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

    contents = contents.replace(/android\s*\{/, (match) => `${match}\n${packagingBlock}`);

    config.modResults.contents = contents;
    return config;
  });
};

/** The scaffold's placeholder in app.json, until `eas init` writes the real id. */
const PLACEHOLDER_PROJECT_ID = '00000000-0000-0000-0000-000000000000';

/**
 * The EAS project id. WeldPass ships no EAS Update (no `updates.url`, no
 * expo-updates): it is the first app without Expo's US-hosted services
 * (weldsuite-documentation/plans/weldpass-eu.md, phase 4), so every release
 * is a store build. EAS is used for builds and credentials only.
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
      'WeldPass has no EAS project yet. Run `pnpm --filter weldpass-app exec eas init` ' +
      '(or set EAS_PROJECT_ID) before building.';
    if (isRelease) throw new Error(message);
    console.warn(`[weldpass-app] ${message}`);
    return config;
  }

  return {
    ...config,
    extra: { ...config.extra, eas: { ...config.extra?.eas, projectId } },
  };
};

const appConfig = ({ config }) => {
  config = withIncreasedGradleMemory(config);
  config = withAndroidPackagingExcludes(config);
  config = withEasProject(config);

  return config;
};

module.exports = appConfig;
