import SwiftUI
import WeldCore
import WeldUI

/// Record chats: every chat on a company, person, task, project, … you may
/// read, not only the five per type Home shows. The title picks the record
/// type; chips filter (Following, Unread, Mentions, All); search; more as
/// you scroll. Swipe a row to follow, unfollow or mute it; hold for its menu.
struct RecordsView: View {
    let env: AppEnvironment
    let store: ChatStore
    let person: Person

    @Environment(ChatNavigator.self) private var navigator
    @Environment(Toaster.self) private var toaster

    @State private var type: String?
    @State private var filter: RecordsFilter = .following
    @State private var query = ""
    @State private var search = ""
    @State private var rows: [RecordChat] = []
    @State private var cursor: String?
    @State private var hasMore = false
    @State private var loading = true
    @State private var loadingMore = false
    @State private var failed = false
    /// Each first-page load gets a number; answers to an older one are dropped.
    @State private var request = 0

    init(env: AppEnvironment, store: ChatStore, person: Person, initialType: String?) {
        self.env = env
        self.store = store
        self.person = person
        _type = State(initialValue: RecordsRules.initialType(initialType))
    }

    private struct ListKey: Equatable {
        var type: String?
        var filter: RecordsFilter
        var search: String
    }

    var body: some View {
        List {
            Section {
                ChatSearchField(placeholder: ChatStrings.recordChatsSearchPlaceholder, text: $query, identifier: "records-search")
                    .listRowSeparator(.hidden)
                ChipRow(
                    items: RecordsFilter.allCases,
                    selected: filter,
                    title: { $0.label },
                    symbol: { _ in nil },
                    identifier: { "records-filter-\($0.rawValue)" },
                    onSelect: { filter = $0 }
                )
                .listRowSeparator(.hidden)
            }

            if loading, rows.isEmpty {
                ProgressView().frame(maxWidth: .infinity).listRowSeparator(.hidden)
            } else if rows.isEmpty {
                VStack(spacing: Tokens.Spacing.m) {
                    Text(failed ? ChatStrings.recordChatsLoadFailed : RecordsRules.emptyText(filter: filter, search: search))
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                    if failed {
                        Button(CoreStrings.commonTryAgain) { Task { await loadFirst() } }
                            .accessibilityIdentifier("retry")
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, Tokens.Spacing.xl)
                .listRowSeparator(.hidden)
            } else {
                ForEach(rows) { chat in
                    recordRow(chat)
                        .onAppear {
                            if chat.id == rows.last?.id { Task { await loadMore() } }
                        }
                }
                if loadingMore {
                    ProgressView().frame(maxWidth: .infinity).listRowSeparator(.hidden)
                }
            }
        }
        .listStyle(.plain)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) { typeMenu }
        }
        .refreshable { await loadFirst() }
        // Also on coming back from a chat, which has moved its read marker.
        .task(id: ListKey(type: type, filter: filter, search: search)) { await loadFirst() }
        // Typing pauses before the search runs.
        .task(id: query) {
            let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
            guard trimmed != search else { return }
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            search = trimmed
        }
        .task(id: person.id) { await followEvents() }
    }

    // MARK: Parts

    private var typeMenu: some View {
        let title = type.map(RecordChatRules.groupLabel) ?? ChatStrings.recordChatsTitle
        return Menu {
            Button {
                type = nil
            } label: {
                if type == nil {
                    Label(ChatStrings.recordChatsAllTypes, systemImage: "checkmark")
                } else {
                    Text(ChatStrings.recordChatsAllTypes)
                }
            }
            ForEach(RecordChatRules.types, id: \.self) { option in
                Button {
                    type = option
                } label: {
                    Label(RecordChatRules.groupLabel(option), systemImage: option == type ? "checkmark" : RecordChatRules.symbol(option))
                }
            }
        } label: {
            HStack(spacing: 4) {
                Text(title).font(.inter(.headline)).foregroundStyle(.primary).lineLimit(1)
                Image(systemName: "chevron.down").font(.inter(.caption, weight: .semibold)).foregroundStyle(.secondary)
            }
        }
        .accessibilityLabel("\(title), \(ChatStrings.recordChatsChooseType)")
        .accessibilityIdentifier("records-type")
    }

    private func recordRow(_ chat: RecordChat) -> some View {
        Button {
            navigator.openConversation(channelID: chat.id, name: chat.displayName, type: "entity", entityType: chat.entityType)
        } label: {
            RecordsRow(chat: chat, showType: type == nil) { toggleFollow(chat) }
        }
        .buttonStyle(.plain)
        .swipeActions(edge: .leading, allowsFullSwipe: false) {
            Button {
                toggleFollow(chat)
            } label: {
                Label(
                    chat.isFollowing ? ChatStrings.recordChatsUnfollow : ChatStrings.recordChatsFollow,
                    systemImage: chat.isFollowing ? "person.badge.minus" : "plus"
                )
            }
            .tint(chat.isFollowing ? .gray : Tokens.Palette.primary)
            if chat.isFollowing {
                Button {
                    toggleMute(chat)
                } label: {
                    Label(chat.isMuted ? ChatStrings.recordChatsUnmute : ChatStrings.recordChatsMute, systemImage: chat.isMuted ? "bell" : "bell.slash")
                }
                .tint(.orange)
            }
        }
        .conversationMenu(.record(chat), store: store) { id, patch in
            patchRow(id, patch)
            // Home's record chat groups follow.
            if patch.isFollowing != nil {
                store.refreshRecordChats(.all)
            } else if let muted = patch.isMuted {
                store.patchRecordChat(id, RecordChatPatch(isMuted: muted))
            } else if patch.hasUnread == false {
                store.patchRecordChat(id, RecordChatPatch(markRead: true))
            }
        }
        .accessibilityIdentifier("record-row-\(chat.id)")
    }

    // MARK: Loading

    private func loadFirst() async {
        request += 1
        let mine = request
        loading = true
        failed = false
        do {
            let page = try await store.listRecordChats(
                type: type,
                filter: filter.rawValue,
                search: search.isEmpty ? nil : search,
                cursor: nil,
                limit: RecordsRules.pageSize
            )
            guard mine == request else { return }
            rows = page.items
            cursor = page.cursor
            hasMore = page.hasMore
        } catch {
            guard mine == request else { return }
            failed = true
        }
        loading = false
    }

    private func loadMore() async {
        guard hasMore, let next = cursor, !loading, !loadingMore else { return }
        let mine = request
        loadingMore = true
        defer { loadingMore = false }
        guard let page = try? await store.listRecordChats(
            type: type,
            filter: filter.rawValue,
            search: search.isEmpty ? nil : search,
            cursor: next,
            limit: RecordsRules.pageSize
        ), mine == request else { return }
        rows = RecordChatRules.uniqueRows([rows, page.items])
        cursor = page.cursor
        hasMore = page.hasMore
    }

    /// New follows, and messages in the chats listed, reload the first page once per burst.
    private func followEvents() async {
        guard let realtime = env.realtime else { return }
        var pending: Task<Void, Never>?
        for await event in realtime.events(["chat.user.\(person.id)"]) {
            let channelID = event.decode(EventChannelRef.self)?.channelId
            guard event.isResync || RecordsRules.isRelevant(event: event.event, channelID: channelID, rows: rows) else { continue }
            pending?.cancel()
            pending = Task {
                try? await Task.sleep(for: .milliseconds(400))
                guard !Task.isCancelled else { return }
                await loadFirst()
            }
        }
        pending?.cancel()
    }

    // MARK: Changes

    private func patchRow(_ id: String, _ patch: ConversationPatch) {
        let listed = rows.contains { $0.id == id }
        rows = RecordsRules.apply(patch, to: rows, id: id, filter: filter, now: Date())
        if RecordsRules.needsReload(patch, rowListed: listed) { Task { await loadFirst() } }
    }

    private func toggleFollow(_ chat: RecordChat) {
        let next = !chat.isFollowing
        store.forgetMembership(chat.id)
        patchRow(chat.id, ConversationPatch(isFollowing: next))
        Task {
            do {
                try await store.setFollowing(entityType: chat.entityType, entityID: chat.entityID, following: next)
                store.refreshRecordChats(.all)
            } catch {
                patchRow(chat.id, ConversationPatch(isFollowing: !next))
                toaster.show(next ? ChatStrings.recordChatsFollowFailed : ChatStrings.recordChatsUnfollowFailed)
            }
        }
    }

    private func toggleMute(_ chat: RecordChat) {
        guard chat.isFollowing else { return }
        let next = !chat.isMuted
        patchRow(chat.id, ConversationPatch(isMuted: next))
        Task {
            do {
                try await store.updateMembership(channelID: chat.id, isMuted: next)
                store.patchRecordChat(chat.id, RecordChatPatch(isMuted: next))
            } catch {
                patchRow(chat.id, ConversationPatch(isMuted: !next))
                toaster.show(ChatStrings.recordChatsMuteFailed)
            }
        }
    }
}

/// A record chat row: the type's icon, the record's name, the time, the
/// preview (after the type when every type is listed), muted, mentions, and
/// Follow for a chat you don't follow.
struct RecordsRow: View {
    let chat: RecordChat
    let showType: Bool
    let onFollow: () -> Void

    var body: some View {
        let highlighted = RecordsRules.isHighlighted(chat)
        HStack(spacing: Tokens.Spacing.m) {
            Image(systemName: RecordChatRules.symbol(chat.entityType))
                .font(.inter(.subheadline))
                .frame(width: 36, height: 36)
                .background(Tokens.Palette.muted, in: RoundedRectangle(cornerRadius: Tokens.Radius.small))
            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text(chat.displayName)
                        .font(.inter(.subheadline, weight: highlighted ? .semibold : .regular))
                        .lineLimit(1)
                    Spacer(minLength: Tokens.Spacing.s)
                    let time = ChatDates.listTime(chat.lastMessageAt)
                    if !time.isEmpty {
                        Text(time).font(.inter(.caption)).foregroundStyle(.secondary)
                    }
                }
                HStack(spacing: Tokens.Spacing.s) {
                    Text(RecordsRules.subtitle(chat, showType: showType))
                        .font(.inter(.subheadline))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    if chat.isMuted {
                        Image(systemName: "bell.slash").font(.inter(.caption)).foregroundStyle(.secondary)
                    }
                    if chat.unreadMentionCount > 0 { CountBadge(count: chat.unreadMentionCount) }
                    if !chat.isFollowing {
                        Button(ChatStrings.recordChatsFollow, action: onFollow)
                            .buttonStyle(.bordered)
                            .controlSize(.mini)
                            .accessibilityLabel("\(ChatStrings.recordChatsFollow) \(chat.displayName)")
                            .accessibilityIdentifier("records-follow-\(chat.id)")
                    }
                }
            }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
    }
}
