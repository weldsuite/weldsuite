import SwiftUI
import UIKit
import WeldCore
import WeldUI

/// A person's picture or initials, in WeldChat's colour.
struct ChatAvatar: View {
    let name: String?
    let url: String?
    var size: CGFloat = 36

    var body: some View {
        AvatarView(name: name, url: url.flatMap(URL.init(string:)), size: size)
    }
}

/// A group conversation: two avatars overlapping.
struct GroupAvatar: View {
    let people: [DmPerson]
    var size: CGFloat = 40

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            ChatAvatar(name: people.first?.displayName, url: people.first?.picture, size: size * 0.72)
                .frame(width: size, height: size, alignment: .topLeading)
            if people.count > 1 {
                ChatAvatar(name: people[1].displayName, url: people[1].picture, size: size * 0.72)
                    .overlay(Circle().stroke(Color(.systemBackground), lineWidth: 2))
            }
        }
        .frame(width: size, height: size)
    }
}

/// A DM's avatar: the person, or two for a group.
struct DmAvatar: View {
    let dm: DmConversation
    var size: CGFloat = 40

    var body: some View {
        if dm.isGroup {
            GroupAvatar(people: dm.otherMembers, size: size)
        } else {
            ChatAvatar(name: dm.name, url: dm.picture, size: size)
        }
    }
}

/// An unread count on a brand capsule.
struct CountBadge: View {
    let count: Int
    var prefix = ""

    var body: some View {
        Text("\(prefix)\(count)")
            .font(.inter(.caption2, weight: .bold))
            .foregroundStyle(.white)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Tokens.Palette.primary, in: Capsule())
    }
}

struct UnreadDot: View {
    var body: some View {
        Circle().fill(Tokens.Palette.primary).frame(width: 8, height: 8)
    }
}

/// A colour from `0xRRGGBB`.
extension Color {
    init(hex: UInt32) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
    }
}

// MARK: - Message text

enum MessageTextStyle {
    /// Mentions as badges and links as links, for a `Text`.
    static func attributed(_ text: String, names: [String: String]) -> AttributedString {
        var result = AttributedString()
        for run in MentionText.runs(text, names: names) {
            switch run {
            case let .plain(value):
                result += AttributedString(value)
            case let .link(value, url):
                var part = AttributedString(value)
                part.link = url
                result += part
            case let .mention(value):
                var part = AttributedString(value)
                part.font = .body.weight(.semibold)
                part.foregroundColor = Color(hex: 0x5865F2)
                part.backgroundColor = Color(hex: 0x5865F2).opacity(0.15)
                result += part
            }
        }
        return result
    }
}

/// A message body: text runs and, at their `<@file:…>` spots, its attachments.
struct MessageBody: View {
    let message: ChatMessage
    let names: [String: String]
    let attachment: (ChatAttachment) -> AnyView

    var body: some View {
        let byID = Dictionary(message.attachments.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let blocks = MentionText.blocks(message.content, attachmentIDs: Set(byID.keys))
        VStack(alignment: .leading, spacing: Tokens.Spacing.xs) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case let .text(text):
                    Text(MessageTextStyle.attributed(text, names: names))
                        .font(.inter(.body))
                        .textSelection(.enabled)
                case let .file(id):
                    if let file = byID[id] { attachment(file) }
                }
            }
        }
    }
}

// MARK: - Lists

/// The list's empty state, with an icon.
struct ChatEmptyState: View {
    let title: String
    var description: String?
    var symbol = "bubble.left.and.bubble.right"

    var body: some View {
        ContentUnavailableView {
            Label(title, systemImage: symbol)
        } description: {
            if let description { Text(description) }
        }
    }
}

/// A search field that opens the Search screen.
struct SearchButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: Tokens.Spacing.s) {
                Image(systemName: "magnifyingglass")
                Text(CoreStrings.commonSearch)
                Spacer()
            }
            .foregroundStyle(.secondary)
            .padding(.horizontal, Tokens.Spacing.m)
            .padding(.vertical, 9)
            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: Tokens.Radius.medium))
        }
        .buttonStyle(.plain)
    }
}

/// A chip of a filter row.
struct FilterChip: View {
    let title: String
    let selected: Bool
    var symbol: String?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                if let symbol { Image(systemName: symbol).font(.inter(.caption)) }
                Text(title).font(.inter(.subheadline, weight: .medium))
            }
            .padding(.horizontal, Tokens.Spacing.m)
            .padding(.vertical, 6)
            .foregroundStyle(selected ? Color.white : Color.primary)
            .background(selected ? Tokens.Palette.primary : Color(.secondarySystemBackground), in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

// MARK: - Conversation rows

/// A channel row: # or lock, the name, the mentions.
struct ChannelRowView: View {
    let channel: ChatChannel

    var body: some View {
        let unread = ChatLogic.isChannelUnread(channel)
        HStack(spacing: Tokens.Spacing.m) {
            Image(systemName: channel.isPrivate ? "lock" : "number")
                .frame(width: 22)
                .foregroundStyle(unread ? Color.primary : Color.secondary)
            Text(channel.name)
                .font(unread ? .body.weight(.semibold) : .body)
                .foregroundStyle(unread ? Color.primary : Color.secondary)
                .lineLimit(1)
            Spacer()
            if channel.isMuted { Image(systemName: "bell.slash").font(.inter(.caption)).foregroundStyle(.secondary) }
            if channel.unreadMentionCount > 0 { CountBadge(count: channel.unreadMentionCount) }
        }
        .contentShape(Rectangle())
    }
}

/// A record chat row on Home: the type's icon and the record's name.
struct RecordChatRowView: View {
    let chat: RecordChat

    var body: some View {
        let unread = RecordChatRules.isUnread(chat) || RecordChatRules.hasUnreadMentions(chat)
        HStack(spacing: Tokens.Spacing.m) {
            Image(systemName: RecordChatRules.symbol(chat.entityType))
                .frame(width: 22)
                .foregroundStyle(unread ? Color.primary : Color.secondary)
            Text(chat.displayName)
                .font(unread ? .body.weight(.semibold) : .body)
                .foregroundStyle(unread ? Color.primary : Color.secondary)
                .lineLimit(1)
            Spacer()
            if chat.isMuted { Image(systemName: "bell.slash").font(.inter(.caption)).foregroundStyle(.secondary) }
            if chat.unreadMentionCount > 0 { CountBadge(count: chat.unreadMentionCount) }
        }
        .contentShape(Rectangle())
    }
}

/// A DM row on Home: the avatar(s), the name, a dot when unread.
struct DmCompactRow: View {
    let dm: DmConversation

    var body: some View {
        let unread = dm.hasUnread && !dm.isMuted
        HStack(spacing: Tokens.Spacing.m) {
            DmAvatar(dm: dm, size: 26)
            Text(dm.name)
                .font(unread ? .body.weight(.semibold) : .body)
                .foregroundStyle(unread ? Color.primary : Color.secondary)
                .lineLimit(1)
            Spacer()
            if unread { UnreadDot() }
        }
        .contentShape(Rectangle())
    }
}

// MARK: - Conversation menu

/// What a conversation's long-press menu acts on.
enum ConversationTarget {
    case channel(ChatChannel)
    case dm(DmConversation)
    case record(RecordChat)

    var id: String {
        switch self {
        case let .channel(channel): channel.id
        case let .dm(dm): dm.id
        case let .record(chat): chat.id
        }
    }
}

/// The long-press menu of a channel, DM or record chat, as in Slack and
/// Discord: mark read, mute, notifications, pin, invite, copy link,
/// details, archive, open the record, follow. Changes show at once and are
/// put back, with a toast, when the request fails.
struct ConversationMenu: ViewModifier {
    let target: ConversationTarget
    let store: ChatStore
    let onChange: (String, ConversationPatch) -> Void

    @Environment(Toaster.self) private var toaster
    @Environment(ChatNavigator.self) private var navigator

    func body(content: Content) -> some View {
        content
            .contextMenu { menu }
            .simultaneousGesture(LongPressGesture(minimumDuration: 0.2).onEnded { _ in prefetch() })
    }

    @ViewBuilder private var menu: some View {
        switch target {
        case let .channel(channel):
            Button { markRead() } label: { Label(ChatStrings.conversationMenuMarkRead, systemImage: "envelope.open") }
                .disabled(!ChatLogic.isChannelUnread(channel))
            Button {
                navigator.sheet = .invitePeople(channelID: channel.id, name: channel.name)
            } label: { Label(ChatStrings.conversationMenuInvite, systemImage: "person.badge.plus") }
            copyLinkButton(isDM: false, peer: nil)
            muteButton(muted: channel.isMuted)
            notificationsMenu
            Button {
                navigator.open(.channelInfo(channelID: channel.id, name: channel.name))
            } label: { Label(ChatStrings.conversationMenuChannelDetails, systemImage: "info.circle") }
        case let .dm(dm):
            Button { markRead() } label: { Label(ChatStrings.conversationMenuMarkRead, systemImage: "envelope.open") }
                .disabled(!dm.hasUnread)
            Button {
                apply(ConversationPatch(isPinned: !dm.isPinned), revert: ConversationPatch(isPinned: dm.isPinned)) {
                    try await store.pinDm(dm.id, pinned: !dm.isPinned)
                }
            } label: {
                Label(dm.isPinned ? ChatStrings.conversationMenuUnpin : ChatStrings.conversationMenuPin, systemImage: dm.isPinned ? "pin.slash" : "pin")
            }
            muteButton(muted: dm.isMuted)
            notificationsMenu
            if let peer = dm.peerUserID {
                Button {
                    navigator.open(.member(userID: peer))
                } label: { Label(ChatStrings.conversationMenuViewProfile, systemImage: "person.crop.circle") }
            }
            copyLinkButton(isDM: true, peer: dm.peerUserID)
            Button {
                apply(ConversationPatch(archived: true), revert: ConversationPatch(archived: false)) {
                    try await store.setArchived(dm.id, archived: true)
                }
            } label: { Label(ChatStrings.conversationMenuArchive, systemImage: "archivebox") }
        case let .record(chat):
            Button { markRead() } label: { Label(ChatStrings.conversationMenuMarkRead, systemImage: "envelope.open") }
                .disabled(!(chat.isFollowing && RecordChatRules.needsAttention(chat)))
            if let app = RecordChatRules.app(for: chat.entityType) {
                Button {
                    Task { await RecordOpener.open(type: chat.entityType, entityID: chat.entityID, store: store, toaster: toaster) }
                } label: { Label(ChatStrings.recordChatsOpenIn(app: app), systemImage: "arrow.up.forward.app") }
            }
            copyLinkButton(isDM: false, peer: nil)
            if chat.isFollowing {
                muteButton(muted: chat.isMuted)
                notificationsMenu
            }
            Button {
                let next = !chat.isFollowing
                store.forgetMembership(chat.id)
                apply(ConversationPatch(isFollowing: next), revert: ConversationPatch(isFollowing: !next)) {
                    try await store.setFollowing(entityType: chat.entityType, entityID: chat.entityID, following: next)
                }
            } label: {
                Label(chat.isFollowing ? ChatStrings.recordChatsUnfollow : ChatStrings.recordChatsFollow, systemImage: chat.isFollowing ? "minus.circle" : "plus.circle")
            }
        }
    }

    private func muteButton(muted: Bool) -> some View {
        Button {
            let id = target.id
            apply(ConversationPatch(isMuted: !muted), revert: ConversationPatch(isMuted: muted)) {
                try await store.updateMembership(channelID: id, isMuted: !muted)
            }
        } label: {
            Label(muted ? ChatStrings.conversationMenuUnmute : ChatStrings.conversationMenuMute, systemImage: muted ? "bell" : "bell.slash")
        }
    }

    private var notificationsMenu: some View {
        let level = store.cachedMembership(target.id)?.notificationPreference
        return Menu {
            levelButton(.all, title: ChatStrings.conversationMenuNotifyAll, current: level)
            levelButton(.mentions, title: ChatStrings.conversationMenuNotifyMentions, current: level)
            levelButton(.none, title: ChatStrings.conversationMenuNotifyNone, current: level)
        } label: {
            Label(ChatStrings.conversationMenuNotifications, systemImage: "bell.badge")
        }
    }

    private func levelButton(_ level: NotificationLevel, title: String, current: NotificationLevel?) -> some View {
        Button {
            let id = target.id
            Task {
                do {
                    try await store.updateMembership(channelID: id, level: level)
                } catch {
                    toaster.show(ChatStrings.conversationMenuFailed)
                }
            }
        } label: {
            if current == level {
                Label(title, systemImage: "checkmark")
            } else {
                Text(title)
            }
        }
    }

    private func copyLinkButton(isDM: Bool, peer: String?) -> some View {
        Button {
            UIPasteboard.general.string = ChatLogic.conversationWebURL(origin: store.env.serverURL, channelID: target.id, isDM: isDM, peerUserID: peer)
            toaster.show(ChatStrings.conversationMenuLinkCopied)
        } label: {
            Label(ChatStrings.conversationMenuCopyLink, systemImage: "link")
        }
    }

    private func markRead() {
        let id = target.id
        apply(ConversationPatch(hasUnread: false), revert: ConversationPatch(hasUnread: true)) {
            try await store.markRead(id)
        }
    }

    /// The notification level, loaded as the long-press starts so the menu can tick it.
    private func prefetch() {
        if case let .record(chat) = target, !chat.isFollowing { return }
        let id = target.id
        Task { _ = try? await store.membership(id) }
    }

    private func apply(_ patch: ConversationPatch, revert: ConversationPatch, request: @escaping () async throws -> Void) {
        let id = target.id
        onChange(id, patch)
        Task {
            do {
                try await request()
            } catch {
                onChange(id, revert)
                toaster.show(ChatStrings.conversationMenuFailed)
            }
        }
    }
}

extension View {
    func conversationMenu(_ target: ConversationTarget, store: ChatStore, onChange: @escaping (String, ConversationPatch) -> Void) -> some View {
        modifier(ConversationMenu(target: target, store: store, onChange: onChange))
    }
}

/// Opens a record chat's record in its own app (WeldCRM, WeldFlow); says so when it can't.
@MainActor
enum RecordOpener {
    static func open(type: String, entityID: String, store: ChatStore, toaster: Toaster) async {
        guard let app = RecordChatRules.app(for: type) else { return }
        var projectID: String?
        if type == "task" { projectID = await store.recordProjectID(entityType: type, entityID: entityID) }
        guard let link = RecordChatRules.appLink(type: type, entityID: entityID, projectID: projectID) else {
            toaster.show(ChatStrings.recordChatsOpenFailed(app: app))
            return
        }
        let opened = await UIApplication.shared.open(link.url)
        if !opened { toaster.show(ChatStrings.recordChatsAppMissingTitle(app: app)) }
    }
}
