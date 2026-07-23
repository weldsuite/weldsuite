const { withAndroidManifest, withAppBuildGradle } = require('@expo/config-plugins');

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

// Config plugin to add react-native-app-auth intent filter
const withAndroidManifestFixes = (config) => {
  return withAndroidManifest(config, async (config) => {
    const manifest = config.modResults.manifest;

    if (!manifest.$['xmlns:tools']) {
      manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools';
    }

    const application = manifest.application?.[0];
    if (!application) {
      return config;
    }

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
                'android:scheme': '{{APP_CODE}}',
              },
            },
          ],
        },
      ],
    };

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

module.exports = ({ config }) => {
  config = withAndroidManifestFixes(config);
  config = withAndroidPackagingExcludes(config);

  return config;
};
