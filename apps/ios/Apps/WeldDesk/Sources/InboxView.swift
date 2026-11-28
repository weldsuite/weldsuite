import SwiftUI
import WeldCore
import WeldUI

/// The hub topics that change the inbox: the entity topics, and the legacy `helpdesk` one.
let inboxTopics = ["helpdesk", "desk_conversation", "desk_message", "helpdesk_conversation", "helpdesk_conversation_message"]

/// The agent inbox: filters, search, pages, and a silent reload when something changes.
@MainActor
@Observable
final class InboxModel {
    private(set) var query = InboxQuery()
    private(set) var items: [DeskConversation] = []
    /// Nothing shown yet for these filters.
    private(set) var loading = true
    private(set) var loadingMore = false
    /// The next page didn't load; the list offers to try again.
    private(set) var loadMoreFailed = false
    private(set) var error: APIError?
    private(set) var hasMore = false

    @ObservationIgnored private var cursor: String?
    @ObservationIgnored private let store: DeskStore
    @ObservationIgnored private let userID: String?
    /// Bumped by every load from the first page: an older answer is dropped.
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var searchTask: Task<Void, Never>?
    @ObservationIgnored private var appearedBefore = false

    init(store: DeskStore, userID: String?) {
        self.store = store
        self.userID = userID
    }

    func setState(_ state: ConversationState) {
        var next = query
        next.state = state
        apply(next)
    }

    func setAssignee(_ assignee: AssigneeFilter) {
        var next = query
        next.assignee = assignee
        apply(next)
    }

    func cycleSort() {
        var next = query
        next.sort = query.sort.next
        apply(next)
    }

    /// The search field changed: the list follows after a pause.
    func searchChanged(_ text: String) {
        searchTask?.cancel()
        searchTask = Task { [weak self] in
            try? await Task.sleep(for: DeskLogic.searchDebounce)
            guard !Task.isCancelled, let self else { return }
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard trimmed != self.query.search else { return }
            var next = self.query
            next.search = trimmed
            self.apply(next)
        }
    }

    /// The inbox is on screen: the first time a load, later (back from a thread) a quiet reload.
    func appeared() async {
        if appearedBefore {
            await reload()
        } else {
            appearedBefore = true
            await load(reset: true)
        }
    }

    /// Something changed (pull to refresh, realtime): the first page, the list stays while it loads.
    func reload() async {
        await load(reset: false)
    }

    func retry() async {
        await load(reset: true)
    }

    func loadMore() async {
        guard hasMore, !loadingMore, !loading, let cursor else { return }
        loadingMore = true
        loadMoreFailed = false
        let forGeneration = generation
        let request = DeskLogic.inboxRequest(query, userID: userID)
        let page = try? await store.inbox(request, cursor: cursor)
        guard forGeneration == generation else { return }
        loadingMore = false
        guard let page else {
            loadMoreFailed = true
            return
        }
        let known = Set(items.map(\.id))
        items += page.items.filter { !known.contains($0.id) }
        hasMore = page.hasMore
        self.cursor = page.cursor
    }

    private func apply(_ next: InboxQuery) {
        guard next != query else { return }
        query = next
        Task { await self.load(reset: true) }
    }

    private func load(reset: Bool) async {
        generation += 1
        let forGeneration = generation
        if reset {
            items = []
            loading = true
            error = nil
            hasMore = false
            cursor = nil
        }
        let request = DeskLogic.inboxRequest(query, userID: userID)
        do {
            let page = try await store.inbox(request, cursor: nil)
            guard forGeneration == generation else { return }
            items = page.items
            hasMore = page.hasMore
            cursor = page.cursor
            error = nil
        } catch {
            guard forGeneration == generation else { return }
            self.error = APIError.from(error)
        }
        // A next page asked for before this load was dropped with it.
        loadingMore = false
        loading = false
    }
}

struct InboxView: View {
    let env: AppEnvironment
    let model: InboxModel
    @State private var search = ""

    var body: some View {
        List {
            filters
                .listRowSeparator(.hidden)
            if model.loading && model.items.isEmpty {
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .listRowSeparator(.hidden)
                    .accessibilityIdentifier("inbox-loading")
            } else if model.items.isEmpty, model.error != nil {
                DeskLoadErrorView(title: DeskStrings.inboxLoadError, error: model.error) { await model.retry() }
                    .listRowSeparator(.hidden)
            } else if model.items.isEmpty {
                emptyState
                    .listRowSeparator(.hidden)
            } else {
                ForEach(model.items) { conversation in
                    NavigationLink(value: ConversationRoute(id: conversation.id)) {
                        ConversationRow(conversation: conversation)
                    }
                    .accessibilityIdentifier("conversation-\(conversation.number)")
                    .onAppear {
                        if conversation.id == model.items.last?.id { Task { await model.loadMore() } }
                    }
                }
                if model.loadMoreFailed {
                    Button(DeskStrings.inboxLoadMoreError) { Task { await model.loadMore() } }
                        .frame(maxWidth: .infinity)
                        .listRowSeparator(.hidden)
                        .accessibilityIdentifier("inbox-load-more")
                }
                if model.loadingMore {
                    ProgressView().frame(maxWidth: .infinity).listRowSeparator(.hidden)
                }
            }
        }
        .listStyle(.plain)
        .accessibilityIdentifier("conversation-list")
        .searchable(text: $search, prompt: DeskStrings.inboxSearchPlaceholder)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .onChange(of: search) { _, text in model.searchChanged(text) }
        .refreshable { await model.reload() }
        .task { await model.appeared() }
        .realtimeRefresh(env, topics: inboxTopics) { await model.reload() }
    }

    private var filters: some View {
        VStack(alignment: .leading, spacing: Tokens.Spacing.s) {
            Picker(DeskStrings.inboxTitle, selection: Binding(get: { model.query.state }, set: { model.setState($0) })) {
                Text(DeskStrings.inboxOpen).tag(ConversationState.open)
                Text(DeskStrings.inboxClosed).tag(ConversationState.closed)
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("filter-state")
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Tokens.Spacing.s) {
                    FilterChip(title: DeskStrings.inboxAll, selected: model.query.assignee == .all, identifier: "filter-all") { model.setAssignee(.all) }
                    FilterChip(title: DeskStrings.inboxMine, selected: model.query.assignee == .mine, identifier: "filter-mine") { model.setAssignee(.mine) }
                    FilterChip(title: DeskStrings.inboxUnassigned, selected: model.query.assignee == .unassigned, identifier: "filter-unassigned") {
                        model.setAssignee(.unassigned)
                    }
                    Button {
                        model.cycleSort()
                    } label: {
                        Label(sortLabel(model.query.sort), systemImage: "arrow.up.arrow.down")
                            .font(.inter(.subheadline, weight: .semibold))
                            .padding(.horizontal, Tokens.Spacing.m)
                            .padding(.vertical, 6)
                            .background(Color(.secondarySystemFill), in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .accessibilityHint(DeskStrings.inboxSortHint(sort: sortLabel(model.query.sort)))
                    .accessibilityIdentifier("inbox-sort")
                }
            }
        }
    }

    @ViewBuilder
    private var emptyState: some View {
        if !model.query.search.isEmpty {
            ContentUnavailableView(DeskStrings.inboxNoResults, systemImage: "magnifyingglass", description: Text(DeskStrings.inboxNoResultsHint))
                .accessibilityIdentifier("inbox-empty")
        } else {
            ContentUnavailableView(
                model.query.state == .open ? DeskStrings.inboxEmptyOpen : DeskStrings.inboxEmptyClosed,
                systemImage: "tray",
                description: Text(DeskStrings.inboxEmptyHint)
            )
            .accessibilityIdentifier("inbox-empty")
        }
    }
}

func sortLabel(_ sort: InboxSort) -> String {
    switch sort {
    case .newest: DeskStrings.inboxNewest
    case .oldest: DeskStrings.inboxOldest
    case .waitingLongest: DeskStrings.inboxWaitingLongest
    }
}

/// A chip that's on or off.
struct FilterChip: View {
    let title: String
    let selected: Bool
    let identifier: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.inter(.subheadline, weight: .semibold))
                .padding(.horizontal, Tokens.Spacing.m)
                .padding(.vertical, 6)
                .foregroundStyle(selected ? Tokens.Palette.primary : Color.primary)
                .background(selected ? Tokens.Palette.primary.opacity(0.12) : Color(.secondarySystemFill), in: Capsule())
                .overlay(Capsule().stroke(selected ? Tokens.Palette.primary : .clear, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier(identifier)
    }
}

private struct ConversationRow: View {
    let conversation: DeskConversation

    var body: some View {
        HStack(alignment: .top, spacing: Tokens.Spacing.m) {
            ChannelTile(channel: conversation.channel)
            VStack(alignment: .leading, spacing: 2) {
                Text(conversation.isWaiting ? DeskStrings.inboxWaiting : DeskLogic.numberLabel(conversation))
                    .font(.inter(.caption, weight: .semibold))
                    .foregroundStyle(conversation.isWaiting ? Tokens.Palette.primary : Color.secondary)
                    .lineLimit(1)
                Text(DeskLogic.rowTitle(conversation) ?? DeskStrings.inboxNoSubject)
                    .font(.inter(.body).weight(conversation.isWaiting ? .semibold : .regular))
                    .lineLimit(1)
                let subtitle = DeskLogic.rowSubtitle(conversation)
                if !subtitle.isEmpty {
                    Text(subtitle).font(.inter(.subheadline)).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer(minLength: 0)
            VStack(alignment: .trailing, spacing: Tokens.Spacing.xs) {
                if let time = DeskLogic.rowTime(conversation) {
                    Text(WeldDate.short(time)).font(.inter(.caption2)).foregroundStyle(.secondary)
                }
                ChannelBadge(channel: conversation.channel, value: conversation.channelValue)
                if conversation.isWaiting {
                    Circle().fill(Tokens.Palette.primary).frame(width: 8, height: 8)
                }
            }
        }
        .padding(.vertical, 2)
    }
}

/// The channel's icon on a tinted tile: email in teal, chat and the rest in violet.
struct ChannelTile: View {
    let channel: DeskChannel

    var body: some View {
        let color = channel == .email ? Color(red: 0.06, green: 0.46, blue: 0.43) : Color(red: 0.55, green: 0.36, blue: 0.96)
        Image(systemName: channel == .email ? "envelope" : "bubble.left.and.bubble.right")
            .font(.system(size: 17))
            .foregroundStyle(color)
            .frame(width: 40, height: 40)
            .background(color.opacity(0.12), in: RoundedRectangle(cornerRadius: Tokens.Radius.medium))
            .accessibilityHidden(true)
    }
}
