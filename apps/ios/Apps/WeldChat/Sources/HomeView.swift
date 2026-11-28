import SwiftUI
import WeldCore
import WeldUI

/// Home, laid out as the platform's WeldChat sidebar: the workspace (tap to
/// switch), search, the top rows (Calls, Drafts, Record chats, Saved items),
/// what is unread, Direct Messages, the record chats followed (one group per
/// type) and the channel sections, each with "Add channel" while empty; the
/// compose button.
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
        let groups = ChatLogic.groupSections(
            channels: store.channels,
            sections: store.sections,
            defaultName: ChatStrings.homeChannelsGroup,
            otherName: ChatStrings.homeOtherChannelsGroup
        )
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

        List {
            Section {
                SearchButton { navigator.open(.search) }
                    .accessibilityIdentifier("home-search")
                    .sidebarListRow()
                    .padding(.vertical, Tokens.Spacing.xs)
                navRows
            }

            if !store.homeLoaded, store.channels.isEmpty {
                ProgressView().frame(maxWidth: .infinity)
            } else {
                if unreadTotal > 0 {
                    Section {
                        ForEach(unreadDms) { dm in dmRow(dm) }
                        ForEach(unreadChannels) { channel in channelRow(channel) }
                        ForEach(unreadRecords) { chat in recordRow(chat) }
                    } header: {
                        SidebarGroupHeader(title: ChatStrings.homeUnreads, unread: unreadTotal)
                    }
                }

                // Direct Messages, always, as on the platform.
                Section {
                    if recentDms.isEmpty {
                        AddPlaceholderRow(label: ChatStrings.homeEmptyStartDm) { navigator.sheet = .newDm(group: false) }
                            .sidebarListRow()
                            .accessibilityIdentifier("home-empty-start-dm")
                    } else {
                        ForEach(recentDms) { dm in dmRow(dm) }
                    }
                } header: {
                    SidebarGroupHeader(title: ChatStrings.tabsDirectMessages) {
                        Button {
                            navigator.tab = .dms
                        } label: {
                            HStack(spacing: 2) {
                                Text(ChatStrings.homeSeeAll)
                                Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold))
                            }
                            .font(.inter(.caption, weight: .medium))
                            .foregroundStyle(Tokens.Palette.mutedForeground)
                            .padding(.vertical, 6)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("home-see-all-dms")
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
                        Button {
                            toggle("record:\(group.type)")
                        } label: {
                            SidebarGroupHeader(
                                title: RecordChatRules.groupLabel(group.type),
                                collapsed: group.collapsed,
                                unread: group.unread,
                                mentions: group.mentions
                            )
                        }
                        .buttonStyle(.plain)
                    }
                }

                ForEach(groups, id: \.id) { group in
                    let isCollapsed = collapsed.contains(group.id)
                    Section {
                        if !isCollapsed {
                            if group.channels.isEmpty {
                                AddPlaceholderRow(label: ChatStrings.homeAddChannel) {
                                    navigator.sheet = .newChannel(sectionID: group.id == ChatLogic.unsectionedID ? nil : group.id)
                                }
                                .sidebarListRow()
                                .accessibilityIdentifier("home-add-channel-\(group.id)")
                            } else {
                                ForEach(group.channels) { channel in channelRow(channel) }
                            }
                        }
                    } header: {
                        Button {
                            toggle(group.id)
                        } label: {
                            SidebarGroupHeader(
                                title: group.name,
                                collapsed: isCollapsed,
                                unread: group.channels.filter(ChatLogic.isChannelUnread).count,
                                mentions: group.channels.reduce(0) { $0 + $1.unreadMentionCount }
                            )
                        }
                        .buttonStyle(.plain)
                        .contextMenu {
                            Button {
                                navigator.sheet = .newChannel(sectionID: group.id == ChatLogic.unsectionedID ? nil : group.id)
                            } label: {
                                Label(ChatStrings.homeAddChannel, systemImage: "plus")
                            }
                        }
                        .accessibilityIdentifier("section-\(group.id)")
                    }
                }
                Color.clear.frame(height: 72).listRowSeparator(.hidden)
            }
        }
        .listStyle(.plain)
        .listRowSeparator(.hidden)
        .listSectionSeparator(.hidden)
        .environment(\.defaultMinListRowHeight, 0)
        .scrollContentBackground(.hidden)
        .background(Tokens.Palette.background)
        .refreshable { await reload() }
        .task { await reload() }
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { workspaceMenu }
        }
        .navigationBarTitleDisplayMode(.inline)
        .overlay(alignment: .bottomTrailing) { composeButton }
    }

    private func toggle(_ key: String) {
        if collapsed.contains(key) { collapsed.remove(key) } else { collapsed.insert(key) }
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
                    .font(.inter(.subheadline, weight: .semibold))
                    .foregroundStyle(Tokens.Palette.primaryForeground)
                    .frame(width: 28, height: 28)
                    .background(Tokens.Palette.primary, in: RoundedRectangle(cornerRadius: Tokens.Radius.medium))
                Text(workspace.name.isEmpty ? ChatStrings.homeWorkspaceFallback : workspace.name)
                    .font(.inter(.headline))
                    .foregroundStyle(Tokens.Palette.foreground)
                    .lineLimit(1)
                Image(systemName: "chevron.down").font(.system(size: 11, weight: .semibold)).foregroundStyle(Tokens.Palette.mutedForeground)
            }
        }
        .accessibilityLabel("\(workspace.name), \(ChatStrings.homeSwitchWorkspace)")
        .accessibilityIdentifier("home-workspace")
    }

    /// The platform sidebar's top rows: Calls, Drafts (with the red count), Record chats, Saved items.
    @ViewBuilder
    private var navRows: some View {
        if env.isAvailable("chat-calls") {
            navRow(ChatStrings.tabsCalls, symbol: "phone", id: "home-tile-calls") {
                navigator.tab = .calls
            } trailing: {
                if let live = liveCallCount, live > 0 {
                    HStack(spacing: 4) {
                        Image(systemName: "phone.fill").font(.system(size: 11))
                        Text(ChatStrings.homeLiveCount(live)).font(.inter(.caption))
                    }
                    .foregroundStyle(ChatColors.callGreen)
                }
            }
        }
        navRow(ChatStrings.homeDrafts, symbol: "square.and.pencil", id: "home-tile-drafts", bold: (store.draftCount ?? 0) > 0) {
            navigator.open(.drafts)
        } trailing: {
            CountBadge(count: store.draftCount ?? 0)
        }
        if (store.recordSummary ?? []).contains(where: { $0.followed > 0 }) {
            navRow(ChatStrings.recordChatsTitle, symbol: "bubble.left.and.bubble.right", id: "home-records") {
                navigator.open(.records(type: nil))
            } trailing: {
                EmptyView()
            }
        }
        navRow(ChatStrings.homeSaved, symbol: "bookmark", id: "home-tile-saved") {
            navigator.open(.saved)
        } trailing: {
            EmptyView()
        }
    }

    private func navRow<Trailing: View>(
        _ title: String,
        symbol: String,
        id: String,
        bold: Bool = false,
        action: @escaping () -> Void,
        @ViewBuilder trailing: () -> Trailing
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 0) {
                SidebarRow(title: title, unread: bold) { SidebarIcon(symbol: symbol, unread: bold) }
                trailing()
            }
        }
        .buttonStyle(.plain)
        .sidebarListRow()
        .accessibilityIdentifier(id)
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
                .font(.system(size: 20, weight: .semibold))
                .foregroundStyle(Tokens.Palette.primaryForeground)
                .frame(width: 56, height: 56)
                .background(Tokens.Palette.primary, in: RoundedRectangle(cornerRadius: Tokens.Radius.xlarge))
                .shadow(color: .black.opacity(0.15), radius: 6, y: 2)
        }
        .accessibilityLabel(ChatStrings.homeNewItem)
        .accessibilityIdentifier("home-compose")
        .padding(Tokens.Spacing.l)
    }

    private func linkRow(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            SidebarRow(title: title, unread: false) { SidebarIcon(symbol: "ellipsis") }
        }
        .buttonStyle(.plain)
        .sidebarListRow()
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
        .sidebarListRow()
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
        .sidebarListRow()
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
        .sidebarListRow()
        .accessibilityIdentifier("record-row-\(chat.id)")
    }
}

private extension View {
    /// A row of Home's list as in the platform's sidebar: no separators, the page's side margins.
    func sidebarListRow() -> some View {
        listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets(top: 0, leading: Tokens.Spacing.l, bottom: 0, trailing: Tokens.Spacing.l))
            .listRowBackground(Tokens.Palette.background)
    }
}
