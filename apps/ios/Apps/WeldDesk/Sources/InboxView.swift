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
        // The current time, read again every 30 seconds, so SLA countdowns move without a reload.
        TimelineView(.periodic(from: .now, by: 30)) { context in
            list(now: context.date)
        }
        .searchable(text: $search, prompt: DeskStrings.inboxSearchPlaceholder)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .onChange(of: search) { _, text in model.searchChanged(text) }
        .refreshable { await model.reload() }
        .task { await model.appeared() }
        .realtimeRefresh(env, topics: inboxTopics) { await model.reload() }
    }

    private func list(now: Date) -> some View {
        List {
            filters
                .listRowSeparator(.hidden)
                .listRowInsets(EdgeInsets(top: Tokens.Spacing.s, leading: Tokens.Spacing.l, bottom: Tokens.Spacing.m, trailing: Tokens.Spacing.l))
            if model.loading && model.items.isEmpty {
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 56)
                    .listRowSeparator(.hidden)
                    .accessibilityIdentifier("inbox-loading")
            } else if model.items.isEmpty, model.error != nil {
                DeskLoadErrorView(title: DeskStrings.inboxLoadError, error: model.error) { await model.retry() }
                    .listRowSeparator(.hidden)
            } else if model.items.isEmpty {
                emptyState
                    .listRowSeparator(.hidden)
            } else {
                ForEach(DeskLogic.groupByDate(model.items, now: now)) { group in
                    if group.group != .today {
                        GroupHeaderRow(label: groupLabel(group.group), count: group.items.count)
                            .listRowInsets(EdgeInsets())
                            .listRowSeparator(.hidden)
                    }
                    ForEach(group.items) { conversation in
                        NavigationLink(value: ConversationRoute(id: conversation.id)) {
                            ConversationRow(conversation: conversation, now: now)
                                .alignmentGuide(.listRowSeparatorLeading) { _ in 0 }
                        }
                        .listRowInsets(EdgeInsets(top: Tokens.Spacing.m, leading: Tokens.Spacing.m, bottom: Tokens.Spacing.m, trailing: Tokens.Spacing.m))
                        .listRowSeparatorTint(Tokens.Palette.border)
                        .accessibilityIdentifier("conversation-\(conversation.number)")
                        .onAppear {
                            if conversation.id == model.items.last?.id { Task { await model.loadMore() } }
                        }
                    }
                }
                if model.loadMoreFailed {
                    Button(DeskStrings.inboxLoadMoreError) { Task { await model.loadMore() } }
                        .font(.inter(.footnote))
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
    }

    /// The platform's filter toggles: open or closed and the sort, then whose.
    private var filters: some View {
        VStack(alignment: .leading, spacing: Tokens.Spacing.s) {
            HStack(spacing: 6) {
                FilterChip(title: DeskStrings.inboxOpen, selected: model.query.state == .open, identifier: "filter-open") { model.setState(.open) }
                FilterChip(title: DeskStrings.inboxClosed, selected: model.query.state == .closed, identifier: "filter-closed") { model.setState(.closed) }
                Spacer(minLength: 0)
                OutlineChip(title: sortLabel(model.query.sort), systemImage: "arrow.up.arrow.down") { model.cycleSort() }
                    .accessibilityHint(DeskStrings.inboxSortHint(sort: sortLabel(model.query.sort)))
                    .accessibilityIdentifier("inbox-sort")
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    FilterChip(title: DeskStrings.inboxAll, selected: model.query.assignee == .all, identifier: "filter-all") { model.setAssignee(.all) }
                    FilterChip(title: DeskStrings.inboxMine, selected: model.query.assignee == .mine, identifier: "filter-mine") { model.setAssignee(.mine) }
                    FilterChip(title: DeskStrings.inboxUnassigned, selected: model.query.assignee == .unassigned, identifier: "filter-unassigned") {
                        model.setAssignee(.unassigned)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var emptyState: some View {
        if !model.query.search.isEmpty {
            DeskEmptyStateView(systemImage: "magnifyingglass", title: DeskStrings.inboxNoResults, description: DeskStrings.inboxNoResultsHint)
                .accessibilityIdentifier("inbox-empty")
        } else {
            DeskEmptyStateView(systemImage: "tray", title: DeskStrings.inboxEmpty, description: DeskStrings.inboxEmptyDescription)
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

/// A date group's header text, in the phone's language.
func groupLabel(_ group: DeskLogic.DateGroup, calendar: Calendar = .current) -> String {
    switch group {
    case .today:
        return CoreStrings.commonToday
    case .yesterday:
        return CoreStrings.commonYesterday
    case let .weekday(weekday):
        let symbols = calendar.standaloneWeekdaySymbols
        return capitalized(symbols.indices.contains(weekday - 1) ? symbols[weekday - 1] : "")
    case .lastWeek:
        return DeskStrings.inboxLastWeek
    case let .weeksAgo(weeks):
        return DeskStrings.inboxWeeksAgo(count: weeks)
    case let .month(year, month, withYear):
        guard let date = calendar.date(from: DateComponents(year: year, month: month, day: 1)) else { return "" }
        return capitalized(withYear ? date.formatted(.dateTime.month(.wide).year()) : date.formatted(.dateTime.month(.wide)))
    case let .later(day):
        return day.formatted(.dateTime.month(.wide).day())
    }
}

/// "maandag" → "Maandag": a month or weekday at the start of a header.
private func capitalized(_ text: String) -> String {
    text.prefix(1).uppercased() + text.dropFirst()
}

/// A row's date, as the platform's list: the time today, else the day (with the year once it isn't this year's).
func listDate(_ date: Date, now: Date, calendar: Calendar = .current) -> String {
    if calendar.isDate(date, inSameDayAs: now) { return date.formatted(date: .omitted, time: .shortened) }
    if calendar.component(.year, from: date) == calendar.component(.year, from: now) {
        return date.formatted(.dateTime.month(.abbreviated).day())
    }
    return date.formatted(.dateTime.month(.abbreviated).day().year())
}

/// One conversation, as the platform's list item: the customer's avatar (a
/// blue dot beside it while they wait for an answer), their name and the
/// date, the subject, the last message, and the badges.
private struct ConversationRow: View {
    let conversation: DeskConversation
    let now: Date

    var body: some View {
        let unread = conversation.isWaiting
        let name = DeskLogic.rowTitle(conversation) ?? DeskStrings.inboxNoSubject
        HStack(alignment: .top, spacing: 10) {
            InitialAvatar(name: name, size: 28)
                .overlay(alignment: .leading) {
                    if unread {
                        Circle().fill(DeskColors.unread).frame(width: 6, height: 6).offset(x: -10)
                    }
                }
                .padding(.top, 3)
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: Tokens.Spacing.s) {
                    Text(name)
                        .font(.inter(.subheadline, weight: unread ? .semibold : .medium))
                        .foregroundStyle(unread ? Tokens.Palette.foreground : Tokens.Palette.mutedForeground)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    if let time = DeskLogic.rowTime(conversation) {
                        Text(listDate(time, now: now))
                            .font(.inter(.caption2))
                            .foregroundStyle(Tokens.Palette.mutedForeground)
                            .lineLimit(1)
                    }
                }
                Text(DeskLogic.rowSubject(conversation))
                    .font(.inter(.subheadline, weight: unread ? .medium : .regular))
                    .foregroundStyle(unread ? Tokens.Palette.foreground : Tokens.Palette.mutedForeground)
                    .lineLimit(1)
                    .padding(.top, 1)
                let preview = DeskLogic.rowSubtitle(conversation)
                if !preview.isEmpty {
                    Text(preview)
                        .font(.inter(.footnote))
                        .foregroundStyle(Tokens.Palette.mutedForeground)
                        .lineLimit(1)
                        .padding(.top, 2)
                }
                let badges = DeskLogic.rowBadges(conversation, now: now)
                if !badges.isEmpty {
                    let flow = FlowLayout()
                    flow {
                        ForEach(Array(badges.prefix(DeskLogic.maxRowBadges).enumerated()), id: \.offset) { _, badge in
                            let shown = rowBadge(badge)
                            StatusBadge(shown.text, color: shown.color)
                        }
                        if badges.count > DeskLogic.maxRowBadges {
                            Text("+\(badges.count - DeskLogic.maxRowBadges)")
                                .font(.inter(size: 10))
                                .foregroundStyle(Tokens.Palette.mutedForeground)
                        }
                    }
                    .padding(.top, Tokens.Spacing.s)
                }
            }
        }
    }

    /// A row badge's text and the platform's colour for it.
    private func rowBadge(_ badge: DeskLogic.RowBadge) -> (text: String, color: Color) {
        switch badge {
        case let .sla(display):
            return (slaText(display.label), slaColor(display.tone))
        case let .priority(priority):
            return (priorityName(priority), priority == "urgent" ? DeskColors.urgent : DeskColors.high)
        case let .tag(tag):
            return (tag, DeskColors.tag)
        case let .channel(channel):
            let color: Color
            switch channel {
            case .email: color = DeskColors.email
            case .phone: color = DeskColors.phone
            case .portal: color = DeskColors.portal
            default: color = DeskColors.api
            }
            return (channelName(channel, value: ""), color)
        case .unassigned:
            return (DeskStrings.inboxUnassignedBadge, DeskColors.unassigned)
        case .waiting:
            return (DeskStrings.inboxWaitingBadge, DeskColors.waiting)
        }
    }
}

/// The list's colour for an SLA tone.
func slaColor(_ tone: DeskLogic.SlaTone) -> Color {
    switch tone {
    case .ok: DeskColors.slaOk
    case .warning: DeskColors.slaWarning
    case .breached: DeskColors.slaBreached
    case .muted: DeskColors.slaMuted
    }
}
