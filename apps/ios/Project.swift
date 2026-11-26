import ProjectDescription

/// The native iOS apps (plan `weldsuite-documentation/plans/native-mobile-apps.md`).
/// `tuist generate` writes `WeldSuite.xcodeproj` from this file; the project
/// itself isn't committed. Shared code is the local package `WeldKit`.

/// The server a configuration starts on: the EU test cluster while
/// developing, WeldSuite EU in release builds.
private func appSettings(base: SettingsDictionary) -> Settings {
    .settings(
        base: base.merging([
            "SWIFT_VERSION": "5.0",
            "ASSETCATALOG_COMPILER_APPICON_NAME": "AppIcon",
        ]) { _, new in new },
        configurations: [
            .debug(name: "Debug", settings: ["WELD_EU_SERVER_URL": "https://app.test.weldsuite.eu"]),
            .release(name: "Release", settings: ["WELD_EU_SERVER_URL": "https://app.weldsuite.eu"]),
        ]
    )
}

/// WeldPass's version, the same in the app and its extension: above the
/// React Native app's 1.x, which this replaces in the App Store. The "Mobile
/// native release" workflow passes a higher build number on the command line
/// (`CURRENT_PROJECT_VERSION=`), which reaches both targets.
private let weldPassVersionSettings: SettingsDictionary = [
    "MARKETING_VERSION": "2.0.0",
    "CURRENT_PROJECT_VERSION": "200",
]

private let weldPassVersion: [String: Plist.Value] = [
    "CFBundleShortVersionString": "$(MARKETING_VERSION)",
    "CFBundleVersion": "$(CURRENT_PROJECT_VERSION)",
]

/// The app and its AutoFill extension have the same entitlements. The offline
/// copy (ADR PASS-010) is shared between them: its files through the App
/// Group container, its key through a Keychain group. App Store Connect
/// refuses the upload (error 90729) unless the app, and not only the
/// extension, has the AutoFill provider entitlement; the app needs it anyway
/// to keep QuickType's suggestions (`ASCredentialIdentityStore`) in step.
private let weldPassEntitlements: [String: Plist.Value] = [
    "com.apple.security.application-groups": ["group.com.weldsuite.weldpass"],
    "keychain-access-groups": ["$(AppIdentifierPrefix)com.weldsuite.weldpass.shared"],
    "com.apple.developer.authentication-services.autofill-credential-provider": true,
]

let weldPass: Target = .target(
    name: "WeldPass",
    destinations: [.iPhone, .iPad],
    product: .app,
    bundleId: "com.weldsuite.weldpass",
    deploymentTargets: .iOS("17.0"),
    infoPlist: .extendingDefault(with: weldPassVersion.merging([
        "CFBundleDisplayName": "WeldPass",
        "UILaunchScreen": ["UIColorName": ""],
        "NSFaceIDUsageDescription": "WeldPass uses Face ID to unlock your vaults and before it shows or copies a password.",
        "ITSAppUsesNonExemptEncryption": false,
        "CFBundleURLTypes": [
            ["CFBundleURLName": "com.weldsuite.weldpass", "CFBundleURLSchemes": ["weldpass"]],
        ],
        "WeldEUServerURL": "$(WELD_EU_SERVER_URL)",
        "WeldPassKeychainGroup": "$(AppIdentifierPrefix)com.weldsuite.weldpass.shared",
        // Filled in with the App Store id at the first native release.
        "WeldAppStoreURL": "https://apps.apple.com",
        "UISupportedInterfaceOrientations": ["UIInterfaceOrientationPortrait"],
        "UISupportedInterfaceOrientations~ipad": [
            "UIInterfaceOrientationPortrait",
            "UIInterfaceOrientationPortraitUpsideDown",
            "UIInterfaceOrientationLandscapeLeft",
            "UIInterfaceOrientationLandscapeRight",
        ],
    ]) { _, new in new }),
    sources: ["Apps/WeldPass/Sources/**"],
    resources: ["Apps/WeldPass/Resources/**"],
    entitlements: .dictionary(weldPassEntitlements),
    dependencies: [
        .package(product: "WeldCore"),
        .package(product: "WeldUI"),
        .package(product: "WeldPassAPI"),
        .target(name: "WeldPassAutofill"),
    ],
    settings: appSettings(base: weldPassVersionSettings)
)

/// WeldPass in Settings → Passwords → AutoFill: logins from the offline copy,
/// with no network and no tokens.
let weldPassAutofill: Target = .target(
    name: "WeldPassAutofill",
    destinations: [.iPhone, .iPad],
    product: .appExtension,
    bundleId: "com.weldsuite.weldpass.autofill",
    deploymentTargets: .iOS("17.0"),
    infoPlist: .extendingDefault(with: weldPassVersion.merging([
        "CFBundleDisplayName": "WeldPass",
        "NSExtension": [
            "NSExtensionPointIdentifier": "com.apple.authentication-services-credential-provider-ui",
            "NSExtensionPrincipalClass": "$(PRODUCT_MODULE_NAME).CredentialProviderViewController",
            "NSExtensionAttributes": [
                "ASCredentialProviderExtensionCapabilities": ["ProvidesPasswords": true],
            ],
        ],
        "WeldPassKeychainGroup": "$(AppIdentifierPrefix)com.weldsuite.weldpass.shared",
        "NSFaceIDUsageDescription": "WeldPass uses Face ID to fill in your passwords.",
    ]) { _, new in new }),
    // The app's generated strings, so the extension speaks English and Dutch too.
    sources: ["Apps/WeldPassAutofill/Sources/**", "Apps/WeldPass/Sources/Generated/PassStrings.swift"],
    resources: ["Apps/WeldPass/Resources/Localizable.xcstrings"],
    entitlements: .dictionary(weldPassEntitlements),
    settings: .settings(base: weldPassVersionSettings.merging(["SWIFT_VERSION": "5.0"]) { _, new in new })
)

let weldPassTests: Target = .target(
    name: "WeldPassTests",
    destinations: [.iPhone, .iPad],
    product: .unitTests,
    bundleId: "com.weldsuite.weldpass.tests",
    deploymentTargets: .iOS("17.0"),
    infoPlist: .default,
    sources: ["Apps/WeldPass/Tests/**"],
    dependencies: [.target(name: "WeldPass")],
    settings: .settings(base: ["SWIFT_VERSION": "5.0"])
)

let project = Project(
    name: "WeldSuite",
    options: .options(
        automaticSchemesOptions: .disabled,
        defaultKnownRegions: ["en", "nl"],
        developmentRegion: "en"
    ),
    packages: [.local(path: "WeldKit")],
    targets: [weldPass, weldPassAutofill, weldPassTests],
    schemes: [
        .scheme(
            name: "WeldPass",
            shared: true,
            buildAction: .buildAction(targets: ["WeldPass"]),
            testAction: .targets(["WeldPassTests"]),
            runAction: .runAction(configuration: .debug, executable: "WeldPass")
        ),
    ]
)
