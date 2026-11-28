import SwiftUI
import UIKit
import WeldCore
import WeldUI

// MARK: - Colours

/// The colours the web platform's WeldChat module uses for its own states,
/// as the Tailwind shades in its code (light, dark). Everything else comes
/// from `Tokens.Palette`.
enum ChatColors {
    /// A colour with a light and a dark variant (`0xRRGGBB` and an opacity each), following the in-app appearance.
    static func dynamic(_ light: UInt32, _ dark: UInt32, lightOpacity: CGFloat = 1, darkOpacity: CGFloat = 1) -> Color {
        Color(uiColor: UIColor { traits in
            let isDark = traits.userInterfaceStyle == .dark
            return ChatColors.uiColor(isDark ? dark : light, alpha: isDark ? darkOpacity : lightOpacity)
        })
    }

    static func uiColor(_ rgb: UInt32, alpha: CGFloat = 1) -> UIColor {
        UIColor(
            red: CGFloat((rgb >> 16) & 0xFF) / 255,
            green: CGFloat((rgb >> 8) & 0xFF) / 255,
            blue: CGFloat(rgb & 0xFF) / 255,
            alpha: alpha
        )
    }

    /// A mention in a message: `bg-blue-50 text-blue-600` (`blue-950`, `blue-400` dark).
    static let mentionText = dynamic(0x2563EB, 0x60A5FA)
    static let mentionFill = dynamic(0xEFF6FF, 0x172554)
    /// A message that mentions you: `bg-yellow-50/60` and a `yellow-400` bar on its left edge.
    static let mentionedRow = dynamic(0xFEFCE8, 0x713F12, lightOpacity: 0.6, darkOpacity: 0.1)
    static let mentionedBar = dynamic(0xFACC15, 0xEAB308)
    /// A message flashed after a jump to it (`rgba(59,130,246,.12)`).
    static let flash = Color(hex: 0x3B82F6).opacity(0.12)
    /// Your own reaction: `bg-blue-600/10 border-blue-600/40 text-blue-600`.
    static let reactionMine = Color(hex: 0x2563EB)
    /// The unread count (`CountBadge`): `bg-red-500`.
    static let count = Color(hex: 0xEF4444)
    /// A call that ran (`text-green-600`) and one that was missed (`text-red-600`).
    static let callGreen = dynamic(0x16A34A, 0x4ADE80)
    static let callRed = dynamic(0xDC2626, 0xF87171)
    /// The platform's Join on a running call (`bg-green-600`).
    static let joinGreen = Color(hex: 0x16A34A)
    /// An unread activity row: `bg-blue-50/40` (`blue-950/20` dark) and a `blue-500` bar.
    static let activityUnread = dynamic(0xEFF6FF, 0x172554, lightOpacity: 0.4, darkOpacity: 0.2)
    static let activityBar = Color(hex: 0x3B82F6)
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

// MARK: - Avatars and badges

/// The platform's avatar shape: a rounded square, its corners a third of its width (`rounded-[32%]`).
struct AvatarShape: Shape {
    func path(in rect: CGRect) -> Path {
        Path(roundedRect: rect, cornerRadius: min(rect.width, rect.height) * 0.32, style: .continuous)
    }
}

/// A person's picture or, without one (or while it loads), the first
/// letter of their name in white on the colour the platform gives that
/// name, in the platform's rounded square.
struct ChatAvatar: View {
    let name: String?
    let url: String?
    var size: CGFloat = 36

    var body: some View {
        Group {
            if let address = url, !address.isEmpty, let link = URL(string: address) {
                AsyncImage(url: link) { phase in
                    if let image = phase.image {
                        image.resizable().scaledToFill()
                    } else {
                        fallback
                    }
                }
            } else {
                fallback
            }
        }
        .frame(width: size, height: size)
        .clipShape(AvatarShape())
        .accessibilityHidden(true)
    }

    private var fallback: some View {
        Text(Self.initial(of: name))
            .font(.inter(size: size * 0.42, weight: .medium))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(PlatformColors.avatar(name ?? ""))
    }

    /// The platform's fallback: the name's first letter (`(name || '?')[0].toUpperCase()`).
    static func initial(of name: String?) -> String {
        guard let first = name?.trimmingCharacters(in: .whitespaces).first else { return "?" }
        return String(first).uppercased()
    }
}

/// A group conversation: two avatars overlapping (the platform's sidebar).
struct GroupAvatar: View {
    let people: [DmPerson]
    var size: CGFloat = 40

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            ChatAvatar(name: people.first?.displayName, url: people.first?.picture, size: size * 0.66)
                .frame(width: size, height: size, alignment: .topLeading)
            if people.count > 1 {
                ChatAvatar(name: people[1].displayName, url: people[1].picture, size: size * 0.66)
                    .overlay(AvatarShape().stroke(Tokens.Palette.background, lineWidth: 1.5))
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

/// The platform's `CountBadge`: a red circle for one digit, a pill for more, "99+" above 99.
struct CountBadge: View {
    let count: Int

    var body: some View {
        if count > 0 {
            let text = count > 99 ? "99+" : "\(count)"
            Text(text)
                .font(.inter(size: 11, weight: .semibold))
                .monospacedDigit()
                .foregroundStyle(.white)
                .padding(.horizontal, 4)
                .frame(minWidth: text.count == 1 ? 18 : (text.count == 2 ? 24 : 30), minHeight: 18)
                .background(ChatColors.count, in: Capsule())
        }
    }
}

/// The platform's empty state icon: the symbol in a muted rounded square.
struct EmptyIcon: View {
    let symbol: String

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: 20))
            .foregroundStyle(Tokens.Palette.mutedForeground)
            .frame(width: 48, height: 48)
            .background(Tokens.Palette.muted, in: RoundedRectangle(cornerRadius: Tokens.Radius.xlarge))
    }
}

// MARK: - Message text

enum MessageTextStyle {
    /// Mentions as the platform's blue chips and links underlined in the primary colour, for a `Text`.
    static func attributed(_ text: String, names: [String: String]) -> AttributedString {
        var result = AttributedString()
        for run in MentionText.runs(text, names: names) {
            switch run {
            case let .plain(value):
                result += AttributedString(value)
            case let .link(value, url):
                var part = AttributedString(value)
                part.link = url
                part.underlineStyle = .single
                part.foregroundColor = Tokens.Palette.primary
                result += part
            case let .mention(value):
                var part = AttributedString(value)
                part.font = .inter(.subheadline, weight: .medium)
                part.foregroundColor = ChatColors.mentionText
                part.backgroundColor = ChatColors.mentionFill
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
                        .font(.inter(.subheadline))
                        .foregroundStyle(Tokens.Palette.foreground)
                        .tint(Tokens.Palette.primary)
                        .textSelection(.enabled)
                case let .file(id):
                    if let file = byID[id] { attachment(file) }
                }
            }
        }
    }
}

// MARK: - Lists

/// The list's empty state, as the platform's: the icon in a muted rounded
/// square, a semibold title and a muted description.
struct ChatEmptyState: View {
    let title: String
    var description: String?
    var symbol = "bubble.left.and.bubble.right"

    var body: some View {
        VStack(spacing: Tokens.Spacing.s) {
            EmptyIcon(symbol: symbol)
                .padding(.bottom, Tokens.Spacing.xs)
            Text(title)
                .font(.inter(.callout, weight: .semibold))
                .multilineTextAlignment(.center)
            if let description {
                Text(description)
                    .font(.inter(.subheadline))
                    .foregroundStyle(Tokens.Palette.mutedForeground)
                    .multilineTextAlignment(.center)
            }
        }
        .padding(.horizontal, Tokens.Spacing.xl)
        .padding(.vertical, 48)
        .frame(maxWidth: .infinity)
    }
}

/// A search field that opens the Search screen: the platform's bordered input.
struct SearchButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: Tokens.Spacing.s) {
                Image(systemName: "magnifyingglass").font(.system(size: 15))
                Text(CoreStrings.commonSearch).font(.inter(.subheadline))
                Spacer()
            }
            .foregroundStyle(Tokens.Palette.mutedForeground)
            .padding(.horizontal, Tokens.Spacing.m)
            .padding(.vertical, 9)
            .background(Tokens.Palette.background, in: RoundedRectangle(cornerRadius: Tokens.Radius.medium))
            .overlay(RoundedRectangle(cornerRadius: Tokens.Radius.medium).stroke(Tokens.Palette.input, lineWidth: 1))
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
            .foregroundStyle(selected ? Tokens.Palette.primaryForeground : Tokens.Palette.foreground)
            .background(selected ? Tokens.Palette.primary : Tokens.Palette.background, in: RoundedRectangle(cornerRadius: Tokens.Radius.medium))
            .overlay(RoundedRectangle(cornerRadius: Tokens.Radius.medium).stroke(selected ? Color.clear : Tokens.Palette.border, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// A list's group header, as the platform's lists draw one (WeldDesk's
/// "Last week 2"): a muted band with a hairline under it, the label small
/// and medium-weight, the count in a small bordered chip.
struct ListGroupHeader: View {
    let label: String
    var count: Int?

    var body: some View {
        HStack(spacing: Tokens.Spacing.s) {
            Text(label)
                .font(.inter(.caption, weight: .medium))
                .foregroundStyle(Tokens.Palette.mutedForeground)
                .lineLimit(1)
            if let count {
                Text("\(count)")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(Tokens.Palette.mutedForeground)
                    .padding(.horizontal, 4)
                    .frame(minWidth: 16, minHeight: 16)
                    .background(Tokens.Palette.muted, in: RoundedRectangle(cornerRadius: 5))
                    .overlay(RoundedRectangle(cornerRadius: 5).stroke(Tokens.Palette.border, lineWidth: 1))
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Tokens.Spacing.l)
        .frame(height: 32)
        .background(Tokens.Palette.muted.opacity(0.5))
        .background(Tokens.Palette.background)
        .overlay(alignment: .bottom) { Rectangle().fill(Tokens.Palette.border.opacity(0.7)).frame(height: 1) }
        .accessibilityAddTraits(.isHeader)
    }
}

/// A group's header in the platform's sidebar: a small medium-weight muted
/// label (semibold in the foreground while the group has unread
/// conversations), the unread count, the mentions in red, and a chevron
/// when it folds.
struct SidebarGroupHeader<Trailing: View>: View {
    let title: String
    var collapsed: Bool?
    var unread = 0
    var mentions = 0
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        HStack(spacing: 4) {
            Text(title)
                .font(.inter(.caption, weight: unread > 0 ? .semibold : .medium))
                .foregroundStyle(unread > 0 ? Tokens.Palette.foreground : Tokens.Palette.mutedForeground)
                .lineLimit(1)
            if unread > 0 {
                Text("\(unread)").font(.inter(size: 11)).foregroundStyle(Tokens.Palette.mutedForeground)
            }
            CountBadge(count: mentions).padding(.leading, 2)
            if let collapsed {
                Image(systemName: "chevron.down")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Tokens.Palette.mutedForeground)
                    .rotationEffect(.degrees(collapsed ? -90 : 0))
            }
            Spacer(minLength: 0)
            trailing()
        }
        .textCase(nil)
        .frame(minHeight: 28)
        .contentShape(Rectangle())
        .accessibilityAddTraits(.isHeader)
    }
}

extension SidebarGroupHeader where Trailing == EmptyView {
    init(title: String, collapsed: Bool? = nil, unread: Int = 0, mentions: Int = 0) {
        self.init(title: title, collapsed: collapsed, unread: unread, mentions: mentions) { EmptyView() }
    }
}

/// The platform's dashed "+ Add channel" under a section with no channels.
struct AddPlaceholderRow: View {
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: Tokens.Spacing.s) {
                Image(systemName: "plus").font(.system(size: 13, weight: .medium))
                Text(label).font(.inter(.caption))
            }
            .foregroundStyle(Tokens.Palette.mutedForeground)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .overlay(
                RoundedRectangle(cornerRadius: Tokens.Radius.medium)
                    .stroke(Tokens.Palette.input, style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Conversation rows

/// A conversation row as in the platform's sidebar: a small icon or avatar,
/// the name (semibold in the foreground while unread, else muted), a muted
/// conversation's bell and the red mention count.
struct SidebarRow<Leading: View>: View {
    let title: String
    let unread: Bool
    var muted = false
    var mentions = 0
    @ViewBuilder var leading: () -> Leading

    var body: some View {
        HStack(spacing: 10) {
            leading().frame(width: 20, height: 20)
            Text(title)
                .font(.inter(.subheadline, weight: unread ? .semibold : .regular))
                .foregroundStyle(unread ? Tokens.Palette.foreground : Tokens.Palette.mutedForeground)
                .lineLimit(1)
            Spacer(minLength: 0)
            if muted { Image(systemName: "bell.slash").font(.system(size: 12)).foregroundStyle(Tokens.Palette.mutedForeground) }
            CountBadge(count: mentions)
        }
        .frame(minHeight: 32)
        .contentShape(Rectangle())
    }
}

/// A sidebar row's icon, in the row's colour.
struct SidebarIcon: View {
    let symbol: String
    var unread = false

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: 15))
            .foregroundStyle(unread ? Tokens.Palette.foreground : Tokens.Palette.mutedForeground)
    }
}

/// A channel row: # or lock, the name, the mentions.
struct ChannelRowView: View {
    let channel: ChatChannel

    var body: some View {
        let unread = ChatLogic.isChannelUnread(channel)
        SidebarRow(title: channel.name, unread: unread, muted: channel.isMuted, mentions: channel.unreadMentionCount) {
            SidebarIcon(symbol: channel.isPrivate ? "lock" : "number", unread: unread)
        }
    }
}

/// A record chat row on Home: the type's icon and the record's name.
struct RecordChatRowView: View {
    let chat: RecordChat

    var body: some View {
        let unread = RecordChatRules.isUnread(chat) || RecordChatRules.hasUnreadMentions(chat)
        SidebarRow(title: chat.displayName, unread: unread, muted: chat.isMuted, mentions: chat.unreadMentionCount) {
            SidebarIcon(symbol: RecordChatRules.symbol(chat.entityType), unread: unread)
        }
    }
}

/// A DM row on Home: the avatar(s), the name, bold while unread.
struct DmCompactRow: View {
    let dm: DmConversation

    var body: some View {
        SidebarRow(title: dm.name, unread: dm.hasUnread && !dm.isMuted, muted: dm.isMuted) {
            DmAvatar(dm: dm, size: 20)
        }
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
