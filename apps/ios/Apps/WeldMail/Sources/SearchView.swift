import SwiftUI
import UIKit
import WeldCore
import WeldUI

/// Search across every mailbox, on the server, with filters.
struct SearchView: View {
    let store: MailStore

    /// The filters' chips, in the Expo app's order.
    private enum FilterKind: String, CaseIterable, Identifiable {
        case label, from, to, attachment, date, unread
        var id: String { rawValue }

        var title: String {
            switch self {
            case .label: return MailStrings.searchFilterLabel
            case .from: return MailStrings.searchFilterFrom
            case .to: return MailStrings.searchFilterTo
            case .attachment: return MailStrings.searchFilterAttachment
            case .date: return MailStrings.searchFilterDate
            case .unread: return MailStrings.searchFilterUnread
            }
        }
    }

    private struct FilterOption: Identifiable {
        let title: String
        let apply: (inout SearchFilters) -> Void
        var id: String { title }
    }

    /// What a server search depends on: a change runs it again.
    private struct SearchKey: Hashable {
        let query: String
        let label: String?
        let attachment: Bool?
        let unread: Bool?
    }

    @Environment(MailNavigator.self) private var nav
    @State private var query = ""
    @State private var filters = SearchFilters()
    @State private var results: [MailMessage] = []
    @State private var cursor: String?
    @State private var searching = false
    @State private var loadingMore = false
    @State private var editing: FilterKind?
    @FocusState private var focused: Bool

    private var active: Bool { !query.trimmingCharacters(in: .whitespaces).isEmpty || filters.isActive }

    var body: some View {
        let shown = SearchLogic.apply(results, filters: filters, own: store.ownAddresses)
        let tail = Set(shown.suffix(8).map(\.id))
        let labelColors = Dictionary(store.labels.custom.map { ($0.name, $0.color) }, uniquingKeysWith: { first, _ in first })
        List {
            Section {
                HStack(spacing: Tokens.Spacing.s) {
                    Image(systemName: "magnifyingglass").font(.system(size: 14)).foregroundStyle(Tokens.Palette.mutedForeground)
                    TextField(MailStrings.searchPlaceholder, text: $query)
                        .font(.inter(.subheadline))
                        .focused($focused)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.search)
                        .accessibilityIdentifier("search-input")
                    if !query.isEmpty {
                        Button {
                            query = ""
                        } label: {
                            Image(systemName: "xmark.circle.fill").foregroundStyle(Tokens.Palette.mutedForeground)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(MailStrings.searchClear)
                    }
                }
                // The platform's search input: bordered, `rounded-md`, the icon inside.
                .padding(.horizontal, 10)
                .frame(height: 40)
                .overlay(RoundedRectangle(cornerRadius: Tokens.Radius.medium).stroke(Tokens.Palette.border))
                .padding(.horizontal, Tokens.Spacing.l)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: Tokens.Spacing.s) {
                        ForEach(FilterKind.allCases) { kind in
                            let value = chosen(kind)
                            FilterChip(title: value ?? kind.title, selected: value != nil) { editing = kind }
                                .accessibilityIdentifier("search-filter-\(kind.rawValue)")
                        }
                    }
                    .padding(.horizontal, Tokens.Spacing.l)
                    .padding(.vertical, 1)
                }
            }
            .listRowInsets(EdgeInsets(top: Tokens.Spacing.s, leading: 0, bottom: Tokens.Spacing.s, trailing: 0))
            .listRowSeparator(.hidden)

            if !active {
                MailEmptyView(title: MailStrings.searchHint, systemImage: "magnifyingglass").listRowSeparator(.hidden)
            } else if searching && results.isEmpty {
                ProgressView().frame(maxWidth: .infinity).padding(48).listRowSeparator(.hidden)
            } else if shown.isEmpty {
                MailEmptyView(title: MailStrings.searchNoResults, description: MailStrings.searchNoResultsHint, systemImage: "magnifyingglass")
                    .listRowSeparator(.hidden)
            } else {
                ForEach(shown) { message in
                    Button {
                        nav.open(.message(message.id))
                    } label: {
                        MessageRow(message: message, pinned: MailLogic.isPinned(message), labelColors: labelColors, query: query)
                    }
                    .buttonStyle(.plain)
                    .listRowInsets(EdgeInsets())
                    .listRowSeparatorTint(Tokens.Palette.border)
                    .alignmentGuide(.listRowSeparatorLeading) { _ in 0 }
                    .accessibilityIdentifier("search-result")
                    .onAppear { if tail.contains(message.id) { loadMore() } }
                }
                if loadingMore {
                    ProgressView().frame(maxWidth: .infinity).listRowSeparator(.hidden)
                }
            }
        }
        .listStyle(.plain)
        .accessibilityIdentifier("search-results")
        .navigationTitle(MailStrings.tabsSearch)
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { focused = true }
        .onChange(of: shown.map(\.id), initial: true) { _, ids in store.visibleIDs = ids }
        .task(id: SearchKey(query: query, label: filters.label, attachment: filters.attachment, unread: filters.unread)) {
            await search()
        }
        .sheet(item: $editing) { kind in
            filterSheet(kind)
        }
    }

    private func search() async {
        cursor = nil
        guard active else {
            results = []
            return
        }
        try? await Task.sleep(for: .milliseconds(250))
        guard !Task.isCancelled else { return }
        searching = true
        defer { searching = false }
        do {
            let page = try await store.repository.messages(
                accountID: nil,
                label: filters.label,
                search: query,
                unreadOnly: filters.unread,
                withAttachments: filters.attachment
            )
            guard !Task.isCancelled else { return }
            results = page.messages
            cursor = page.cursor
        } catch {
            // Offline or refused: keep what was found.
        }
    }

    private func loadMore() {
        guard let next = cursor, !loadingMore else { return }
        loadingMore = true
        Task {
            defer { loadingMore = false }
            do {
                let page = try await store.repository.messages(
                    accountID: nil,
                    label: filters.label,
                    search: query,
                    unreadOnly: filters.unread,
                    withAttachments: filters.attachment,
                    cursor: next
                )
                guard cursor == next else { return }
                results = MailLogic.appendPage(results, page.messages)
                cursor = page.cursor
            } catch {
                // The cursor stays: scrolling down again retries.
            }
        }
    }

    // MARK: Filters

    private func labelTitle(_ system: SystemLabel) -> String {
        system == .all ? MailStrings.searchAllEmails : system.title
    }

    private func dateTitle(_ range: SearchLogic.DateRange) -> String {
        switch range {
        case .today: return MailStrings.searchToday
        case .yesterday: return MailStrings.searchYesterday
        case .thisWeek: return MailStrings.searchThisWeek
        case .thisMonth: return MailStrings.searchThisMonth
        case .thisYear: return MailStrings.searchThisYear
        }
    }

    /// What a filter is set to, as its chip shows it; nil when unset.
    private func chosen(_ kind: FilterKind) -> String? {
        switch kind {
        case .label: return filters.label.flatMap(SystemLabel.of).map(labelTitle)
        case .from: return filters.fromMe.map { $0 ? MailStrings.searchMe : MailStrings.searchAnyone }
        case .to: return filters.toMe.map { $0 ? MailStrings.searchMe : MailStrings.searchAnyone }
        case .attachment: return filters.attachment.map { $0 ? MailStrings.searchHasAttachment : MailStrings.searchNoAttachment }
        case .date: return filters.date.map(dateTitle)
        case .unread: return filters.unread.map { $0 ? MailStrings.searchUnread : MailStrings.searchRead }
        }
    }

    private func clear(_ kind: FilterKind) {
        switch kind {
        case .label: filters.label = nil
        case .from: filters.fromMe = nil
        case .to: filters.toMe = nil
        case .attachment: filters.attachment = nil
        case .date: filters.date = nil
        case .unread: filters.unread = nil
        }
    }

    /// A filter's choices: their label and what choosing one does.
    private func options(_ kind: FilterKind) -> [FilterOption] {
        switch kind {
        case .label:
            return SearchLogic.labels.map { system in FilterOption(title: labelTitle(system)) { $0.label = system.slug } }
        case .from:
            return [
                FilterOption(title: MailStrings.searchMe) { $0.fromMe = true },
                FilterOption(title: MailStrings.searchAnyone) { $0.fromMe = false },
            ]
        case .to:
            return [
                FilterOption(title: MailStrings.searchMe) { $0.toMe = true },
                FilterOption(title: MailStrings.searchAnyone) { $0.toMe = false },
            ]
        case .attachment:
            return [
                FilterOption(title: MailStrings.searchHasAttachment) { $0.attachment = true },
                FilterOption(title: MailStrings.searchNoAttachment) { $0.attachment = false },
            ]
        case .date:
            return SearchLogic.DateRange.allCases.map { range in FilterOption(title: dateTitle(range)) { $0.date = range } }
        case .unread:
            return [
                FilterOption(title: MailStrings.searchUnread) { $0.unread = true },
                FilterOption(title: MailStrings.searchRead) { $0.unread = false },
            ]
        }
    }

    private func filterSheet(_ kind: FilterKind) -> some View {
        let current = chosen(kind)
        return NavigationStack {
            List(options(kind)) { option in
                Button {
                    option.apply(&filters)
                    editing = nil
                } label: {
                    HStack {
                        Text(option.title).foregroundStyle(.primary)
                        Spacer()
                        if current == option.title { Image(systemName: "checkmark").foregroundStyle(Color.accentColor) }
                    }
                }
            }
            .navigationTitle(kind.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(CoreStrings.commonClose) { editing = nil }
                }
                if current != nil {
                    ToolbarItem(placement: .confirmationAction) {
                        Button(MailStrings.searchClearFilter) {
                            clear(kind)
                            editing = nil
                        }
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}
