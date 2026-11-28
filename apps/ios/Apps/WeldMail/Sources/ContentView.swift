import SwiftUI
import WeldCore
import WeldUI

/// A `weldmail://` link the app was opened with, waiting until the app is on screen.
@MainActor
@Observable
final class MailLinks {
    static let shared = MailLinks()
    var pending: MailLinkRoute?
}

/// WeldMail once signed in, in a workspace and unlocked: the mail, search
/// and settings tabs, each with its own stack, and the composer as a sheet.
struct ContentView: View {
    let env: AppEnvironment
    let store: MailStore
    let person: Person
    let workspace: WorkspaceRef
    let workspaces: [WorkspaceRef]
    @Binding var appearance: AppAppearance

    @State private var nav = MailNavigator()
    @State private var notifier = MailNotifier()

    var body: some View {
        TabView(selection: $nav.tab) {
            NavigationStack(path: $nav.mailPath) {
                InboxView(env: env, store: store, workspace: workspace)
                    .mailDestinations(env: env, store: store)
            }
            .tabItem { Label(MailStrings.tabsMail, systemImage: "envelope") }
            .tag(MailNavigator.Tab.mail)
            .accessibilityIdentifier("tab-mail")

            NavigationStack(path: $nav.searchPath) {
                SearchView(store: store)
                    .mailDestinations(env: env, store: store)
            }
            .tabItem { Label(MailStrings.tabsSearch, systemImage: "magnifyingglass") }
            .tag(MailNavigator.Tab.search)
            .accessibilityIdentifier("tab-search")

            NavigationStack(path: $nav.settingsPath) {
                SettingsView(env: env, store: store, person: person, workspace: workspace, workspaces: workspaces, appearance: $appearance)
                    .mailDestinations(env: env, store: store)
            }
            .tabItem { Label(MailStrings.tabsSettings, systemImage: "gearshape") }
            .tag(MailNavigator.Tab.settings)
            .accessibilityIdentifier("tab-settings")
        }
        .sheet(item: $nav.composing) { request in
            ComposeView(env: env, store: store, prefill: request.prefill)
                .environment(nav)
                .mailNotices(notifier)
        }
        .environment(nav)
        .mailNotices(notifier)
        .task(id: workspace.id) { store.use(workspace: workspace.id) }
        // New mail for this person (`mail:new`) and changes to messages in shared mailboxes.
        .realtimeRefresh(env, topics: ["mail.\(person.id)", "email"]) { await store.refresh() }
        .task {
            // A push about the email on screen doesn't pop up over it.
            PushCenter.shared.shouldPresent = { payload in
                guard let open = OpenEmail.id else { return true }
                return MailLogic.notificationTarget(payload.values)?.emailID != open
            }
            takePushTap()
            takeLink()
        }
        .onChange(of: PushCenter.shared.pendingTap) { _, _ in takePushTap() }
        .onChange(of: MailLinks.shared.pending) { _, _ in takeLink() }
    }

    /// A tapped notification: the mailbox it arrived in, then the email.
    private func takePushTap() {
        guard let tap = env.takePushTap(), let target = MailLogic.notificationTarget(tap.values) else { return }
        store.follow(accountID: target.accountID)
        store.expect(target.emailID)
        guard let id = target.emailID else { return }
        nav.previews[id] = MessagePreview(fromName: target.fromName, fromEmail: target.fromEmail, subject: target.subject, preview: target.preview)
        nav.showMessage(id)
    }

    private func takeLink() {
        guard let route = MailLinks.shared.pending else { return }
        MailLinks.shared.pending = nil
        switch route {
        case let .message(id):
            nav.showMessage(id)
        case let .compose(to, subject):
            nav.compose(ComposePrefill(to: to, subject: subject))
        case .search:
            nav.tab = .search
        case .settings:
            nav.tab = .settings
        case .subscriptions:
            nav.tab = .mail
            nav.mailPath = [.subscriptions]
        }
    }
}
