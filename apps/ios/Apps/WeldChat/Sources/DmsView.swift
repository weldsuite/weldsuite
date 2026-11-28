import SwiftUI
import WeldCore
import WeldUI

/// Direct messages: All / Unread / Favourites / Muted, pinned first then the
/// newest; swipe to mute or pin, archive or delete; hold for the menu.
struct DmsView: View {
    let env: AppEnvironment
    let store: ChatStore
    let person: Person

    @Environment(ChatNavigator.self) private var navigator
    @Environment(Toaster.self) private var toaster
    @State private var filter: DmLogic.Filter = .all

    var body: some View {
        let rows = DmLogic.sorted(store.dms, filter: filter)
        let names = store.memberNames
        List {
            Section {
                SearchButton { navigator.open(.search) }
                    .accessibilityIdentifier("dms-search")
                    .listRowSeparator(.hidden)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: Tokens.Spacing.s) {
                        chip(.all, ChatStrings.dmsFilterAll)
                        chip(.unread, ChatStrings.dmsFilterUnread)
                        chip(.favourites, ChatStrings.dmsFilterFavourites)
                        chip(.muted, ChatStrings.dmsFilterMuted)
                    }
                }
                .listRowSeparator(.hidden)
            }

            if !store.dmsLoaded, store.dms.isEmpty {
                ProgressView().frame(maxWidth: .infinity).listRowSeparator(.hidden)
            } else if rows.isEmpty {
                ChatEmptyState(title: ChatStrings.dmsEmptyTitle, description: ChatStrings.dmsEmptyHint)
                    .listRowSeparator(.hidden)
            } else {
                ForEach(rows) { dm in
                    Button {
                        navigator.openConversation(channelID: dm.id, name: dm.name, type: "dm")
                    } label: {
                        DmRow(dm: dm, names: names)
                    }
                    .buttonStyle(.plain)
                    .swipeActions(edge: .leading, allowsFullSwipe: false) {
                        Button {
                            toggleMute(dm)
                        } label: {
                            Label(dm.isMuted ? ChatStrings.dmsUnmute : ChatStrings.dmsMute, systemImage: dm.isMuted ? "bell" : "bell.slash")
                        }
                        .tint(.gray)
                        Button {
                            togglePin(dm)
                        } label: {
                            Label(dm.isPinned ? ChatStrings.dmsUnpin : ChatStrings.dmsPin, systemImage: dm.isPinned ? "pin.slash" : "pin")
                        }
                        .tint(Tokens.Palette.primary)
                    }
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button(role: .destructive) {
                            remove(dm)
                        } label: {
                            Label(CoreStrings.commonDelete, systemImage: "trash")
                        }
                        Button {
                            archive(dm)
                        } label: {
                            Label(ChatStrings.dmsArchive, systemImage: "archivebox")
                        }
                        .tint(.orange)
                    }
                    .conversationMenu(.dm(dm), store: store) { id, patch in
                        if patch.archived == false {
                            Task { await store.loadDmList() }
                            return
                        }
                        store.patchDm(id, patch)
                    }
                    .accessibilityIdentifier("dm-row-\(dm.id)")
                }
            }
        }
        .listStyle(.plain)
        .navigationTitle(ChatStrings.tabsDirectMessages)
        .refreshable { await store.loadDmList() }
        .task {
            await store.loadDmList()
            await store.loadRosterIfNeeded()
        }
        .overlay(alignment: .bottomTrailing) {
            Menu {
                Button {
                    navigator.sheet = .newMessage
                } label: {
                    Label(ChatStrings.homeComposeMessage, systemImage: "square.and.pencil")
                }
                .accessibilityIdentifier("compose-message")
                Button {
                    navigator.sheet = .newDm(group: true)
                } label: {
                    Label(ChatStrings.dmsComposeGroup, systemImage: "person.2")
                    Text(ChatStrings.dmsComposeGroupHint)
                }
                .accessibilityIdentifier("compose-group")
            } label: {
                Image(systemName: "square.and.pencil")
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 56, height: 56)
                    .background(Tokens.Palette.primary, in: Circle())
                    .shadow(radius: 4, y: 2)
            }
            .accessibilityLabel(ChatStrings.dmsNewDm)
            .accessibilityIdentifier("dms-compose")
            .padding(Tokens.Spacing.l)
        }
    }

    private func chip(_ value: DmLogic.Filter, _ title: String) -> some View {
        FilterChip(title: title, selected: filter == value) { filter = value }
            .accessibilityIdentifier("dms-filter-\(value.rawValue)")
    }

    private func toggleMute(_ dm: DmConversation) {
        let next = !dm.isMuted
        store.patchDm(dm.id, ConversationPatch(isMuted: next))
        Task {
            do {
                try await store.updateMembership(channelID: dm.id, isMuted: next)
            } catch {
                store.patchDm(dm.id, ConversationPatch(isMuted: !next))
            }
        }
    }

    private func togglePin(_ dm: DmConversation) {
        let next = !dm.isPinned
        store.patchDm(dm.id, ConversationPatch(isPinned: next))
        Task {
            do {
                try await store.pinDm(dm.id, pinned: next)
            } catch {
                store.patchDm(dm.id, ConversationPatch(isPinned: !next))
            }
        }
    }

    private func archive(_ dm: DmConversation) {
        store.removeDm(dm.id)
        Task {
            do {
                try await store.setArchived(dm.id, archived: true)
            } catch {
                await store.loadDmList()
            }
        }
    }

    private func remove(_ dm: DmConversation) {
        store.removeDm(dm.id)
        Task {
            do {
                try await store.leaveDm(dm.id)
            } catch {
                await store.loadDmList()
            }
        }
    }
}

/// A row of the DM list: avatar(s) with a pin, name and time, the latest message.
private struct DmRow: View {
    let dm: DmConversation
    let names: [String: String]

    var body: some View {
        HStack(alignment: .top, spacing: Tokens.Spacing.m) {
            DmAvatar(dm: dm, size: 44)
                .overlay(alignment: .bottomTrailing) {
                    if dm.isPinned {
                        Image(systemName: "pin.fill")
                            .font(.system(size: 8))
                            .foregroundStyle(.white)
                            .padding(3)
                            .background(Tokens.Palette.primary, in: Circle())
                    }
                }
            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text(dm.name)
                        .font(dm.hasUnread ? .body.weight(.bold) : .body.weight(.semibold))
                        .lineLimit(1)
                    Spacer()
                    Text(ChatDates.listTime(dm.lastMessageAt))
                        .font(.inter(.caption))
                        .foregroundStyle(dm.hasUnread ? Tokens.Palette.primary : Color.secondary)
                }
                HStack(alignment: .top) {
                    Text(dm.lastMessagePreview.map { MentionText.plainText($0, names: names) } ?? ChatStrings.dmsNoMessagesPreview)
                        .font(.inter(.subheadline))
                        .foregroundStyle(dm.hasUnread ? Color.primary : Color.secondary)
                        .lineLimit(2)
                    Spacer()
                    if dm.isMuted { Image(systemName: "bell.slash").font(.inter(.caption)).foregroundStyle(.secondary) }
                    if dm.hasUnread, dm.unreadCount > 0 { CountBadge(count: dm.unreadCount) }
                }
            }
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
    }
}
