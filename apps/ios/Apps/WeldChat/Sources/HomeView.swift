import SwiftUI
import WeldCore
import WeldUI

/// Home: the workspace (tap to switch), search, Calls / Saved / Drafts,
/// what is unread, the channel sections, the record chats followed (one
/// group per type) and the latest direct messages; the compose button.
struct HomeView: View {
    let env: AppEnvironment
    let store: ChatStore
    let person: Person
    let workspace: WorkspaceRef
    let workspaces: [WorkspaceRef]

    @Environment(ChatNavigator.self) private var navigator
    @Environment(CallManager.self) private var calls
    @State private var collapsed: Set<String> = []
    @State private var liveCallCount: Int?

    var body: some View {
        let groups = ChatLogic.groupSections(channels: store.channels, sections: store.sections, defaultName: ChatStrings.homeChannelsGroup)
        let recordRows = RecordChatRules.types.flatMap { store.recordRows[$0] ?? [] }
        let recordGroups = RecordChatRules.groups(
            summary: store.recordSummary,
            rows: store.recordRows,
            isCollapsed: { collapsed.contains("record:\($0)") },
            now: Date()
        )
        let followsRecords = (store.recordSummary ?? []).contains { $0.followed > 0 }
        let unreadDms = DmLogic.recent(store.dms).filter { $0.hasUnread && !$0.isMuted }
        let unreadChannels = store.channels.filter(ChatLogic.isChannelUnread)
        let unreadRecords = recordRows.filter(RecordChatRules.needsAttention)
            .sorted { DmLogic.time($0.lastMessageAt) > DmLogic.time($1.lastMessageAt) }
        let unreadTotal = unreadDms.count + unreadChannels.count + unreadRecords.count
        let recentDms = Array(DmLogic.recent(store.dms).prefix(ChatLogic.recentDmCount))
        let showEmpty = store.homeLoaded && store.channels.isEmpty && store.dms.isEmpty && !followsRecords

        List {
            Section {
                SearchButton { navigator.open(.search) }
                    .accessibilityIdentifier("home-search")
                    .listRowSeparator(.hidden)
                tiles
                    .listRowSeparator(.hidden)
            }

            if !store.homeLoaded, store.channels.isEmpty {
                ProgressView().frame(maxWidth: .infinity).listRowSeparator(.hidden)
            } else if showEmpty {
                emptyState.listRowSeparator(.hidden)
            } else {
                if unreadTotal > 0 {
                    Section {
                        ForEach(unreadDms) { dm in dmRow(dm) }
                        ForEach(unreadChannels) { channel in channelRow(channel) }
                        ForEach(unreadRecords) { chat in recordRow(chat) }
                    } header: {
                        header(ChatStrings.homeUnreads, count: unreadTotal)
                    }
                }

                ForEach(groups, id: \.id) { group in
                    Section {
                        if !collapsed.contains(group.id) {
                            ForEach(group.channels) { channel in channelRow(channel) }
                        }
                    } header: {
                        collapsibleHeader(group.name, key: group.id)
                            .contextMenu {
                                Button {
                                    navigator.sheet = .newChannel(sectionID: group.id == ChatLogic.unsectionedID ? nil : group.id)
                                } label: {
                                    Label(ChatStrings.homeCreateChannel, systemImage: "plus")
                                }
                            }
                            .accessibilityIdentifier("section-\(group.id)")
                    }
                }

                ForEach(recordGroups, id: \.type) { group in
                    Section {
                        ForEach(group.rows) { chat in recordRow(chat) }
                        if group.showAll {
                            linkRow(ChatStrings.recordChatsShowAll(count: group.followed)) {
                                navigator.open(.records(type: group.type))
                            }
                        }
                    } header: {
                        collapsibleHeader(
                            RecordChatRules.groupLabel(group.type),
                            key: "record:\(group.type)",
                            count: group.unread > 0 ? group.unread : nil,
                            mentions: group.mentions
                        )
                    }
                }

                if followsRecords {
                    Section {
                        linkRow(ChatStrings.recordChatsTitle) { navigator.open(.records(type: nil)) }
                            .accessibilityIdentifier("home-records")
                    }
                }

                if !recentDms.isEmpty {
                    Section {
                        ForEach(recentDms) { dm in dmRow(dm) }
                    } header: {
                        HStack {
                            Text(ChatStrings.tabsDirectMessages)
                            Spacer()
                            Button {
                                navigator.tab = .dms
                            } label: {
                                HStack(spacing: 2) {
                                    Text(ChatStrings.homeSeeAll)
                                    Image(systemName: "chevron.right")
                                }
                                .font(.footnote)
                            }
                            .accessibilityIdentifier("home-see-all-dms")
                        }
                    }
                }
            }
        }
        .listStyle(.plain)
        .refreshable { await reload() }
        .task { await reload() }
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { workspaceMenu }
        }
        .navigationBarTitleDisplayMode(.inline)
        .overlay(alignment: .bottomTrailing) { composeButton }
    }

    private func reload() async {
        await store.loadHome()
        store.refreshRecordChats(.all, immediate: true)
        await store.loadCounts()
        if env.isAvailable("chat-calls") { liveCallCount = calls.activeChannelCalls.count }
    }

    // MARK: Parts

    private var workspaceMenu: some View {
        Menu {
            Section(person.email ?? person.name ?? "") {
                Button {
                    navigator.open(.settings)
                } label: {
                    Label(ChatStrings.homeProfileAndSettings, systemImage: "gearshape")
                }
                .accessibilityIdentifier("home-settings")
            }
            if workspaces.count > 1 {
                Section(ChatStrings.homeSwitchWorkspace) {
                    ForEach(workspaces) { option in
                        Button {
                            if option.id != workspace.id { env.chooseWorkspace(option.id) }
                        } label: {
                            if option.id == workspace.id {
                                Label(option.name, systemImage: "checkmark")
                            } else {
                                Text(option.name)
                            }
                        }
                    }
                }
            }
        } label: {
            HStack(spacing: Tokens.Spacing.s) {
                Text(String(workspace.name.prefix(1)).uppercased())
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(.white)
                    .frame(width: 28, height: 28)
                    .background(Tokens.Brand.weldchat, in: RoundedRectangle(cornerRadius: 7))
                Text(workspace.name.isEmpty ? ChatStrings.homeWorkspaceFallback : workspace.name)
                    .font(.headline)
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                Image(systemName: "chevron.down").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            }
        }
        .accessibilityLabel("\(workspace.name), \(ChatStrings.homeSwitchWorkspace)")
        .accessibilityIdentifier("home-workspace")
    }

    private var tiles: some View {
        HStack(spacing: Tokens.Spacing.s) {
            if env.isAvailable("chat-calls") {
                tile(
                    ChatStrings.tabsCalls,
                    symbol: "phone",
                    subtitle: liveCallCount.map { ChatStrings.homeLiveCount($0) },
                    id: "home-tile-calls"
                ) { navigator.tab = .calls }
            }
            tile(
                ChatStrings.homeSaved,
                symbol: "bookmark",
                subtitle: ChatLogic.countLabel(store.savedCount, cap: ChatLogic.savedCap, plural: ChatStrings.homeItemCount, capped: { ChatStrings.homeItemCountCapped(count: $0) }),
                id: "home-tile-saved"
            ) { navigator.open(.saved) }
            tile(
                ChatStrings.homeDrafts,
                symbol: "paperplane",
                subtitle: ChatLogic.countLabel(store.draftCount, plural: ChatStrings.homeItemCount, capped: { ChatStrings.homeItemCountCapped(count: $0) }),
                id: "home-tile-drafts"
            ) { navigator.open(.drafts) }
        }
    }

    private func tile(_ title: String, symbol: String, subtitle: String?, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Image(systemName: symbol).font(.subheadline)
                    Text(title).font(.subheadline.weight(.semibold)).lineLimit(1).minimumScaleFactor(0.85)
                }
                Text(subtitle ?? " ").font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(Tokens.Spacing.m)
            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: Tokens.Radius.medium))
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(id)
    }

    private var emptyState: some View {
        VStack(spacing: Tokens.Spacing.m) {
            Image(systemName: "bubble.left.and.text.bubble.right")
                .font(.system(size: 54))
                .foregroundStyle(.secondary)
            Text(ChatStrings.homeEmptyTitle).font(.title3.weight(.semibold))
            Text(ChatStrings.homeEmptyHint).foregroundStyle(.secondary).multilineTextAlignment(.center)
            Button {
                navigator.sheet = .newChannel(sectionID: nil)
            } label: {
                Label(ChatStrings.homeEmptyCreateChannel, systemImage: "plus").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .accessibilityIdentifier("home-empty-create-channel")
            Button {
                navigator.sheet = .newDm(group: false)
            } label: {
                Label(ChatStrings.homeEmptyStartDm, systemImage: "bubble.left").frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("home-empty-start-dm")
        }
        .padding(.vertical, Tokens.Spacing.xl)
        .frame(maxWidth: .infinity)
    }

    private var composeButton: some View {
        Menu {
            Button {
                navigator.sheet = .newMessage
            } label: {
                Label(ChatStrings.homeComposeMessage, systemImage: "square.and.pencil")
            }
            .accessibilityIdentifier("compose-message")
            Button {
                navigator.sheet = .newChannel(sectionID: nil)
            } label: {
                Label(ChatStrings.homeComposeChannel, systemImage: "number")
                Text(ChatStrings.homeComposeChannelHint)
            }
            .accessibilityIdentifier("compose-channel")
            Button {
                navigator.sheet = .newCategory
            } label: {
                Label(ChatStrings.homeComposeCategory, systemImage: "folder.badge.plus")
                Text(ChatStrings.homeComposeCategoryHint)
            }
            .accessibilityIdentifier("compose-category")
        } label: {
            Image(systemName: "square.and.pencil")
                .font(.system(size: 22, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 56, height: 56)
                .background(Tokens.Brand.weldchat, in: Circle())
                .shadow(radius: 4, y: 2)
        }
        .accessibilityLabel(ChatStrings.homeNewItem)
        .accessibilityIdentifier("home-compose")
        .padding(Tokens.Spacing.l)
    }

    private func header(_ title: String, count: Int) -> some View {
        HStack(spacing: 6) {
            Text(title)
            CountBadge(count: count)
        }
    }

    private func collapsibleHeader(_ title: String, key: String, count: Int? = nil, mentions: Int = 0) -> some View {
        Button {
            if collapsed.contains(key) { collapsed.remove(key) } else { collapsed.insert(key) }
        } label: {
            HStack(spacing: 6) {
                Text(title).lineLimit(1)
                if let count { CountBadge(count: count) }
                if mentions > 0 { CountBadge(count: mentions, prefix: "@") }
                Image(systemName: "chevron.down")
                    .font(.caption2.weight(.bold))
                    .rotationEffect(.degrees(collapsed.contains(key) ? -90 : 0))
                Spacer()
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(.isHeader)
    }

    private func linkRow(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: Tokens.Spacing.m) {
                Image(systemName: "ellipsis").frame(width: 22).foregroundStyle(.secondary)
                Text(title).foregroundStyle(.secondary)
                Spacer()
                Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: Rows

    private func channelRow(_ channel: ChatChannel) -> some View {
        Button {
            navigator.openConversation(channelID: channel.id, name: channel.name, type: channel.type)
        } label: {
            ChannelRowView(channel: channel)
        }
        .buttonStyle(.plain)
        .conversationMenu(.channel(channel), store: store) { id, patch in
            store.patchChannel(id, patch)
            if patch.hasUnread == true { Task { await store.loadHome() } }
        }
        .accessibilityIdentifier("channel-row-\(channel.id)")
    }

    private func dmRow(_ dm: DmConversation) -> some View {
        Button {
            navigator.openConversation(channelID: dm.id, name: dm.name, type: "dm")
        } label: {
            DmCompactRow(dm: dm)
        }
        .buttonStyle(.plain)
        .conversationMenu(.dm(dm), store: store) { id, patch in
            if patch.archived == false {
                Task { await store.loadHome() }
                return
            }
            store.patchDm(id, patch)
        }
        .accessibilityIdentifier("dm-row-\(dm.id)")
    }

    private func recordRow(_ chat: RecordChat) -> some View {
        Button {
            navigator.openConversation(channelID: chat.id, name: chat.displayName, type: "entity", entityType: chat.entityType)
        } label: {
            RecordChatRowView(chat: chat)
        }
        .buttonStyle(.plain)
        .conversationMenu(.record(chat), store: store) { id, patch in
            // Undoing a failed unfollow or mark-read: load what the server has.
            if patch.isFollowing == true || patch.hasUnread == true {
                store.refreshRecordChats(.all, immediate: true)
                return
            }
            store.patchRecordChat(id, RecordChatPatch(isMuted: patch.isMuted, markRead: patch.hasUnread == false, unfollowed: patch.isFollowing == false))
        }
        .accessibilityIdentifier("record-row-\(chat.id)")
    }
}
