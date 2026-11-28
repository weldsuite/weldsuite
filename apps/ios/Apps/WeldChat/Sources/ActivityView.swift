import SwiftUI
import WeldCore
import WeldUI

/// Activity, as the platform's: what asks for your attention (mentions,
/// replies in your threads, missed calls; a DM's messages show in the DM),
/// grouped by kind; unread rows washed blue with a bar. A tap marks it read
/// and opens the conversation.
struct ActivityView: View {
    let env: AppEnvironment
    let store: ChatStore
    let person: Person

    @Environment(ChatNavigator.self) private var navigator
    @State private var state = LoadState<[ActivityNotification]>()

    var body: some View {
        let names = store.memberNames
        let groups = grouped(state.data ?? [])
        List {
            if state.isFirstLoad {
                ProgressView().frame(maxWidth: .infinity).listRowSeparator(.hidden)
            } else if state.data == nil {
                LoadErrorView(error: state.error) { await load() }
                    .listRowSeparator(.hidden)
            } else if groups.isEmpty {
                ChatEmptyState(title: ChatStrings.activityEmptyTitle, description: ChatStrings.activityEmptyHint, symbol: "at")
                    .listRowSeparator(.hidden)
            } else {
                ForEach(groups, id: \.category) { group in
                    Section {
                        ForEach(group.items) { item in
                            Button {
                                open(item)
                            } label: {
                                ActivityRow(item: item, names: names, roster: store.roster, dms: store.dms)
                            }
                            .buttonStyle(.plain)
                            .listRowInsets(EdgeInsets())
                            .listRowBackground(item.isRead ? Tokens.Palette.background : ChatColors.activityUnread)
                            .listRowSeparatorTint(Tokens.Palette.border.opacity(0.7))
                            .accessibilityIdentifier("activity-row-\(item.id)")
                        }
                    } header: {
                        ListGroupHeader(label: Self.label(group.category), count: group.items.count)
                            .listRowInsets(EdgeInsets())
                    }
                }
            }
        }
        .listStyle(.plain)
        .environment(\.defaultMinListRowHeight, 0)
        .navigationTitle(ChatStrings.tabsActivity)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    markAllRead()
                } label: {
                    Image(systemName: "checkmark.circle")
                }
                .disabled(!(state.data ?? []).contains { !$0.isRead })
                .accessibilityLabel(ChatStrings.activityMarkAllRead)
                .accessibilityIdentifier("activity-mark-all-read")
            }
        }
        .refreshable { await load() }
        .task {
            await store.loadRosterIfNeeded()
            await load()
        }
        .realtimeRefresh(env, topics: ["chat.user.\(person.id)", "notification.\(person.id)"]) { await load() }
    }

    private func load() async {
        state.loading = true
        do {
            let rows = try await store.listActivity()
            state = LoadState(data: rows.filter { ChatLogic.isActivityItem(category: $0.category, type: $0.notificationType) })
        } catch {
            state = LoadState(data: state.data, error: APIError.from(error))
        }
        await store.loadActivityUnread()
    }

    /// The platform's groups, in its order, empty ones left out.
    private func grouped(_ items: [ActivityNotification]) -> [ActivitySection] {
        ChatLogic.ActivityCategory.allCases.compactMap { category in
            let rows = items.filter { ChatLogic.activityCategory($0.notificationType) == category }
            return rows.isEmpty ? nil : ActivitySection(category: category, items: rows)
        }
    }

    static func label(_ category: ChatLogic.ActivityCategory) -> String {
        switch category {
        case .mentions: ChatStrings.activityMentions
        case .replies: ChatStrings.activityReplies
        case .calls: ChatStrings.activityMissedCalls
        case .other: ChatStrings.activityOther
        }
    }

    private func open(_ item: ActivityNotification) {
        if !item.isRead {
            state.data = state.data?.map { $0.id == item.id ? read($0) : $0 }
            store.setActivityUnread(max(0, store.activityUnread - 1))
            Task { try? await store.markActivityRead(item.id) }
        }
        if let target = ChatLogic.conversation(fromActionURL: item.actionURL) {
            navigator.openConversation(channelID: target.channelID, type: target.isDM ? "dm" : nil)
        } else if let channelID = item.channelID {
            let isDM = store.dms.contains { $0.id == channelID }
            navigator.openConversation(channelID: channelID, name: item.channelName, type: isDM ? "dm" : nil)
        }
    }

    private func markAllRead() {
        state.data = state.data?.map(read)
        store.setActivityUnread(0)
        Task { try? await store.markAllActivityRead() }
    }

    private func read(_ item: ActivityNotification) -> ActivityNotification {
        var next = item
        next.isRead = true
        return next
    }
}

/// One activity row, as the platform's: the actor's small avatar with the
/// kind's icon in its corner, the title (mentions as chips; medium while
/// unread), the message under it, and when.
private struct ActivityRow: View {
    let item: ActivityNotification
    let names: [String: String]
    let roster: [TeamMember]
    let dms: [DmConversation]

    var body: some View {
        let category = ChatLogic.activityCategory(item.notificationType)
        // The feed names nobody: the actor from the workspace's people, as the platform does.
        let actor = item.actorID.flatMap { id in roster.first { $0.userID == id } }
        let actorName = item.actorName ?? actor?.displayName
        let actorAvatar = item.actorAvatar ?? actor?.picture
        // "in #channel" after the title; a DM is named after the person, not shown.
        let inChannel = item.channelName.flatMap { name in
            name.isEmpty || dms.contains(where: { $0.id == item.channelID }) ? nil : ChatStrings.activityInChannel(name: name)
        }
        // A missed call's body is the push's "Tap to call back": the row itself does that.
        let detail = (item.body ?? "").isEmpty || category == .calls ? nil : item.body
        HStack(alignment: detail == nil ? .center : .top, spacing: 10) {
            ChatAvatar(name: actorName ?? "?", url: actorAvatar, size: 26)
                .overlay(alignment: .bottomTrailing) {
                    Image(systemName: Self.symbol(category))
                        .font(.system(size: 7, weight: .bold))
                        .foregroundStyle(Tokens.Palette.foreground)
                        .frame(width: 14, height: 14)
                        .background(Tokens.Palette.background, in: Circle())
                        .offset(x: 3, y: 3)
                }
                .padding(.top, detail == nil ? 0 : 1)
            VStack(alignment: .leading, spacing: 2) {
                (
                    Text(MessageTextStyle.attributed(item.title, names: names))
                        .font(.inter(.subheadline, weight: item.isRead ? .regular : .medium))
                        .foregroundColor(item.isRead ? Tokens.Palette.foreground.opacity(0.8) : Tokens.Palette.foreground)
                    + Text(inChannel.map { " \($0)" } ?? "")
                        .font(.inter(.subheadline))
                        .foregroundColor(Tokens.Palette.mutedForeground)
                )
                .lineLimit(1)
                if let detail {
                    Text(MessageTextStyle.attributed(detail, names: names))
                        .font(.inter(.caption))
                        .foregroundStyle(Tokens.Palette.mutedForeground)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
            if let date = WeldDate.parse(item.createdAt) {
                Text(ChatDates.activityTime(date)).font(.inter(.caption)).foregroundStyle(Tokens.Palette.mutedForeground)
            }
        }
        .padding(.horizontal, Tokens.Spacing.l)
        .padding(.vertical, Tokens.Spacing.m)
        .overlay(alignment: .leading) {
            if !item.isRead { Rectangle().fill(ChatColors.activityBar).frame(width: 2) }
        }
        .contentShape(Rectangle())
    }

    static func symbol(_ category: ChatLogic.ActivityCategory) -> String {
        switch category {
        case .mentions: "at"
        case .replies: "arrowshape.turn.up.left.fill"
        case .calls: "phone.arrow.down.left"
        case .other: "person.fill"
        }
    }
}

/// A group of Activity.
private struct ActivitySection {
    let category: ChatLogic.ActivityCategory
    let items: [ActivityNotification]
}
