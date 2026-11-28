import os
import SwiftUI
import UIKit
import WeldCore
import WeldUI

/// What a message row can do, handed down from the channel screen.
struct MessageRowActions {
    var openActions: (ChatMessage) -> Void = { _ in }
    var reply: (ChatMessage) -> Void = { _ in }
    var toggleReaction: (ChatMessage, String) -> Void = { _, _ in }
    var openImage: (String) -> Void = { _ in }
    var openProfile: (String) -> Void = { _ in }
    var openThread: (ChatMessage) -> Void = { _ in }
    var jumpTo: (String) -> Void = { _ in }
}

/// The sizes of a message row, as the platform's (`h-7` avatar, a little larger on a phone).
enum MessageMetrics {
    static let avatar: CGFloat = 32
    static let avatarGap: CGFloat = 10
    static let rowPadding: CGFloat = Tokens.Spacing.m
}

/// One message as the platform draws it (Slack-style rows, no bubbles):
/// the line to what it replies to, the avatar and the name with the time
/// (unless it continues the previous one), the text with mentions and
/// links, attachments, the agent's visuals, reactions and "N replies". A
/// message that mentions you has a yellow wash and bar. Hold for its
/// actions, drag right to reply.
struct MessageRow: View {
    let message: ChatMessage
    let compact: Bool
    let names: [String: String]
    let selfID: String
    var highlighted = false
    var interactive = true
    var actions = MessageRowActions()

    @State private var dragX: CGFloat = 0

    private var mentioned: Bool { ChatLogic.mentionsUser(message.content, userID: selfID) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !compact, let reply = message.replyTo {
                ReplyQuoteView(reply: reply, names: names) { actions.jumpTo(reply.messageID) }
            }
            HStack(alignment: .top, spacing: MessageMetrics.avatarGap) {
                if compact {
                    Color.clear.frame(width: MessageMetrics.avatar, height: 1)
                } else {
                    Button {
                        actions.openProfile(message.authorID)
                    } label: {
                        MessageAvatar(message: message)
                    }
                    .buttonStyle(.plain)
                    .padding(.top, 2)
                    .disabled(message.isAgent || message.authorID.isEmpty || !interactive)
                    .accessibilityLabel(message.authorName)
                }
                VStack(alignment: .leading, spacing: 2) {
                    if !compact { header }
                    MessageExtras(message: message, names: names, selfID: selfID, actions: actions, showEdited: compact)
                    if message.threadReplyCount > 0 {
                        ThreadSummary(message: message) { actions.openThread(message) }
                    }
                }
                Spacer(minLength: 0)
            }
        }
        .padding(.horizontal, MessageMetrics.rowPadding)
        .padding(.top, compact ? 2 : 14)
        .padding(.bottom, 2)
        .background(highlighted ? ChatColors.flash : (mentioned ? ChatColors.mentionedRow : Color.clear))
        .overlay(alignment: .leading) {
            if mentioned { Rectangle().fill(ChatColors.mentionedBar).frame(width: 2) }
        }
        .offset(x: dragX)
        .background(alignment: .leading) {
            if dragX > 10 {
                Image(systemName: "arrowshape.turn.up.left.fill")
                    .foregroundStyle(Tokens.Palette.mutedForeground)
                    .opacity(min(1, dragX / 60))
                    .padding(.leading, 12)
            }
        }
        .contentShape(Rectangle())
        .onLongPressGesture(minimumDuration: 0.45) {
            guard interactive, !message.pending else { return }
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            actions.openActions(message)
        }
        .simultaneousGesture(
            DragGesture(minimumDistance: 20)
                .onChanged { value in
                    guard interactive, !message.pending, value.translation.width > 0,
                          abs(value.translation.width) > abs(value.translation.height) else { return }
                    let next = min(90, value.translation.width)
                    if dragX < 60, next >= 60 { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
                    dragX = next
                }
                .onEnded { _ in
                    if dragX >= 60 {
                        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                        actions.reply(message)
                    }
                    withAnimation(.spring(response: 0.3)) { dragX = 0 }
                }
        )
        .accessibilityIdentifier("message-\(message.id)")
    }

    /// The author, an agent's badge, the time, "(edited)", and a spinner while it sends.
    private var header: some View {
        HStack(spacing: Tokens.Spacing.s) {
            Text(message.authorName).font(.inter(.subheadline, weight: .semibold)).lineLimit(1)
            if message.isAgent { AgentBadge() }
            Text(ChatDates.time(message.date)).font(.inter(.caption)).foregroundStyle(Tokens.Palette.mutedForeground)
            if message.editedAt != nil {
                Text(ChatStrings.channelEdited).font(.inter(.caption)).foregroundStyle(Tokens.Palette.mutedForeground)
            }
            if message.pending { ProgressView().controlSize(.mini) }
        }
    }
}

/// "Agent", next to an agent's name: the platform's small secondary badge.
struct AgentBadge: View {
    var body: some View {
        Text(ChatStrings.channelAgentBadge)
            .font(.inter(size: 10))
            .foregroundStyle(Tokens.Palette.secondaryForeground)
            .padding(.horizontal, 4)
            .padding(.vertical, 1)
            .background(Tokens.Palette.secondary, in: RoundedRectangle(cornerRadius: Tokens.Radius.small))
    }
}

/// The text, an agent's visuals, attachments and reactions; "(edited)" here when the row has no header.
private struct MessageExtras: View {
    let message: ChatMessage
    let names: [String: String]
    let selfID: String
    let actions: MessageRowActions
    let showEdited: Bool

    var body: some View {
        let inline = Set(MentionText.fileTokenIDs(message.content))
        let gallery = message.attachments.filter { !inline.contains($0.id) }
        VStack(alignment: .leading, spacing: 2) {
            if !message.content.isEmpty {
                MessageBody(message: message, names: names) { attachment in
                    AnyView(AttachmentView(attachment: attachment, openImage: actions.openImage))
                }
            }
            if showEdited, message.editedAt != nil {
                Text(ChatStrings.channelEdited).font(.inter(.caption)).foregroundStyle(Tokens.Palette.mutedForeground)
            }
            if message.isAgent {
                ForEach(Array(message.visuals.enumerated()), id: \.offset) { _, visual in
                    Text(AgentVisuals.line(visual)).font(.inter(.caption)).italic().foregroundStyle(Tokens.Palette.mutedForeground)
                }
            }
            if !gallery.isEmpty {
                VStack(alignment: .leading, spacing: Tokens.Spacing.s) {
                    ForEach(gallery) { attachment in
                        AttachmentView(attachment: attachment, openImage: actions.openImage)
                    }
                }
                .padding(.top, 6)
            }
            let reactions = ChatLogic.reactionEntries(message.reactions)
            if !reactions.isEmpty {
                ReactionsBar(reactions: reactions, selfID: selfID) { emoji in actions.toggleReaction(message, emoji) }
                    .padding(.top, 4)
            }
        }
    }
}

struct MessageAvatar: View {
    let message: ChatMessage
    var size: CGFloat = MessageMetrics.avatar

    var body: some View {
        if message.isAgent {
            AgentAvatar(icon: message.authorAvatar, size: size)
        } else {
            ChatAvatar(name: message.authorName, url: message.authorAvatar, size: size)
        }
    }
}

/// An agent: its emoji icon, or a bot, on the muted rounded square.
struct AgentAvatar: View {
    let icon: String?
    var size: CGFloat = MessageMetrics.avatar

    var body: some View {
        Group {
            if let icon, !icon.isEmpty {
                Text(icon).font(.system(size: size * 0.45))
            } else {
                Image(systemName: "cpu").font(.system(size: size * 0.45)).foregroundStyle(Tokens.Palette.mutedForeground)
            }
        }
        .frame(width: size, height: size)
        .background(Tokens.Palette.muted, in: AvatarShape())
    }
}

/// The curved line from the avatar's column to a reply's quote (the platform's `ReferenceLine`).
private struct ReplyConnector: Shape {
    func path(in rect: CGRect) -> Path {
        let radius: CGFloat = 6
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.minX, y: rect.minY + radius))
        path.addQuadCurve(to: CGPoint(x: rect.minX + radius, y: rect.minY), control: CGPoint(x: rect.minX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
        return path
    }
}

/// The curved line from a message down to its "N replies".
private struct ThreadConnector: Shape {
    func path(in rect: CGRect) -> Path {
        let radius: CGFloat = 7
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.minX, y: rect.maxY - radius))
        path.addQuadCurve(to: CGPoint(x: rect.minX + radius, y: rect.maxY), control: CGPoint(x: rect.minX, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
        return path
    }
}

/// The line above a reply that ties it to what it answers, as the
/// platform: a curved connector from the avatar's column, the replied-to
/// author's small avatar and name, and the start of their message. A tap
/// jumps to it.
struct ReplyQuoteView: View {
    let reply: ReplyReference
    let names: [String: String]
    let onJump: () -> Void

    var body: some View {
        Button(action: onJump) {
            HStack(spacing: 6) {
                ReplyConnector()
                    .stroke(Tokens.Palette.mutedForeground.opacity(0.4), lineWidth: 2)
                    .frame(width: 20, height: 10)
                    .padding(.leading, MessageMetrics.avatar / 2 - 1)
                    .padding(.top, 8)
                ChatAvatar(name: reply.authorName, url: reply.authorAvatar, size: 16)
                Text(reply.authorName)
                    .font(.inter(.caption, weight: .semibold))
                    .foregroundStyle(Tokens.Palette.foreground.opacity(0.7))
                    .lineLimit(1)
                Text(ChatLogic.replyQuoteText(reply, names: names))
                    .font(.inter(.caption))
                    .foregroundStyle(Tokens.Palette.mutedForeground)
                    .lineLimit(1)
            }
            .padding(.bottom, 2)
        }
        .buttonStyle(.plain)
    }
}

/// "N replies · 21:45" under a message, hooked to it by a curved line, in
/// the primary colour: opens the thread.
private struct ThreadSummary: View {
    let message: ChatMessage
    let onOpen: () -> Void

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: 6) {
                ThreadConnector()
                    .stroke(Tokens.Palette.mutedForeground.opacity(0.4), lineWidth: 1.5)
                    .frame(width: 14, height: 12)
                    .offset(y: -4)
                Text(ChatStrings.channelReplyCount(message.threadReplyCount))
                    .font(.inter(size: 13, weight: .medium))
                    .foregroundStyle(Tokens.Palette.primary)
                if let date = WeldDate.parse(message.threadLastReplyAt) {
                    Text("· \(ChatDates.lastReply(date))").font(.inter(.caption)).foregroundStyle(Tokens.Palette.mutedForeground)
                }
            }
            .padding(.vertical, 2)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.top, 2)
        .accessibilityIdentifier("thread-link-\(message.id)")
    }
}

/// An attachment: a photo (tap for the viewer), a voice message, or a file that opens.
struct AttachmentView: View {
    let attachment: ChatAttachment
    let openImage: (String) -> Void

    var body: some View {
        if attachment.isImage {
            ImageAttachment(attachment: attachment, openImage: openImage)
        } else if attachment.isAudio, let url = URL(string: attachment.url) {
            AudioPlayerView(url: url)
        } else {
            FileAttachment(attachment: attachment)
        }
    }
}

/// A photo at its own shape, fitted in 260×200 like the platform's
/// (`max-w-[300px] max-h-[200px]`), in a bordered `rounded-lg` frame. While
/// it loads a muted frame holds its place; one that can't load shows as a
/// file that opens (and, in a debug build, says why in the log).
private struct ImageAttachment: View {
    let attachment: ChatAttachment
    let openImage: (String) -> Void

    @State private var image: UIImage?
    @State private var failed = false

    private static let log = Logger(subsystem: "com.weldsuite.weldchat", category: "attachments")

    var body: some View {
        Group {
            if failed {
                FileAttachment(attachment: attachment)
            } else if let image {
                let size = Self.fitted(image.size)
                Button {
                    openImage(attachment.url)
                } label: {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                        .frame(width: size.width, height: size.height)
                        .clipShape(RoundedRectangle(cornerRadius: Tokens.Radius.large))
                        .overlay(RoundedRectangle(cornerRadius: Tokens.Radius.large).stroke(Tokens.Palette.border, lineWidth: 1))
                }
                .buttonStyle(.plain)
            } else {
                RoundedRectangle(cornerRadius: Tokens.Radius.large)
                    .fill(Tokens.Palette.muted)
                    .frame(width: 200, height: 150)
            }
        }
        .accessibilityLabel(attachment.fileName)
        .accessibilityIdentifier("attachment-image-\(attachment.id)")
        .task(id: attachment.url) { await load() }
    }

    private func load() async {
        guard image == nil else { return }
        guard let url = URL(string: attachment.url) else {
            failed = true
            return
        }
        do {
            let (data, response) = try await URLSession.shared.data(from: url)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 200
            guard (200..<300).contains(status), let loaded = UIImage(data: data) else {
                Self.report(host: url.host(), reason: "HTTP \(status)")
                failed = true
                return
            }
            image = loaded
        } catch is CancellationError {
            return
        } catch let error as URLError where error.code == .cancelled {
            return
        } catch {
            Self.report(host: url.host(), reason: error.localizedDescription)
            failed = true
        }
    }

    /// Debug builds only, and the host without the path: a storage key is as good as a link to the file.
    private static func report(host: String?, reason: String) {
        #if DEBUG
        log.debug("Image attachment on \(host ?? "?", privacy: .public) did not load: \(reason, privacy: .public)")
        #endif
    }

    /// The image's own shape, fitted in 260×200.
    private static func fitted(_ size: CGSize) -> CGSize {
        guard size.width > 0, size.height > 0 else { return CGSize(width: 200, height: 150) }
        let aspect = size.width / size.height
        let width = min(260, 200 * aspect)
        return CGSize(width: width, height: width / aspect)
    }
}

/// A file: its icon, name and size in a bordered frame; a tap opens it.
private struct FileAttachment: View {
    let attachment: ChatAttachment
    @Environment(\.openURL) private var openURL

    var body: some View {
        Button {
            if let url = URL(string: attachment.url) { openURL(url) }
        } label: {
            HStack(spacing: Tokens.Spacing.s) {
                Image(systemName: "doc.text").font(.system(size: 18)).foregroundStyle(Tokens.Palette.mutedForeground)
                VStack(alignment: .leading, spacing: 2) {
                    Text(attachment.fileName).font(.inter(.subheadline)).lineLimit(1)
                    if attachment.fileSize > 0 {
                        Text(ByteCountFormatter.string(fromByteCount: Int64(attachment.fileSize), countStyle: .file))
                            .font(.inter(.caption)).foregroundStyle(Tokens.Palette.mutedForeground)
                    }
                }
            }
            .padding(.horizontal, Tokens.Spacing.m)
            .padding(.vertical, Tokens.Spacing.s)
            .frame(maxWidth: 280, alignment: .leading)
            .background(Tokens.Palette.background, in: RoundedRectangle(cornerRadius: Tokens.Radius.large))
            .overlay(RoundedRectangle(cornerRadius: Tokens.Radius.large).stroke(Tokens.Palette.border, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }
}

/// The reactions under a message, as the platform's chips: `rounded-md`
/// with a border, the emoji and the count; yours in blue. A tap adds yours
/// or takes it back.
struct ReactionsBar: View {
    let reactions: [(emoji: String, users: [String])]
    let selfID: String
    let onToggle: (String) -> Void

    var body: some View {
        FlowLayout(spacing: 4) {
            ForEach(reactions, id: \.emoji) { reaction in
                let mine = reaction.users.contains(selfID)
                Button {
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    onToggle(reaction.emoji)
                } label: {
                    HStack(spacing: 4) {
                        Text(reaction.emoji).font(.system(size: 13))
                        Text("\(reaction.users.count)")
                            .font(.system(size: 12, design: .monospaced))
                            .foregroundStyle(mine ? ChatColors.reactionMine : Tokens.Palette.mutedForeground)
                    }
                    .padding(.horizontal, 7)
                    .frame(minHeight: 26)
                    .background(mine ? ChatColors.reactionMine.opacity(0.1) : Tokens.Palette.muted.opacity(0.4), in: RoundedRectangle(cornerRadius: Tokens.Radius.small))
                    .overlay(
                        RoundedRectangle(cornerRadius: Tokens.Radius.small)
                            .stroke(mine ? ChatColors.reactionMine.opacity(0.4) : Tokens.Palette.border, lineWidth: 1)
                    )
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(mine ? .isSelected : [])
            }
        }
    }
}

/// A row that wraps, for reactions.
struct FlowLayout: Layout {
    var spacing: CGFloat = 4

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0
        var y: CGFloat = 0
        var line: CGFloat = 0
        var widest: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width {
                y += line + spacing
                x = 0
                line = 0
            }
            x += size.width + spacing
            line = max(line, size.height)
            widest = max(widest, x - spacing)
        }
        return CGSize(width: min(widest, width), height: y + line)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var line: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX {
                y += line + spacing
                x = bounds.minX
                line = 0
            }
            subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            line = max(line, size.height)
        }
    }
}

/// A call in the conversation, drawn as the platform's notice: a message
/// from the caller (avatar, name, time) whose line says how the call went,
/// with a green phone for one that ran, grey for no answer and red for a
/// missed one; Join call while it runs and you're not in it.
struct CallNoticeRow: View {
    let entry: CallLogEntry
    let selfID: String
    let ongoing: Bool
    let joinable: Bool
    let createdAt: String
    let onJoin: () -> Void

    var body: some View {
        let mine = entry.callerID == selfID
        let missed = entry.outcome == .missed
        let lasted = entry.outcome == .ended ? CallLog.lasted(entry.duration) : nil
        let text: String = {
            if missed { return mine ? ChatStrings.channelCalledNoAnswer : ChatStrings.channelYouMissedCall }
            if let lasted { return ChatStrings.channelStartedCallLasted(duration: lasted) }
            return ChatStrings.channelStartedCall
        }()
        let symbol: String = {
            if missed { return mine ? "phone.arrow.up.right" : "phone.arrow.down.left" }
            return entry.isVideo ? "video.fill" : "phone.fill"
        }()
        let tint: Color = missed ? (mine ? Tokens.Palette.mutedForeground : ChatColors.callRed) : ChatColors.callGreen
        HStack(alignment: .top, spacing: MessageMetrics.avatarGap) {
            ChatAvatar(name: entry.callerName, url: entry.callerAvatar, size: MessageMetrics.avatar)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: Tokens.Spacing.s) {
                    Text(entry.callerName).font(.inter(.subheadline, weight: .semibold)).lineLimit(1)
                    Text(ChatDates.time(WeldDate.parse(createdAt))).font(.inter(.caption)).foregroundStyle(Tokens.Palette.mutedForeground)
                }
                HStack(spacing: 6) {
                    Image(systemName: symbol).font(.system(size: 13)).foregroundStyle(tint)
                    Text(text).font(.inter(.subheadline))
                    if ongoing, joinable {
                        Button(ChatStrings.channelJoinCallLink, action: onJoin)
                            .font(.inter(.subheadline, weight: .medium))
                            .foregroundStyle(Tokens.Palette.primary)
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("call-notice-join")
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, MessageMetrics.rowPadding)
        .padding(.top, 14)
        .padding(.bottom, 2)
        .accessibilityIdentifier("call-notice")
    }
}

/// The day between messages: a line, the day in small muted text, a line.
struct DateSeparator: View {
    let date: Date

    var body: some View {
        HStack(spacing: Tokens.Spacing.l) {
            Rectangle().fill(Tokens.Palette.border).frame(height: 1)
            Text(ChatDates.dayLabel(date)).font(.inter(.caption, weight: .medium)).foregroundStyle(Tokens.Palette.mutedForeground)
                .fixedSize()
            Rectangle().fill(Tokens.Palette.border).frame(height: 1)
        }
        .padding(.horizontal, MessageMetrics.rowPadding)
        .padding(.vertical, Tokens.Spacing.l)
    }
}
