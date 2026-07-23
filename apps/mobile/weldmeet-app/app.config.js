const { withAndroidManifest, withAppBuildGradle, withStringsXml, AndroidConfig } = require('@expo/config-plugins');

// Config plugin to add `blob_provider_authority` to strings.xml. Required by
// @cloudflare/realtimekit-react-native — its AndroidManifest registers a
// BlobProvider with `android:authorities="@string/blob_provider_authority"`,
// and AAPT fails the build if that string isn't defined. The authority must
// be unique across all apps installed on the device, so we suffix the app's
// applicationId.
const withBlobProviderAuthority = (config) => {
  return withStringsXml(config, (config) => {
    const pkg = config.android?.package ?? 'com.weldsuite.weldmeet';
    config.modResults = AndroidConfig.Strings.setStringItem(
      [
        {
          $: { name: 'blob_provider_authority', translatable: 'false' },
          _: `${pkg}.blobs`,
        },
      ],
      config.modResults,
    );
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
                'android:scheme': 'weldmeet',
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
  config = withBlobProviderAuthority(config);

  return config;
};
