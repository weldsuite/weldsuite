import SwiftUI
import WeldCore
import WeldUI

@main
struct WeldDeskApp: App {
    @UIApplicationDelegateAdaptor(WeldAppDelegate.self) private var delegate
    @State private var env: AppEnvironment
    @State private var toaster = Toaster()
    @AppStorage(AppAppearance.storageKey(app: "welddesk")) private var appearance = AppAppearance.system
    @Environment(\.scenePhase) private var scenePhase

    init() {
        let info = Bundle.main.infoDictionary ?? [:]
        let server = (info["WeldEUServerURL"] as? String).flatMap(URL.init(string:)) ?? URL(string: "https://app.weldsuite.eu")!
        _env = State(initialValue: AppEnvironment(
            app: AppIdentity(
                code: "welddesk",
                name: DeskStrings.appName,
                scheme: "welddesk",
                requiredModules: ["desk"],
                euServerURL: server,
                version: info["CFBundleShortVersionString"] as? String ?? "0",
                // The App Store page, set in Project.swift (`WeldAppStoreURL`).
                storeURL: (info["WeldAppStoreURL"] as? String).flatMap(URL.init(string:)) ?? URL(string: "https://apps.apple.com")!
            ),
            lockRequired: false,
            optionalLock: true,
            usesPush: true
        ))
    }

    var body: some Scene {
        WindowGroup {
            SessionGate(
                env: env,
                branding: AppBranding(name: DeskStrings.appName, subtitle: DeskStrings.authSubtitle, logo: "Logo")
            ) { person, workspace, workspaces in
                ContentView(env: env, person: person, workspace: workspace, workspaces: workspaces, appearance: $appearance)
            }
            .tint(Tokens.Brand.welddesk)
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
