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
      'WeldBooks has no EAS project yet. Run `pnpm --filter weldbooks-app exec eas init` ' +
      '(or set EAS_PROJECT_ID) before building or publishing updates.';
    if (isRelease) throw new Error(message);
    console.warn(`[weldbooks-app] ${message}`);
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

module.exports = ({ config }) => withProductionCleartext(withEasProject(config));
