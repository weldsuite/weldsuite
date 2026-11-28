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

// MARK: - The other apps

/// One native app that replaces an Expo app in place: same bundle id
/// (`com.weldsuite.<code>`) and URL scheme, the next major version.
struct NativeApp {
    /// `WeldChat`: the target, the scheme and `Apps/<name>/`.
    let name: String
    /// `weldchat`: the bundle id's last part, the URL scheme, `X-Weld-App`.
    let code: String
    /// Above the React Native app's version, which this replaces in the stores.
    let version: String
    /// The WeldKit API target generated from `openapi/<code>.yaml`.
    let api: String
    /// What the app asks iOS for, and why (shown in the permission prompt).
    var usage: [String: String] = [:]
    var backgroundModes: [String] = []
    var extraPlist: [String: Plist.Value] = [:]
    var extraEntitlements: [String: Plist.Value] = [:]
    var dependencies: [TargetDependency] = []
}

/// The app's Info.plist, entitlements and targets: the app and its unit tests.
func targets(_ app: NativeApp) -> [Target] {
    var plist: [String: Plist.Value] = [
        "CFBundleShortVersionString": "$(MARKETING_VERSION)",
        "CFBundleVersion": "$(CURRENT_PROJECT_VERSION)",
        "CFBundleDisplayName": .string(app.name),
        "UILaunchScreen": ["UIColorName": ""],
        "NSFaceIDUsageDescription": .string("\(app.name) uses Face ID to unlock the app when you turn on the app lock."),
        "ITSAppUsesNonExemptEncryption": false,
        "CFBundleURLTypes": [
            ["CFBundleURLName": .string("com.weldsuite.\(app.code)"), "CFBundleURLSchemes": [.string(app.code)]],
        ],
        "WeldEUServerURL": "$(WELD_EU_SERVER_URL)",
        // Filled in with the App Store id at the first native release.
        "WeldAppStoreURL": "https://apps.apple.com",
        "UISupportedInterfaceOrientations": ["UIInterfaceOrientationPortrait"],
        "UISupportedInterfaceOrientations~ipad": [
            "UIInterfaceOrientationPortrait",
            "UIInterfaceOrientationPortraitUpsideDown",
            "UIInterfaceOrientationLandscapeLeft",
            "UIInterfaceOrientationLandscapeRight",
        ],
    ]
    for (key, text) in app.usage { plist[key] = .string(text) }
    if !app.backgroundModes.isEmpty { plist["UIBackgroundModes"] = .array(app.backgroundModes.map { .string($0) }) }
    plist.merge(app.extraPlist) { _, new in new }

    // Push: automatic signing turns this into `production` for App Store builds.
    var entitlements: [String: Plist.Value] = ["aps-environment": "development"]
    entitlements.merge(app.extraEntitlements) { _, new in new }

    let versionSettings: SettingsDictionary = [
        "MARKETING_VERSION": .string(app.version),
        "CURRENT_PROJECT_VERSION": "200",
    ]
    return [
        .target(
            name: app.name,
            destinations: [.iPhone, .iPad],
            product: .app,
            bundleId: "com.weldsuite.\(app.code)",
            deploymentTargets: .iOS("17.0"),
            infoPlist: .extendingDefault(with: plist),
            sources: ["Apps/\(app.name)/Sources/**"],
            resources: ["Apps/\(app.name)/Resources/**"],
            entitlements: .dictionary(entitlements),
            dependencies: [
                .package(product: "WeldCore"),
                .package(product: "WeldUI"),
                .package(product: app.api),
            ] + app.dependencies,
            settings: appSettings(base: versionSettings)
        ),
        .target(
            name: "\(app.name)Tests",
            destinations: [.iPhone, .iPad],
            product: .unitTests,
            bundleId: "com.weldsuite.\(app.code).tests",
            deploymentTargets: .iOS("17.0"),
            infoPlist: .default,
            sources: ["Apps/\(app.name)/Tests/**"],
            dependencies: [.target(name: app.name)],
            settings: .settings(base: ["SWIFT_VERSION": "5.0"])
        ),
    ]
}

func scheme(_ app: NativeApp) -> Scheme {
    .scheme(
        name: app.name,
        shared: true,
        buildAction: .buildAction(targets: [.target(app.name)]),
        testAction: .targets([.testableTarget(target: .target("\(app.name)Tests"))]),
        runAction: .runAction(configuration: .debug, executable: .target(app.name))
    )
}

let nativeApps: [NativeApp] = [
    NativeApp(
        name: "WeldBooks",
        code: "weldbooks",
        version: "2.0.0",
        api: "WeldBooksAPI",
        usage: [
            "NSCameraUsageDescription": "WeldBooks uses the camera to scan receipts, bills and invoices.",
            "NSPhotoLibraryAddUsageDescription": "WeldBooks saves invoice PDFs to your photo library when you ask it to.",
        ]
    ),
    NativeApp(name: "WeldMail", code: "weldmail", version: "2.0.0", api: "WeldMailAPI", usage: [
        "NSCameraUsageDescription": "WeldMail uses the camera to take a photo to attach to an email.",
    ]),
    NativeApp(name: "WeldCalendar", code: "weldcalendar", version: "2.0.0", api: "WeldCalendarAPI"),
    NativeApp(
        name: "WeldChat",
        code: "weldchat",
        version: "3.0.0",
        api: "WeldChatAPI",
        usage: [
            "NSCameraUsageDescription": "WeldChat uses the camera for video calls and to share photos in a conversation.",
            "NSMicrophoneUsageDescription": "WeldChat uses the microphone for calls and voice messages.",
        ],
        // Calls: audio keeps a call going in the background, VoIP pushes ring
        // through CallKit (ADR CHAT-005).
        backgroundModes: ["audio", "voip", "remote-notification"],
        dependencies: [.package(product: "LiveKit")]
    ),
    NativeApp(name: "WeldDesk", code: "welddesk", version: "3.0.0", api: "WeldDeskAPI", usage: [
        "NSCameraUsageDescription": "WeldDesk uses the camera to take a photo to attach to a reply.",
    ]),
    NativeApp(
        name: "WeldHR",
        code: "weldhr",
        version: "2.0.0",
        api: "WeldHRAPI",
        usage: [
            "NSCameraUsageDescription": "WeldHR uses the camera to photograph receipts for your expenses and sick notes.",
            "NSLocationWhenInUseUsageDescription": "WeldHR records where you clock in and out, when your employer asks for it.",
        ]
    ),
]

let project = Project(
    name: "WeldSuite",
    options: .options(
        automaticSchemesOptions: .disabled,
        defaultKnownRegions: ["en", "nl"],
        developmentRegion: "en"
    ),
    packages: [
        .local(path: "WeldKit"),
        // WeldChat's calls (ADR CHAT-008).
        .remote(url: "https://github.com/livekit/client-sdk-swift", requirement: .upToNextMajor(from: "2.0.0")),
    ],
    targets: [weldPass, weldPassAutofill, weldPassTests] + nativeApps.flatMap(targets),
    schemes: [
        .scheme(
            name: "WeldPass",
            shared: true,
            buildAction: .buildAction(targets: ["WeldPass"]),
            testAction: .targets(["WeldPassTests"]),
            runAction: .runAction(configuration: .debug, executable: "WeldPass")
        ),
    ] + nativeApps.map(scheme)
)
