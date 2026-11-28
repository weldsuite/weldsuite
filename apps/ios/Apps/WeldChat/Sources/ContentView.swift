import SwiftUI
import WeldCore
import WeldUI

/// WeldChat once signed in, in a workspace and unlocked: Home, Direct
/// messages, Activity and (where the server has calls) Calls, the call over
/// everything, the create screens as sheets.
struct ContentView: View {
    let env: AppEnvironment
    let store: ChatStore
    let calls: CallManager
    let navigator: ChatNavigator
    let person: Person
    let workspace: WorkspaceRef
    let workspaces: [WorkspaceRef]
    @Binding var appearance: AppAppearance

    @Environment(Toaster.self) private var toaster

    var body: some View {
        @Bindable var nav = navigator
        ZStack {
            TabView(selection: $nav.tab) {
                NavigationStack(path: $nav.homePath) {
                    HomeView(env: env, store: store, person: person, workspace: workspace, workspaces: workspaces)
                        .chatDestinations(env: env, store: store, person: person, workspace: workspace, workspaces: workspaces, appearance: $appearance)
                }
                .tabItem { Label(ChatStrings.tabsHome, systemImage: "house") }
                .tag(ChatTab.home)
                .accessibilityIdentifier("tab-home")

                NavigationStack(path: $nav.dmsPath) {
                    DmsView(env: env, store: store, person: person)
                        .chatDestinations(env: env, store: store, person: person, workspace: workspace, workspaces: workspaces, appearance: $appearance)
                }
                .tabItem { Label(ChatStrings.tabsDirectMessages, systemImage: "bubble.left.and.bubble.right") }
                .tag(ChatTab.dms)
                .accessibilityIdentifier("tab-dms")

                NavigationStack(path: $nav.activityPath) {
                    ActivityView(env: env, store: store, person: person)
                        .chatDestinations(env: env, store: store, person: person, workspace: workspace, workspaces: workspaces, appearance: $appearance)
                }
                .tabItem { Label(ChatStrings.tabsActivity, systemImage: "at") }
                .badge(store.activityUnread)
                .tag(ChatTab.activity)
                .accessibilityIdentifier("tab-activity")

                // Calls need the server's video provider.
                if env.isAvailable("chat-calls") {
                    NavigationStack(path: $nav.callsPath) {
                        CallsView(env: env, manager: calls) { channelID, name, isDM in
                            navigator.openConversation(channelID: channelID, name: name, type: isDM ? "dm" : nil)
                        }
                        .chatDestinations(env: env, store: store, person: person, workspace: workspace, workspaces: workspaces, appearance: $appearance)
                    }
                    .tabItem { Label(ChatStrings.tabsCalls, systemImage: "phone") }
                    .tag(ChatTab.calls)
                    .accessibilityIdentifier("tab-calls")
                }
            }

            CallOverlay(manager: calls) { channelID, isDirect in
                navigator.openConversation(channelID: channelID, type: isDirect ? "dm" : nil)
            }
        }
        .sheet(item: $nav.sheet) { sheet in
            sheetView(sheet)
        }
        .task(id: "\(workspace.id):\(person.id)") {
            store.use(workspace: workspace.id, userID: person.id)
            navigator.homePath = []
            navigator.dmsPath = []
            navigator.activityPath = []
            navigator.callsPath = []
            await store.loadHome()
            await store.loadRoster()
            await store.loadActivityUnread()
            if env.isAvailable("chat-calls") { await calls.start(person: person, workspace: workspace) }
            if let tap = env.takePushTap() { route(tap) }
        }
        .task(id: person.id) { await followPersonalEvents() }
        .onChange(of: PushCenter.shared.pendingTap) { _, tap in
            guard tap != nil, let payload = env.takePushTap() else { return }
            route(payload)
        }
        .onOpenURL { url in
            guard let link = DeepLink.parse(url) else { return }
            open(link)
        }
    }

    @ViewBuilder
    private func sheetView(_ sheet: ChatSheet) -> some View {
        switch sheet {
        case let .newChannel(sectionID):
            NewChannelView(store: store, person: person, workspace: workspace, initialSectionID: sectionID)
        case .newCategory:
            NewCategoryView(store: store)
        case let .newDm(group):
            NewDmView(store: store, person: person, isGroup: group)
        case .newMessage:
            NewMessageView(env: env, store: store, person: person)
        case let .invitePeople(channelID, name):
            InvitePeopleView(store: store, channelID: channelID, name: name)
        }
    }

    /// `chat.user.<id>` (new channels and DMs, unread counts, calls) and
    /// `notification.<id>` (in-app notifications): reload Home's lists, the
    /// Activity badge and the record chat groups that moved.
    private func followPersonalEvents() async {
        guard let realtime = env.realtime else { return }
        var pending: Task<Void, Never>?
        for await event in realtime.events(["chat.user.\(person.id)", "notification.\(person.id)"]) {
            if event.topic.hasPrefix("notification."), event.event != "created", !event.isResync { continue }
            let channelID = event.decode(EventChannelRef.self)?.channelId
            let records = Set(store.recordRows.values.flatMap { $0 }.map(\.id))
            let known = Set(store.channels.map(\.id) + store.dms.map(\.id))
            switch RecordChatRules.refresh(for: event.isResync ? nil : event.event, channelID: channelID, recordChatIDs: records, channelIDs: known) {
            case .all: store.refreshRecordChats(.all)
            case .summary: store.refreshRecordChats(.summary)
            case .none: break
            }
            // A busy chat sends an event per message: reload once per burst.
            pending?.cancel()
            pending = Task {
                try? await Task.sleep(for: .milliseconds(300))
                guard !Task.isCancelled else { return }
                await store.loadHome()
                await store.loadActivityUnread()
            }
        }
    }

    /// A tapped notification: the ring, or the conversation it is about.
    private func route(_ payload: PushPayload) {
        switch PushRoute.of(payload.values) {
        case .incomingCall:
            calls.presentIncoming(payload)
        case let .conversation(channelID, isDM):
            navigator.openConversation(channelID: channelID, type: isDM ? "dm" : nil)
        case .none:
            break
        }
    }

    private func open(_ link: DeepLink) {
        switch link {
        case let .channel(id): navigator.openConversation(channelID: id)
        case let .dm(id): navigator.openConversation(channelID: id, type: "dm")
        case let .user(id): navigator.open(.member(userID: id))
        case let .thread(messageID, channelID): navigator.open(.thread(messageID: messageID, channelID: channelID, draft: nil))
        case .search: navigator.open(.search)
        case .records: navigator.open(.records(type: nil))
        case .drafts: navigator.open(.drafts)
        case .saved: navigator.open(.saved)
        case .settings: navigator.open(.settings)
        }
    }
}

/// The channel an event on the personal topic is about.
struct EventChannelRef: Decodable {
    let channelId: String?
}
