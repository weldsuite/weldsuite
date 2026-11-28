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

/// One message: the reply quote, the avatar and name (unless it continues
/// the previous one), the text with mentions and links, attachments, the
/// agent's visuals, reactions and the thread link. Hold for its actions,
/// drag right to reply.
struct MessageRow: View {
    let message: ChatMessage
    let compact: Bool
    let names: [String: String]
    let selfID: String
    var highlighted = false
    var interactive = true
    var actions = MessageRowActions()

    @State private var dragX: CGFloat = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if !compact, let reply = message.replyTo {
                ReplyQuoteView(reply: reply, names: names) { actions.jumpTo(reply.messageID) }
                    .padding(.leading, 46)
            }
            HStack(alignment: .top, spacing: Tokens.Spacing.s) {
                if compact {
                    Color.clear.frame(width: 38, height: 1)
                } else {
                    Button {
                        actions.openProfile(message.authorID)
                    } label: {
                        MessageAvatar(message: message)
                    }
                    .buttonStyle(.plain)
                    .disabled(message.isAgent || message.authorID.isEmpty || !interactive)
                    .accessibilityLabel(message.authorName)
                }
                VStack(alignment: .leading, spacing: 4) {
                    if !compact {
                        HStack(spacing: 6) {
                            Text(message.authorName).font(.subheadline.weight(.semibold)).lineLimit(1)
                            if message.isAgent {
                                Text(ChatStrings.channelAgentBadge)
                                    .font(.caption2.weight(.bold))
                                    .padding(.horizontal, 4)
                                    .background(Tokens.Brand.weldchat.opacity(0.15), in: RoundedRectangle(cornerRadius: 3))
                            }
                            Text(ChatDates.time(message.date)).font(.caption).foregroundStyle(.secondary)
                            if message.pending { ProgressView().controlSize(.mini) }
                        }
                    }
                    MessageExtras(message: message, names: names, selfID: selfID, actions: actions)
                    if message.threadReplyCount > 0 {
                        Button {
                            actions.openThread(message)
                        } label: {
                            Label(ChatStrings.channelReplyCount(message.threadReplyCount), systemImage: "bubble.left.and.bubble.right")
                                .font(.caption.weight(.semibold))
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(Tokens.Brand.weldchat)
                        .accessibilityIdentifier("thread-link-\(message.id)")
                    }
                }
                Spacer(minLength: 0)
            }
        }
        .padding(.horizontal, Tokens.Spacing.l)
        .padding(.top, compact ? 2 : Tokens.Spacing.s)
        .padding(.bottom, 2)
        .background(highlighted ? Color(hex: 0x5865F2).opacity(0.14) : Color.clear)
        .offset(x: dragX)
        .background(alignment: .leading) {
            if dragX > 10 {
                Image(systemName: "arrowshape.turn.up.left.fill")
                    .foregroundStyle(.secondary)
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
}

/// The text, the edited mark, an agent's visuals, attachments and reactions.
private struct MessageExtras: View {
    let message: ChatMessage
    let names: [String: String]
    let selfID: String
    let actions: MessageRowActions

    var body: some View {
        let inline = Set(MentionText.fileTokenIDs(message.content))
        let gallery = message.attachments.filter { !inline.contains($0.id) }
        VStack(alignment: .leading, spacing: 4) {
            if !message.content.isEmpty {
                MessageBody(message: message, names: names) { attachment in
                    AnyView(AttachmentView(attachment: attachment, openImage: actions.openImage))
                }
            }
            if message.editedAt != nil {
                Text(ChatStrings.channelEdited).font(.caption2).foregroundStyle(.secondary)
            }
            if message.isAgent {
                ForEach(Array(message.visuals.enumerated()), id: \.offset) { _, visual in
                    Text(AgentVisuals.line(visual)).font(.caption).italic().foregroundStyle(.secondary)
                }
            }
            ForEach(gallery) { attachment in
                AttachmentView(attachment: attachment, openImage: actions.openImage)
            }
            let reactions = ChatLogic.reactionEntries(message.reactions)
            if !reactions.isEmpty {
                ReactionsBar(reactions: reactions, selfID: selfID) { emoji in actions.toggleReaction(message, emoji) }
            }
        }
    }
}

struct MessageAvatar: View {
    let message: ChatMessage

    var body: some View {
        if message.isAgent {
            Group {
                if let icon = message.authorAvatar, !icon.isEmpty {
                    Text(icon).font(.system(size: 18))
                } else {
                    Image(systemName: "sparkles").foregroundStyle(.white)
                }
            }
            .frame(width: 38, height: 38)
            .background(Tokens.Brand.weldchat, in: Circle())
        } else {
            ChatAvatar(name: message.authorName, url: message.authorAvatar, size: 38)
        }
    }
}

/// An inline reply's quote; a tap jumps to the original.
struct ReplyQuoteView: View {
    let reply: ReplyReference
    let names: [String: String]
    let onJump: () -> Void

    var body: some View {
        Button(action: onJump) {
            HStack(spacing: 6) {
                Image(systemName: "arrow.turn.up.right").font(.caption2).foregroundStyle(.secondary)
                ChatAvatar(name: reply.authorName, url: reply.authorAvatar, size: 16)
                Text(reply.authorName).font(.caption.weight(.semibold)).lineLimit(1)
                Text(ChatLogic.replyQuoteText(reply, names: names)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        .buttonStyle(.plain)
    }
}

/// An attachment: a photo (tap for the viewer), a voice message, or a file that opens.
struct AttachmentView: View {
    let attachment: ChatAttachment
    let openImage: (String) -> Void
    @Environment(\.openURL) private var openURL

    var body: some View {
        if attachment.isImage {
            Button {
                openImage(attachment.url)
            } label: {
                AsyncImage(url: URL(string: attachment.url)) { phase in
                    if let image = phase.image {
                        image.resizable().scaledToFill()
                    } else {
                        Color.secondary.opacity(0.15)
                    }
                }
                .frame(width: 220, height: 160)
                .clipShape(RoundedRectangle(cornerRadius: Tokens.Radius.medium))
            }
            .buttonStyle(.plain)
        } else if attachment.isAudio, let url = URL(string: attachment.url) {
            AudioPlayerView(url: url)
        } else {
            Button {
                if let url = URL(string: attachment.url) { openURL(url) }
            } label: {
                HStack(spacing: Tokens.Spacing.s) {
                    Image(systemName: "doc.text").font(.title3).foregroundStyle(.secondary)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(attachment.fileName).font(.subheadline).lineLimit(1)
                        Text(ByteCountFormatter.string(fromByteCount: Int64(attachment.fileSize), countStyle: .file))
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                .padding(Tokens.Spacing.s)
                .frame(maxWidth: 280, alignment: .leading)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: Tokens.Radius.medium))
            }
            .buttonStyle(.plain)
        }
    }
}

/// The reactions under a message; a tap adds yours or takes it back.
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
                    HStack(spacing: 3) {
                        Text(reaction.emoji)
                        Text("\(reaction.users.count)").font(.caption.weight(.semibold))
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(mine ? Tokens.Brand.weldchat.opacity(0.18) : Color(.secondarySystemBackground), in: Capsule())
                    .overlay(Capsule().stroke(mine ? Tokens.Brand.weldchat : Color.clear, lineWidth: 1))
                }
                .buttonStyle(.plain)
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

/// A call in the conversation, one card: how it went, how long and when,
/// the caller, or Join while it runs.
struct CallLogCard: View {
    let entry: CallLogEntry
    let ongoing: Bool
    let joinable: Bool
    let createdAt: String
    let onJoin: () -> Void

    var body: some View {
        let missed = entry.outcome == .missed
        let title: String = {
            if ongoing { return ChatStrings.channelCallOngoing }
            if missed { return ChatStrings.channelMissedCall }
            if entry.outcome == .ended { return ChatStrings.channelCallEnded }
            return ChatStrings.channelCallStarted
        }()
        let when = WeldDate.parse(createdAt).map { $0.formatted(date: .numeric, time: .shortened) } ?? ""
        HStack(spacing: Tokens.Spacing.m) {
            Image(systemName: missed ? "phone.down.fill" : (entry.isVideo ? "video.fill" : "phone.fill"))
                .foregroundStyle(missed ? Tokens.Status.danger : (ongoing ? Tokens.Brand.weldchat : Color.secondary))
                .frame(width: 36, height: 36)
                .background(Color(.tertiarySystemBackground), in: Circle())
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline.weight(.semibold)).lineLimit(1)
                Text(CallLog.lasted(entry.duration).map { ChatStrings.channelCallLasted(duration: $0, when: when) } ?? when)
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer()
            if joinable {
                Button(ChatStrings.channelJoinCall, action: onJoin)
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
            } else {
                ChatAvatar(name: entry.callerName, url: entry.callerAvatar, size: 28)
            }
        }
        .padding(Tokens.Spacing.m)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: Tokens.Radius.large))
        .padding(.horizontal, Tokens.Spacing.l)
        .padding(.vertical, Tokens.Spacing.xs)
    }
}

/// "Today", "Monday", "12 March" between days.
struct DateSeparator: View {
    let date: Date

    var body: some View {
        HStack {
            VStack { Divider() }
            Text(ChatDates.dayLabel(date)).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            VStack { Divider() }
        }
        .padding(.horizontal, Tokens.Spacing.l)
        .padding(.vertical, Tokens.Spacing.s)
    }
}
