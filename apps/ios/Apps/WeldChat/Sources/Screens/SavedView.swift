import SwiftUI
import WeldCore
import WeldUI

/// Saved for later: the messages bookmarked from a conversation's actions.
/// Tap to open the conversation, swipe to remove.
struct SavedView: View {
    let store: ChatStore

    @Environment(ChatNavigator.self) private var navigator
    @State private var bookmarks: [ChatBookmark] = []
    @State private var loading = true
    @State private var error: APIError?

    var body: some View {
        let names = store.memberNames
        let dms = store.dms
        List {
            if loading, bookmarks.isEmpty {
                ProgressView().frame(maxWidth: .infinity).listRowSeparator(.hidden)
            } else if let error, bookmarks.isEmpty {
                LoadErrorView(error: error) { await load() }
                    .listRowSeparator(.hidden)
            } else if bookmarks.isEmpty {
                ChatEmptyState(title: ChatStrings.savedEmptyTitle, description: ChatStrings.savedEmptyHint, symbol: "bookmark")
                    .listRowSeparator(.hidden)
            } else {
                ForEach(bookmarks) { bookmark in
                    let name = SavedRules.bookmarkConversation(bookmark, dms: dms)
                    let isDM = bookmark.channelType == "dm"
                    Button {
                        navigator.openConversation(channelID: bookmark.channelID, name: name, type: bookmark.channelType)
                    } label: {
                        row(bookmark, name: name, isDM: isDM, names: names)
                    }
                    .buttonStyle(.plain)
                    .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                        Button(role: .destructive) {
                            remove(bookmark)
                        } label: {
                            Label(ChatStrings.savedRemove, systemImage: "trash")
                        }
                    }
                    .accessibilityIdentifier("saved-row-\(bookmark.id)")
                }
            }
        }
        .listStyle(.plain)
        .navigationTitle(ChatStrings.savedTitle)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load() }
    }

    private func row(_ bookmark: ChatBookmark, name: String, isDM: Bool, names: [String: String]) -> some View {
        HStack(alignment: .top, spacing: Tokens.Spacing.m) {
            Image(systemName: "bookmark")
                .foregroundStyle(Tokens.Palette.primary)
                .frame(width: 32, height: 32)
                .background(Tokens.Palette.primary.opacity(0.12), in: Circle())
            VStack(alignment: .leading, spacing: 2) {
                Text(SavedRules.conversationLabel(name: name, isDM: isDM))
                    .font(.inter(.subheadline, weight: .semibold))
                    .lineLimit(1)
                Text(bookmark.messageAuthorName ?? ChatStrings.savedUnknownAuthor)
                    .font(.inter(.caption, weight: .medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Text(SavedRules.bookmarkText(bookmark, names: names))
                    .font(.inter(.subheadline))
                    .lineLimit(2)
                if let note = bookmark.note, !note.isEmpty {
                    Text(note)
                        .font(.inter(.caption))
                        .italic()
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
            if let date = WeldDate.parse(bookmark.createdAt) {
                Text(date.formatted(.dateTime.day().month(.abbreviated)))
                    .font(.inter(.caption))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
    }

    private func load() async {
        do {
            bookmarks = try await store.listBookmarks(limit: ChatLogic.savedCap)
            error = nil
        } catch {
            self.error = APIError.from(error)
        }
        loading = false
    }

    private func remove(_ bookmark: ChatBookmark) {
        bookmarks.removeAll { $0.id == bookmark.id }
        Task {
            do {
                try await store.deleteBookmark(bookmark.id)
                await store.loadCounts()
            } catch {
                await load()
            }
        }
    }
}
