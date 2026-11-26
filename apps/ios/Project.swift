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

let weldPass: Target = .target(
    name: "WeldPass",
    destinations: [.iPhone, .iPad],
    product: .app,
    bundleId: "com.weldsuite.weldpass",
    deploymentTargets: .iOS("17.0"),
    infoPlist: .extendingDefault(with: [
        "CFBundleDisplayName": "WeldPass",
        // Above the React Native app's 1.x, which this replaces in the App Store.
        "CFBundleShortVersionString": "2.0.0",
        "CFBundleVersion": "200",
        "UILaunchScreen": ["UIColorName": ""],
        "NSFaceIDUsageDescription": "WeldPass uses Face ID to unlock your vaults and before it shows or copies a password.",
        "ITSAppUsesNonExemptEncryption": false,
        "CFBundleURLTypes": [
            ["CFBundleURLName": "com.weldsuite.weldpass", "CFBundleURLSchemes": ["weldpass"]],
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
    ]),
    sources: ["Apps/WeldPass/Sources/**"],
    resources: ["Apps/WeldPass/Resources/**"],
    dependencies: [
        .package(product: "WeldCore"),
        .package(product: "WeldUI"),
        .package(product: "WeldPassAPI"),
    ],
    settings: appSettings(base: [:])
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
    targets: [weldPass, weldPassTests],
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
