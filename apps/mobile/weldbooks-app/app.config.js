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

module.exports = ({ config }) => {
  // Apply the Android manifest fixes plugin
  config = withAndroidManifestFixes(config);

  return config;
};
