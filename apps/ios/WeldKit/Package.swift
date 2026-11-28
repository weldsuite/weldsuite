// swift-tools-version: 6.0
//
// What every native WeldSuite iOS app shares:
//
// - `CoreAPI` and one API target per app (`WeldPassAPI`, `WeldChatAPI`, …):
//   clients generated at build time by
//   swift-openapi-generator from the OpenAPI files in
//   `apps/mobile-shared/openapi` (copied in by `pnpm mobile:generate`).
// - `WeldCore`: the server and its `/config.json`, WeldID sign-in, the
//   workspace, the API transport, the Keychain, the app lock, the realtime
//   socket and push registration.
// - `WeldUI`: the design tokens, the screens around an app (`SessionGate`)
//   and the components the apps share.

import PackageDescription

let package = Package(
    name: "WeldKit",
    defaultLocalization: "en",
    platforms: [.iOS(.v17)],
    products: [
        .library(name: "CoreAPI", targets: ["CoreAPI"]),
        .library(name: "WeldPassAPI", targets: ["WeldPassAPI"]),
        .library(name: "WeldBooksAPI", targets: ["WeldBooksAPI"]),
        .library(name: "WeldMailAPI", targets: ["WeldMailAPI"]),
        .library(name: "WeldCalendarAPI", targets: ["WeldCalendarAPI"]),
        .library(name: "WeldChatAPI", targets: ["WeldChatAPI"]),
        .library(name: "WeldDeskAPI", targets: ["WeldDeskAPI"]),
        .library(name: "WeldHRAPI", targets: ["WeldHRAPI"]),
        .library(name: "WeldCore", targets: ["WeldCore"]),
        .library(name: "WeldUI", targets: ["WeldUI"]),
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-openapi-generator", from: "1.6.0"),
        .package(url: "https://github.com/apple/swift-openapi-runtime", from: "1.7.0"),
        .package(url: "https://github.com/apple/swift-openapi-urlsession", from: "1.0.2"),
        .package(url: "https://github.com/apple/swift-http-types", from: "1.3.0"),
        .package(url: "https://github.com/openid/AppAuth-iOS", from: "1.7.6"),
    ],
    targets: [
        .target(
            name: "CoreAPI",
            dependencies: [.product(name: "OpenAPIRuntime", package: "swift-openapi-runtime")],
            plugins: [.plugin(name: "OpenAPIGenerator", package: "swift-openapi-generator")]
        ),
        .target(
            name: "WeldPassAPI",
            dependencies: [.product(name: "OpenAPIRuntime", package: "swift-openapi-runtime")],
            plugins: [.plugin(name: "OpenAPIGenerator", package: "swift-openapi-generator")]
        ),
        .target(
            name: "WeldBooksAPI",
            dependencies: [.product(name: "OpenAPIRuntime", package: "swift-openapi-runtime")],
            plugins: [.plugin(name: "OpenAPIGenerator", package: "swift-openapi-generator")]
        ),
        .target(
            name: "WeldMailAPI",
            dependencies: [.product(name: "OpenAPIRuntime", package: "swift-openapi-runtime")],
            plugins: [.plugin(name: "OpenAPIGenerator", package: "swift-openapi-generator")]
        ),
        .target(
            name: "WeldCalendarAPI",
            dependencies: [.product(name: "OpenAPIRuntime", package: "swift-openapi-runtime")],
            plugins: [.plugin(name: "OpenAPIGenerator", package: "swift-openapi-generator")]
        ),
        .target(
            name: "WeldChatAPI",
            dependencies: [.product(name: "OpenAPIRuntime", package: "swift-openapi-runtime")],
            plugins: [.plugin(name: "OpenAPIGenerator", package: "swift-openapi-generator")]
        ),
        .target(
            name: "WeldDeskAPI",
            dependencies: [.product(name: "OpenAPIRuntime", package: "swift-openapi-runtime")],
            plugins: [.plugin(name: "OpenAPIGenerator", package: "swift-openapi-generator")]
        ),
        .target(
            name: "WeldHRAPI",
            dependencies: [.product(name: "OpenAPIRuntime", package: "swift-openapi-runtime")],
            plugins: [.plugin(name: "OpenAPIGenerator", package: "swift-openapi-generator")]
        ),
        .target(
            name: "WeldCore",
            dependencies: [
                "CoreAPI",
                .product(name: "OpenAPIRuntime", package: "swift-openapi-runtime"),
                .product(name: "OpenAPIURLSession", package: "swift-openapi-urlsession"),
                .product(name: "HTTPTypes", package: "swift-http-types"),
                .product(name: "AppAuth", package: "AppAuth-iOS"),
            ],
            resources: [.process("Resources")]
        ),
        .target(
            name: "WeldUI",
            dependencies: ["WeldCore"]
        ),
        .testTarget(
            name: "WeldCoreTests",
            dependencies: ["WeldCore", "CoreAPI"]
        ),
    ],
    swiftLanguageModes: [.v5]
)
