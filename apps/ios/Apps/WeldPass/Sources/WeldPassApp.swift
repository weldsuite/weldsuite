import SwiftUI
import WeldCore
import WeldUI

@main
struct WeldPassApp: App {
    @State private var env: AppEnvironment
    @State private var store: PassStore
    @State private var toast = ToastCenter()
    @Environment(\.scenePhase) private var scenePhase

    init() {
        let info = Bundle.main.infoDictionary ?? [:]
        let server = (info["WeldEUServerURL"] as? String).flatMap(URL.init(string:)) ?? URL(string: "https://app.weldsuite.eu")!
        let env = AppEnvironment(
            app: AppIdentity(
                code: "weldpass",
                name: PassStrings.appName,
                scheme: "weldpass",
                requiredModules: ["pass"],
                euServerURL: server,
                version: info["CFBundleShortVersionString"] as? String ?? "0",
                // The App Store page, set in Project.swift (`WeldAppStoreURL`).
                storeURL: (info["WeldAppStoreURL"] as? String).flatMap(URL.init(string:))
                    ?? URL(string: "https://apps.apple.com")!
            ),
            // A password manager is always locked: Face ID or the passcode at start,
            // after a minute in the background, and before a secret is shown or copied.
            lockRequired: true
        )
        _env = State(initialValue: env)
        _store = State(initialValue: PassStore(env: env))
    }

    var body: some Scene {
        WindowGroup {
            SessionGate(
                env: env,
                branding: AppBranding(name: PassStrings.appName, subtitle: PassStrings.authSubtitle, logo: "Logo")
            ) { person, workspace, workspaces in
                ContentView(env: env, store: store, person: person, workspace: workspace, workspaces: workspaces)
            }
            .tint(Tokens.Brand.weldpass)
            .environment(toast)
            .overlay(alignment: .bottom) { ToastView(center: toast) }
            // The app switcher shows a blur, never a vault.
            .overlay {
                if scenePhase != .active {
                    Rectangle().fill(.regularMaterial).ignoresSafeArea()
                }
            }
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .background:
                env.lock.didEnterBackground()
            case .active:
                env.lock.willEnterForeground()
                if !env.lock.isLocked { Task { await store.offline.syncIfDue() } }
            default:
                break
            }
        }
        .onChange(of: env.lock.isLocked) { _, locked in
            // Locked again: the copy and its key leave memory until the next unlock.
            if locked { store.offline.close() }
        }
    }
}

/// A short message at the bottom of the screen (a copy, a failure).
@MainActor
@Observable
final class ToastCenter {
    private(set) var message: String?
    @ObservationIgnored private var hideTask: Task<Void, Never>?

    func show(_ text: String) {
        message = text
        hideTask?.cancel()
        hideTask = Task {
            try? await Task.sleep(for: .seconds(3))
            if !Task.isCancelled { message = nil }
        }
    }
}

private struct ToastView: View {
    let center: ToastCenter

    var body: some View {
        if let message = center.message {
            Text(message)
                .font(.subheadline)
                .padding(.horizontal, Tokens.Spacing.l)
                .padding(.vertical, Tokens.Spacing.m)
                .background(.thinMaterial, in: Capsule())
                .padding(.bottom, 90)
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .accessibilityAddTraits(.isStaticText)
        }
    }
}
