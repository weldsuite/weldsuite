import SwiftUI
import WeldCore
import WeldUI

@main
struct WeldHRApp: App {
    @UIApplicationDelegateAdaptor(WeldAppDelegate.self) private var delegate
    @State private var env: AppEnvironment
    @State private var store: HRStore
    @State private var toaster = Toaster()
    @AppStorage(AppAppearance.storageKey(app: "weldhr")) private var appearance = AppAppearance.system
    @Environment(\.scenePhase) private var scenePhase

    init() {
        let info = Bundle.main.infoDictionary ?? [:]
        let server = (info["WeldEUServerURL"] as? String).flatMap(URL.init(string:)) ?? URL(string: "https://app.weldsuite.eu")!
        let env = AppEnvironment(
            app: AppIdentity(
                code: "weldhr",
                name: HRStrings.appName,
                scheme: "weldhr",
                requiredModules: ["hr"],
                euServerURL: server,
                version: info["CFBundleShortVersionString"] as? String ?? "0",
                // The App Store page, set in Project.swift (`WeldAppStoreURL`).
                storeURL: (info["WeldAppStoreURL"] as? String).flatMap(URL.init(string:)) ?? URL(string: "https://apps.apple.com")!
            ),
            lockRequired: false,
            optionalLock: true,
            usesPush: true
        )
        _env = State(initialValue: env)
        _store = State(initialValue: HRStore(env: env))
    }

    var body: some Scene {
        WindowGroup {
            SessionGate(
                env: env,
                branding: AppBranding(name: HRStrings.appName, subtitle: HRStrings.authSubtitle, logo: "Logo")
            ) { person, workspace, workspaces in
                ContentView(env: env, store: store, person: person, workspace: workspace, workspaces: workspaces, appearance: $appearance)
            }
            .tint(Tokens.Palette.primary)
            .preferredColorScheme(appearance.colorScheme)
            .toastOverlay(toaster)
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .background: env.lock.didEnterBackground()
            case .active: env.lock.willEnterForeground()
            default: break
            }
        }
    }
}
