import SwiftUI
import WeldCore
import WeldUI

@main
struct WeldMailApp: App {
    @UIApplicationDelegateAdaptor(WeldAppDelegate.self) private var delegate
    @State private var env: AppEnvironment
    @State private var store: MailStore
    @State private var toaster = Toaster()
    @AppStorage(AppAppearance.storageKey(app: "weldmail")) private var appearance = AppAppearance.system
    @Environment(\.scenePhase) private var scenePhase

    init() {
        let info = Bundle.main.infoDictionary ?? [:]
        let server = (info["WeldEUServerURL"] as? String).flatMap(URL.init(string:)) ?? URL(string: "https://app.weldsuite.eu")!
        let env = AppEnvironment(
            app: AppIdentity(
                code: "weldmail",
                name: MailStrings.appName,
                scheme: "weldmail",
                requiredModules: ["mail"],
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
        _store = State(initialValue: MailStore(env: env))
    }

    var body: some Scene {
        WindowGroup {
            SessionGate(
                env: env,
                branding: AppBranding(name: MailStrings.appName, subtitle: MailStrings.authSubtitle, logo: "Logo")
            ) { person, workspace, workspaces in
                ContentView(env: env, store: store, person: person, workspace: workspace, workspaces: workspaces, appearance: $appearance)
                    // Another workspace (or person) starts over: its own stacks and screens.
                    .id("\(person.id):\(workspace.id)")
            }
            .tint(Tokens.Brand.weldmail)
            .preferredColorScheme(appearance.colorScheme)
            .toastOverlay(toaster)
            // weldmail://message/<id>, weldmail://compose?to=…, …/search, …/settings, …/subscriptions.
            .onOpenURL { url in
                if let route = MailLinkRoute.of(url) { MailLinks.shared.pending = route }
            }
            // Signed out: nothing of this person's mail stays on the phone.
            .onChange(of: env.state) { _, state in
                if case .signedOut = state { store.clear() }
            }
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .background:
                env.lock.didEnterBackground()
            case .active:
                env.lock.willEnterForeground()
                // Back in the app: what waited in the outbox goes out, the list catches up.
                Task {
                    await store.flush()
                    await store.refresh()
                }
            default:
                break
            }
        }
    }
}
