import SwiftUI
import WeldCore
import WeldUI

/// Search: messages across the workspace (and people), with WhatsApp-style
/// tabs that narrow the results to photos, videos, links, GIFs, audio or
/// documents. Recent searches stay on the device.
struct SearchView: View {
    let store: ChatStore

    @Environment(ChatNavigator.self) private var navigator
    @Environment(\.dismiss) private var dismiss

    @State private var query = ""
    @State private var tab: SearchTab = .all
    @State private var hits: [SearchHitItem] = []
    @State private var people: [TeamMember] = []
    @State private var searched = false
    @State private var loading = false
    @State private var recent: [String] = []
    @FocusState private var focused: Bool

    private struct SearchKey: Equatable {
        var query: String
        var tab: SearchTab
    }

    var body: some View {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let results = SearchRules.results(hits, tab: tab)
        let hasResults = tab == .people ? !people.isEmpty : !results.isEmpty
        let showEmpty = searched && !loading && !hasResults && !trimmed.isEmpty

        VStack(spacing: 0) {
            header
            ChipRow(
                items: SearchTab.allCases,
                selected: tab,
                title: { $0.label },
                symbol: { $0.symbol },
                identifier: { "search-tab-\($0.rawValue)" },
                onSelect: { next in
                    tab = next
                    searched = false
                }
            )
            .padding(.horizontal, Tokens.Spacing.l)
            .padding(.bottom, Tokens.Spacing.s)
            Divider()

            List {
                if !searched, trimmed.isEmpty {
                    idle
                } else if loading, !hasResults {
                    ProgressView().frame(maxWidth: .infinity).listRowSeparator(.hidden)
                } else if tab == .people {
                    ForEach(people) { member in personRow(member) }
                    if showEmpty {
                        ChatEmptyState(title: ChatStrings.searchNoPeople, symbol: "person.2").listRowSeparator(.hidden)
                    }
                } else {
                    ForEach(results) { hit in resultRow(hit) }
                    if showEmpty {
                        ChatEmptyState(title: ChatStrings.searchNoResults, description: ChatStrings.searchNoResultsHint, symbol: "magnifyingglass")
                            .listRowSeparator(.hidden)
                    }
                }
            }
            .listStyle(.plain)
            .scrollDismissesKeyboard(.interactively)
        }
        .toolbar(.hidden, for: .navigationBar)
        .onAppear {
            recent = RecentSearchStore.load()
            focused = true
        }
        .task(id: SearchKey(query: query, tab: tab)) { await run() }
    }

    // MARK: Parts

    private var header: some View {
        HStack(spacing: Tokens.Spacing.m) {
            ChatSearchField(placeholder: ChatStrings.searchPlaceholder, text: $query, identifier: "search-input", focus: $focused)
            Button(CoreStrings.commonCancel) { dismiss() }
                .accessibilityIdentifier("search-cancel")
        }
        .padding(.horizontal, Tokens.Spacing.l)
        .padding(.vertical, Tokens.Spacing.s)
    }

    @ViewBuilder
    private var idle: some View {
        if recent.isEmpty {
            ChatEmptyState(title: ChatStrings.searchIdleTitle, description: ChatStrings.searchIdleHint, symbol: "magnifyingglass")
                .listRowSeparator(.hidden)
        } else {
            Section {
                ForEach(Array(recent.enumerated()), id: \.element) { index, term in
                    HStack(spacing: Tokens.Spacing.m) {
                        Button {
                            query = term
                        } label: {
                            HStack(spacing: Tokens.Spacing.m) {
                                Image(systemName: "clock").foregroundStyle(.secondary)
                                Text(term).lineLimit(1)
                                Spacer(minLength: 0)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("search-recent-\(index)")
                        Button {
                            setRecent(recent.filter { $0 != term })
                        } label: {
                            Image(systemName: "xmark").font(.caption).foregroundStyle(.secondary)
                        }
                        .buttonStyle(.borderless)
                        .accessibilityLabel(ChatStrings.searchRemoveRecent(term: term))
                    }
                }
            } header: {
                HStack {
                    Text(ChatStrings.searchRecentSearches)
                    Spacer()
                    Button(ChatStrings.searchClearAll) { setRecent([]) }
                        .font(.footnote)
                        .accessibilityIdentifier("search-clear-recent")
                }
            }
        }
    }

    private func personRow(_ member: TeamMember) -> some View {
        Button {
            navigator.open(.member(userID: member.userID))
        } label: {
            HStack(spacing: Tokens.Spacing.m) {
                ChatAvatar(name: member.displayName, url: member.picture, size: 36)
                VStack(alignment: .leading, spacing: 1) {
                    Text(member.displayName).lineLimit(1)
                    if let email = member.email, !email.isEmpty, member.name != nil {
                        Text(email).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("search-person-\(member.userID)")
    }

    private func resultRow(_ hit: SearchHitItem) -> some View {
        Button {
            navigator.openConversation(channelID: hit.channelID, name: hit.channelName, type: hit.channelType)
        } label: {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 4) {
                    Image(systemName: hit.channelType == "dm" ? "bubble.left" : "number")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Text(hit.channelName.flatMap { $0.isEmpty ? nil : $0 } ?? ChatStrings.searchUnknownChannel)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Spacer(minLength: Tokens.Spacing.s)
                    if let date = WeldDate.parse(hit.createdAt) {
                        Text(date.formatted(.dateTime.day().month(.abbreviated)))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Text(hit.authorName).font(.subheadline.weight(.semibold)).lineLimit(1)
                let text = MentionText.plainText(hit.content, names: store.memberNames).trimmingCharacters(in: .whitespacesAndNewlines)
                if !text.isEmpty {
                    Text(text).font(.subheadline).lineLimit(2)
                }
                if let file = SearchRules.attachmentLabel(hit) {
                    HStack(spacing: 4) {
                        Image(systemName: "paperclip").font(.caption2)
                        Text(file).font(.caption).lineLimit(1)
                    }
                    .foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 2)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("search-result-\(hit.id)")
    }

    // MARK: Searching

    /// Typing pauses 400 ms before the search runs; a search that answered
    /// goes to the recent searches.
    private func run() async {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            hits = []
            people = []
            searched = false
            loading = false
            return
        }
        try? await Task.sleep(for: .milliseconds(400))
        guard !Task.isCancelled else { return }
        loading = true
        var succeeded = true
        if tab == .people {
            await store.loadRosterIfNeeded()
            people = SearchRules.people(store.roster, matching: text)
            hits = []
            succeeded = !store.roster.isEmpty
        } else {
            do {
                let found = try await store.search(text)
                guard !Task.isCancelled else { return }
                hits = found
            } catch {
                guard !Task.isCancelled else { return }
                hits = []
                succeeded = false
            }
            people = []
        }
        loading = false
        searched = true
        if succeeded { setRecent(RecentSearches.adding(text, to: recent)) }
    }

    private func setRecent(_ list: [String]) {
        recent = list
        RecentSearchStore.save(list)
    }
}
