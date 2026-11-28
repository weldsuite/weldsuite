import SwiftUI
import WeldCore
import WeldUI

@main
struct WeldCalendarApp: App {
    @UIApplicationDelegateAdaptor(WeldAppDelegate.self) private var delegate
    @State private var env: AppEnvironment
    @State private var store: CalendarStore
    @State private var toaster = Toaster()
    /// A `weldcalendar://` link, held until the person is in a workspace.
    @State private var link: CalendarLink?
    @AppStorage(AppAppearance.storageKey(app: "weldcalendar")) private var appearance = AppAppearance.system
    @Environment(\.scenePhase) private var scenePhase

    init() {
        let info = Bundle.main.infoDictionary ?? [:]
        let server = (info["WeldEUServerURL"] as? String).flatMap(URL.init(string:)) ?? URL(string: "https://app.weldsuite.eu")!
        let env = AppEnvironment(
            app: AppIdentity(
                code: "weldcalendar",
                name: CalendarStrings.appName,
                scheme: "weldcalendar",
                requiredModules: ["calendar"],
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
        _store = State(initialValue: CalendarStore(env: env))
    }

    var body: some Scene {
        WindowGroup {
            SessionGate(
                env: env,
                branding: AppBranding(name: CalendarStrings.appName, subtitle: CalendarStrings.authSubtitle, logo: "Logo")
            ) { person, workspace, workspaces in
                ContentView(
                    env: env,
                    store: store,
                    person: person,
                    workspace: workspace,
                    workspaces: workspaces,
                    appearance: $appearance,
                    link: $link
                )
            }
            .tint(Tokens.Palette.primary)
            .preferredColorScheme(appearance.colorScheme)
            .toastOverlay(toaster)
            // weldcalendar://event/<id> and the other paths the Expo app's router answered.
            .onOpenURL { url in
                if let target = parseCalendarLink(url.absoluteString) { link = target }
            }
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
