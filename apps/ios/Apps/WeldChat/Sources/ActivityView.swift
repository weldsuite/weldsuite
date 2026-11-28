import SwiftUI
import WeldCore
import WeldUI

/// Activity: WeldChat's notifications (mentions, thread replies, DMs, missed
/// calls) by day; a tap marks it read and opens the conversation.
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
                ForEach(groups, id: \.title) { group in
                    Section(group.title) {
                        ForEach(group.items) { item in
                            Button {
                                open(item)
                            } label: {
                                ActivityRow(item: item, names: names)
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("activity-row-\(item.id)")
                        }
                    }
                }
            }
        }
        .listStyle(.plain)
        .navigationTitle(ChatStrings.tabsActivity)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    markAllRead()
                } label: {
                    Image(systemName: "envelope.open")
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
            let rows = try await store.listNotifications()
            state = LoadState(data: rows.filter { ChatLogic.isChatNotification(category: $0.category, type: $0.notificationType) })
        } catch {
            state = LoadState(data: state.data, error: APIError.from(error))
        }
        await store.loadActivityUnread()
    }

    private func grouped(_ items: [ActivityNotification]) -> [ActivitySection] {
        var order: [String] = []
        var byTitle: [String: [ActivityNotification]] = [:]
        for item in items {
            guard let date = WeldDate.parse(item.createdAt) else { continue }
            let title = ChatDates.activityGroupLabel(ChatDates.activityGroup(date))
            if byTitle[title] == nil { order.append(title) }
            byTitle[title, default: []].append(item)
        }
        return order.map { ActivitySection(title: $0, items: byTitle[$0] ?? []) }
    }

    private func open(_ item: ActivityNotification) {
        if !item.isRead {
            state.data = state.data?.map { $0.id == item.id ? read($0) : $0 }
            store.setActivityUnread(max(0, store.activityUnread - 1))
            Task { try? await store.markNotificationRead(item.id) }
        }
        if let target = ChatLogic.conversation(fromActionURL: item.actionURL) {
            navigator.openConversation(channelID: target.channelID, type: target.isDM ? "dm" : nil)
        }
    }

    private func markAllRead() {
        state.data = state.data?.map(read)
        store.setActivityUnread(0)
        Task { try? await store.markAllNotificationsRead() }
    }

    private func read(_ item: ActivityNotification) -> ActivityNotification {
        var next = item
        next.isRead = true
        return next
    }
}

private struct ActivityRow: View {
    let item: ActivityNotification
    let names: [String: String]

    var body: some View {
        HStack(alignment: .top, spacing: Tokens.Spacing.m) {
            avatar
            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text(item.title).font(item.isRead ? .body : .body.weight(.semibold)).lineLimit(1)
                    Spacer()
                    if let date = WeldDate.parse(item.createdAt) {
                        Text(ChatDates.activityTime(date)).font(.inter(.caption)).foregroundStyle(.secondary)
                    }
                }
                HStack(alignment: .top) {
                    Text(MentionText.plainText(item.body ?? "", names: names))
                        .font(.inter(.subheadline))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                    Spacer()
                    if !item.isRead { UnreadDot() }
                }
            }
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
    }

    @ViewBuilder private var avatar: some View {
        if item.actorAvatar != nil || item.actorName != nil {
            ChatAvatar(name: item.actorName, url: item.actorAvatar, size: 40)
        } else {
            Image(systemName: symbol)
                .foregroundStyle(.white)
                .frame(width: 40, height: 40)
                .background(Tokens.Palette.primary, in: Circle())
        }
    }

    private var symbol: String {
        switch item.notificationType {
        case "chat_mention": "at"
        case "chat_thread_reply": "bubble.left.and.bubble.right"
        case "chat_dm": "envelope"
        case "chat_missed_call": "phone.down"
        default: "bell"
        }
    }
}

/// A day group of Activity.
private struct ActivitySection {
    let title: String
    let items: [ActivityNotification]
}
