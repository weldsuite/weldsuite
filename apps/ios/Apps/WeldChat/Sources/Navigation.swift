import Observation
import SwiftUI
import WeldCore
import WeldUI

/// A conversation to open, with what the tapped row already knew, so the
/// header has a name while the channel itself loads.
struct ChannelRoute: Hashable {
    let channelID: String
    var name: String?
    var type: String?
    var entityType: String?
}

/// The screens pushed on a tab's stack.
enum ChatRoute: Hashable {
    case channel(ChannelRoute)
    case thread(messageID: String, channelID: String, draft: String?)
    case channelInfo(channelID: String, name: String)
    case member(userID: String)
    case drafts
    case saved
    case records(type: String?)
    case search
    case settings
    case profile
}

/// The create screens, as sheets.
enum ChatSheet: Identifiable {
    case newChannel(sectionID: String?)
    case newCategory
    case newDm(group: Bool)
    case newMessage
    case invitePeople(channelID: String, name: String)

    var id: String {
        switch self {
        case let .newChannel(section): "new-channel-\(section ?? "")"
        case .newCategory: "new-category"
        case let .newDm(group): "new-dm-\(group)"
        case .newMessage: "new-message"
        case let .invitePeople(channel, _): "invite-\(channel)"
        }
    }
}

enum ChatTab: String, Hashable {
    case home, dms, activity, calls
}

/// Opens screens from anywhere: pushes on the selected tab's stack, or shows a sheet.
@MainActor
@Observable
final class ChatNavigator {
    var tab: ChatTab = .home
    var homePath: [ChatRoute] = []
    var dmsPath: [ChatRoute] = []
    var activityPath: [ChatRoute] = []
    var callsPath: [ChatRoute] = []
    var sheet: ChatSheet?

    func open(_ route: ChatRoute) {
        switch tab {
        case .home: homePath.append(route)
        case .dms: dmsPath.append(route)
        case .activity: activityPath.append(route)
        case .calls: callsPath.append(route)
        }
    }

    /// Back to the tab's root (after leaving or deleting a channel).
    func popToRoot() {
        switch tab {
        case .home: homePath = []
        case .dms: dmsPath = []
        case .activity: activityPath = []
        case .calls: callsPath = []
        }
    }

    func openConversation(channelID: String, name: String? = nil, type: String? = nil, entityType: String? = nil) {
        open(.channel(ChannelRoute(channelID: channelID, name: name, type: type, entityType: entityType)))
    }

    /// Close the sheet, then open what it made.
    func finishSheet(opening route: ChatRoute?) {
        sheet = nil
        guard let route else { return }
        Task {
            try? await Task.sleep(for: .milliseconds(350))
            open(route)
        }
    }
}

extension View {
    /// The destinations every tab's stack can push.
    func chatDestinations(env: AppEnvironment, store: ChatStore, person: Person, workspace: WorkspaceRef, workspaces: [WorkspaceRef], appearance: Binding<AppAppearance>) -> some View {
        navigationDestination(for: ChatRoute.self) { route in
            switch route {
            case let .channel(channel):
                ChannelView(env: env, store: store, person: person, route: channel)
            case let .thread(messageID, channelID, draft):
                ThreadView(env: env, store: store, person: person, messageID: messageID, channelID: channelID, draft: draft)
            case let .channelInfo(channelID, name):
                ChannelInfoView(store: store, person: person, channelID: channelID, initialName: name)
            case let .member(userID):
                MemberView(env: env, store: store, person: person, userID: userID)
            case .drafts:
                DraftsView(store: store)
            case .saved:
                SavedView(store: store)
            case let .records(type):
                RecordsView(env: env, store: store, person: person, initialType: type)
            case .search:
                SearchView(store: store)
            case .settings:
                SettingsView(env: env, person: person, workspace: workspace, workspaces: workspaces, appearance: appearance)
            case .profile:
                ProfileView(env: env, store: store, person: person)
            }
        }
    }
}
