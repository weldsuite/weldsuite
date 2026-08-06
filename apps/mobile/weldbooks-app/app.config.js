const { withAndroidManifest } = require('@expo/config-plugins');

// Config plugin to add react-native-app-auth intent filter
const withAndroidManifestFixes = (config) => {
  return withAndroidManifest(config, async (config) => {
    const manifest = config.modResults.manifest;

    // Add tools namespace if not present
    if (!manifest.$['xmlns:tools']) {
      manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools';
    }

    // Find the main application
    const application = manifest.application?.[0];
    if (!application) {
      return config;
    }

    // Add the RedirectUriReceiverActivity for OAuth callbacks
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
          data: [
            {
              $: {
                'android:scheme': 'weldbooks',
              },
            },
          ],
        },
      ],
    };

    // Check if the activity already exists
    const activities = application.activity || [];
    const existingActivity = activities.find(
      (a) => a.$?.['android:name'] === 'net.openid.appauth.RedirectUriReceiverActivity'
    );

    if (!existingActivity) {
      application.activity = [...activities, redirectActivity];
    }

    return config;
  });
};

/** Set by app.json until `eas init` replaces it with the real project id. */
const PLACEHOLDER_PROJECT_ID = 'PLACEHOLDER_WELDBOOKS_EAS_PROJECT_ID';

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
    updates: { ...config.updates, url: `https://u.expo.dev/${projectId}` },
  };
};

module.exports = ({ config }) => {
  // Apply the Android manifest fixes plugin
  config = withAndroidManifestFixes(config);
  config = withEasProject(config);

  return config;
};
