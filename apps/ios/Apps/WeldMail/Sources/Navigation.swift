import SwiftUI
import WeldCore

/// A screen pushed on a tab's stack.
enum MailRoute: Hashable {
    case message(String)
    case contact(String)
    case subscriptions
    case addAccount
}

/// The composer's sheet: what it opens with.
struct ComposeRequest: Identifiable {
    let id = UUID()
    let prefill: ComposePrefill
}

/// A message opened from a notification: what it said, to paint before the message loads.
struct MessagePreview: Equatable {
    let fromName: String?
    let fromEmail: String?
    let subject: String?
    let preview: String?
}

/// Where the app is: the tab, each tab's stack, and the composer.
@MainActor
@Observable
final class MailNavigator {
    enum Tab: Hashable {
        case mail, search, settings
    }

    var tab = Tab.mail
    var mailPath: [MailRoute] = []
    var searchPath: [MailRoute] = []
    var settingsPath: [MailRoute] = []
    var composing: ComposeRequest?
    /// What a notification said about a message, by its id.
    var previews: [String: MessagePreview] = [:]

    /// Pushes a screen on the stack of the tab on screen.
    func open(_ route: MailRoute) {
        switch tab {
        case .mail: mailPath.append(route)
        case .search: searchPath.append(route)
        case .settings: settingsPath.append(route)
        }
    }

    /// Replaces the screen on top (the next message after "archive and next").
    func replaceTop(with route: MailRoute) {
        switch tab {
        case .mail:
            if !mailPath.isEmpty { mailPath.removeLast() }
            mailPath.append(route)
        case .search:
            if !searchPath.isEmpty { searchPath.removeLast() }
            searchPath.append(route)
        case .settings:
            if !settingsPath.isEmpty { settingsPath.removeLast() }
            settingsPath.append(route)
        }
    }

    func compose(_ prefill: ComposePrefill) {
        composing = ComposeRequest(prefill: prefill)
    }

    /// A message from a notification or a link: on the mail tab, on its own.
    func showMessage(_ id: String) {
        tab = .mail
        if mailPath.last != .message(id) { mailPath = [.message(id)] }
    }
}

/// The email on screen, so a push about it shows no banner.
@MainActor
enum OpenEmail {
    static var id: String?
}

extension View {
    /// The screens every tab can push.
    func mailDestinations(env: AppEnvironment, store: MailStore) -> some View {
        navigationDestination(for: MailRoute.self) { route in
            switch route {
            case let .message(id):
                MessageView(env: env, store: store, messageID: id)
            case let .contact(key):
                ContactView(store: store, key: key)
            case .subscriptions:
                SubscriptionsView(store: store)
            case .addAccount:
                AddAccountView(env: env, store: store)
            }
        }
    }
}
