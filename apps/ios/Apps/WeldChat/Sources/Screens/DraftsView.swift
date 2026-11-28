import SwiftUI
import WeldCore
import WeldUI

/// Drafts: the messages started and not sent, newest first. Tap to pick up
/// where you left off (the conversation restores its draft), swipe to delete.
struct DraftsView: View {
    let store: ChatStore

    @Environment(ChatNavigator.self) private var navigator
    @State private var drafts: [DraftItem] = []
    @State private var loading = true
    @State private var error: APIError?

    var body: some View {
        let names = store.memberNames
        List {
            if loading, drafts.isEmpty {
                ProgressView().frame(maxWidth: .infinity).listRowSeparator(.hidden)
            } else if let error, drafts.isEmpty {
                LoadErrorView(error: error) { await load() }
                    .listRowSeparator(.hidden)
            } else if drafts.isEmpty {
                ChatEmptyState(title: ChatStrings.draftsEmptyTitle, description: ChatStrings.draftsEmptyHint, symbol: "square.and.pencil")
                    .listRowSeparator(.hidden)
            } else {
                ForEach(drafts) { draft in
                    Button {
                        navigator.openConversation(channelID: draft.channelID, name: draft.channelName, type: draft.isDM ? "dm" : nil)
                    } label: {
                        row(draft, names: names)
                    }
                    .buttonStyle(.plain)
                    .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                        Button(role: .destructive) {
                            delete(draft)
                        } label: {
                            Label(CoreStrings.commonDelete, systemImage: "trash")
                        }
                    }
                    .accessibilityIdentifier("draft-row-\(draft.id)")
                }
            }
        }
        .listStyle(.plain)
        .navigationTitle(ChatStrings.draftsTitle)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load() }
    }

    /// The platform's draft row: the conversation's # (or a DM's bubble) in
    /// grey, its name, what was typed, and when.
    private func row(_ draft: DraftItem, names: [String: String]) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: draft.isDM ? "bubble.left" : "number")
                .font(.system(size: 15))
                .foregroundStyle(Tokens.Palette.mutedForeground)
                .frame(width: 24, height: 24)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: Tokens.Spacing.s) {
                    Text(draft.channelName)
                        .font(.inter(.subheadline, weight: .medium))
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    if let date = WeldDate.parse(draft.updatedAt) {
                        Text(ChatDates.draftTime(date))
                            .font(.inter(.caption))
                            .foregroundStyle(Tokens.Palette.mutedForeground)
                    }
                }
                Text(MentionText.plainText(draft.content, names: names))
                    .font(.inter(size: 13))
                    .foregroundStyle(Tokens.Palette.mutedForeground)
                    .lineLimit(2)
            }
        }
        .padding(.vertical, 6)
        .contentShape(Rectangle())
    }

    /// The drafts, each with its conversation's name: from Home's lists when
    /// it is there, else from the channel itself.
    private func load() async {
        do {
            let raw = try await store.listDrafts(channelID: nil)
            let dms = store.dms
            let channels = store.channels
            var items: [DraftItem] = []
            await withTaskGroup(of: DraftItem?.self) { group in
                for draft in raw {
                    guard let channelID = draft.channelID else { continue }
                    if let known = SavedRules.knownConversation(channelID, dms: dms, channels: channels) {
                        items.append(DraftItem(
                            id: draft.id,
                            channelID: channelID,
                            channelName: known.name,
                            isDM: known.isDM,
                            content: draft.content,
                            updatedAt: draft.updatedAt
                        ))
                        continue
                    }
                    group.addTask {
                        let channel = try? await store.channel(channelID)
                        return DraftItem(
                            id: draft.id,
                            channelID: channelID,
                            channelName: channel?.name ?? channelID,
                            isDM: channel?.isDM ?? false,
                            content: draft.content,
                            updatedAt: draft.updatedAt
                        )
                    }
                }
                for await item in group {
                    if let item { items.append(item) }
                }
            }
            drafts = SavedRules.sortedDrafts(items)
            error = nil
        } catch {
            self.error = APIError.from(error)
        }
        loading = false
    }

    private func delete(_ draft: DraftItem) {
        drafts.removeAll { $0.id == draft.id }
        Task {
            do {
                try await store.deleteDraft(draft.id)
                await store.loadCounts()
            } catch {
                await load()
            }
        }
    }
}
