import SwiftUI
import WeldCore
import WeldUI

@main
struct WeldChatApp: App {
    /// PushKit and CallKit for the call ring (ADR CHAT-005), on top of the core's push delegate.
    @UIApplicationDelegateAdaptor(WeldChatAppDelegate.self) private var delegate
    @State private var env: AppEnvironment
    @State private var store: ChatStore
    @State private var calls: CallManager
    @State private var navigator = ChatNavigator()
    @State private var toaster = Toaster()
    @AppStorage(AppAppearance.storageKey(app: "weldchat")) private var appearance = AppAppearance.system
    @Environment(\.scenePhase) private var scenePhase

    init() {
        let info = Bundle.main.infoDictionary ?? [:]
        let server = (info["WeldEUServerURL"] as? String).flatMap(URL.init(string:)) ?? URL(string: "https://app.weldsuite.eu")!
        let env = AppEnvironment(
            app: AppIdentity(
                code: "weldchat",
                name: ChatStrings.appName,
                scheme: "weldchat",
                requiredModules: ["chat"],
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
        _store = State(initialValue: ChatStore(env: env))
        _calls = State(initialValue: CallManager(env: env))
    }

    var body: some Scene {
        WindowGroup {
            SessionGate(
                env: env,
                branding: AppBranding(name: ChatStrings.appName, subtitle: ChatStrings.authSubtitle, logo: "Logo")
            ) { person, workspace, workspaces in
                ContentView(
                    env: env,
                    store: store,
                    calls: calls,
                    navigator: navigator,
                    person: person,
                    workspace: workspace,
                    workspaces: workspaces,
                    appearance: $appearance
                )
            }
            .environment(calls)
            .environment(navigator)
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
