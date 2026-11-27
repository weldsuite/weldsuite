import SwiftUI
import WeldCore
import WeldUI

/// A `welddesk://` link the app was opened with, waiting until the inbox is on screen.
@MainActor
@Observable
final class DeskLinks {
    static let shared = DeskLinks()
    var pending: DeskRoute?
}

/// WeldDesk once signed in, in a workspace and unlocked: the inbox (and a
/// conversation on its stack) and settings.
struct ContentView: View {
    let env: AppEnvironment
    let store: DeskStore
    let person: Person
    let workspace: WorkspaceRef
    let workspaces: [WorkspaceRef]
    @Binding var appearance: AppAppearance

    @Environment(Toaster.self) private var toaster
    @State private var tab = Tab.inbox
    @State private var path: [ConversationRoute] = []
    @State private var inbox: InboxModel

    enum Tab: Hashable {
        case inbox, settings
    }

    init(env: AppEnvironment, store: DeskStore, person: Person, workspace: WorkspaceRef, workspaces: [WorkspaceRef], appearance: Binding<AppAppearance>) {
        self.env = env
        self.store = store
        self.person = person
        self.workspace = workspace
        self.workspaces = workspaces
        _appearance = appearance
        _inbox = State(initialValue: InboxModel(store: store, userID: person.id))
    }

    var body: some View {
        TabView(selection: $tab) {
            NavigationStack(path: $path) {
                InboxView(env: env, model: inbox)
                    .navigationTitle(DeskStrings.inboxTitle)
                    .navigationDestination(for: ConversationRoute.self) { route in
                        ConversationView(env: env, store: store, toaster: toaster, route: route, userID: person.id)
                    }
            }
            .tabItem { Label(DeskStrings.tabsInbox, systemImage: "tray") }
            .tag(Tab.inbox)
            .accessibilityIdentifier("tab-inbox")

            NavigationStack {
                SettingsView(env: env, person: person, workspace: workspace, workspaces: workspaces, appearance: $appearance)
                    .navigationTitle(DeskStrings.settingsTitle)
            }
            .tabItem { Label(DeskStrings.tabsSettings, systemImage: "gearshape") }
            .tag(Tab.settings)
            .accessibilityIdentifier("tab-settings")
        }
        .task {
            // A push about the conversation on screen doesn't pop up over it.
            PushCenter.shared.shouldPresent = { payload in
                guard let open = OpenConversation.id else { return true }
                return DeskLogic.conversationID(fromPush: payload.values) != open
            }
            store.clear()
            takePushTap()
            takeLink()
        }
        .onChange(of: PushCenter.shared.pendingTap) { _, _ in takePushTap() }
        .onChange(of: DeskLinks.shared.pending) { _, _ in takeLink() }
    }

    /// A tapped notification: its conversation (a ticket opens the inbox).
    private func takePushTap() {
        guard let tap = env.takePushTap() else { return }
        open(DeskLogic.route(forPush: tap.values))
    }

    private func takeLink() {
        guard let route = DeskLinks.shared.pending else { return }
        DeskLinks.shared.pending = nil
        open(route)
    }

    private func open(_ route: DeskRoute) {
        switch route {
        case .inbox:
            tab = .inbox
            path = []
        case .settings:
            tab = .settings
        case let .conversation(id):
            tab = .inbox
            if path.last?.id != id { path = [ConversationRoute(id: id)] }
        }
    }
}
