/**
 * WeldPass's AutoFill credential provider (ADR PASS-010), an iOS app
 * extension added by @bacons/apple-targets at prebuild.
 *
 * It shares two things with the app, both named here and in app.json's
 * `ios.entitlements`: the App Group whose container holds the offline copy,
 * and the Keychain group holding the copy's key.
 *
 * @type {import('@bacons/apple-targets/app.plugin').Config}
 */
module.exports = {
  type: 'credentials-provider',
  name: 'WeldPassAutofill',
  displayName: 'WeldPass',
  // com.weldsuite.weldpass.autofill
  bundleIdentifier: '.autofill',
  deploymentTarget: '17.0',
  frameworks: ['AuthenticationServices', 'CryptoKit', 'LocalAuthentication', 'Security'],
  entitlements: {
    'com.apple.developer.authentication-services.autofill-credential-provider': true,
    'com.apple.security.application-groups': ['group.com.weldsuite.weldpass'],
    'keychain-access-groups': ['$(AppIdentifierPrefix)com.weldsuite.weldpass.shared'],
  },
};
