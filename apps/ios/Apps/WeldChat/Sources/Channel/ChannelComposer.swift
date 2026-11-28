import SwiftUI
import UIKit
import WeldCore
import WeldUI

/// The platform's composer colours (`@weldsuite/ui` `composer`).
enum ComposerColors {
    /// The box's border: `gray-200` (`border` dark).
    static let border = ChatColors.dynamic(0xE5E7EB, 0x2E3238)
    /// A notice above the field: `bg-gray-100` (`secondary/60` dark).
    static let notice = ChatColors.dynamic(0xF3F4F6, 0x2E3238, darkOpacity: 0.6)
    /// Send with nothing to send: `bg-gray-300 text-gray-500` (`muted` dark).
    static let sendIdle = ChatColors.dynamic(0xD1D5DB, 0x232529)
    static let sendIdleText = ChatColors.dynamic(0x6B7280, 0xB5BDC9)
    /// The action icons: `text-gray-500` (`muted-foreground` dark).
    static let icon = ChatColors.dynamic(0x6B7280, 0xB5BDC9)
}

/// The people and agents a composer offers while `@…` is typed.
struct ChannelMentionPicker: View {
    let candidates: [MentionCandidate]
    let onSelect: (MentionCandidate) -> Void

    var body: some View {
        if !candidates.isEmpty {
            Group {
                if candidates.count > 4 {
                    ScrollView { rows }.frame(height: 216)
                } else {
                    rows
                }
            }
            .padding(.vertical, 4)
            .background(Tokens.Palette.card, in: RoundedRectangle(cornerRadius: Tokens.Radius.xlarge))
            .overlay(RoundedRectangle(cornerRadius: Tokens.Radius.xlarge).stroke(Tokens.Palette.border, lineWidth: 1))
            .shadow(color: .black.opacity(0.08), radius: 8, y: 2)
            .accessibilityIdentifier("mention-picker")
        }
    }

    private var rows: some View {
        VStack(spacing: 0) {
            ForEach(candidates) { candidate in
                Button {
                    onSelect(candidate)
                } label: {
                    HStack(spacing: Tokens.Spacing.s) {
                        avatar(candidate)
                        Text(candidate.name).font(.inter(.subheadline, weight: .medium)).lineLimit(1)
                        if !candidate.isAgent, let email = candidate.email, !email.isEmpty {
                            Text(email).font(.inter(.caption)).foregroundStyle(Tokens.Palette.mutedForeground).lineLimit(1)
                        }
                        Spacer(minLength: 0)
                        if candidate.isAgent { AgentBadge() }
                    }
                    .padding(.horizontal, Tokens.Spacing.m)
                    .padding(.vertical, Tokens.Spacing.s)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("mention-\(candidate.userID)")
            }
        }
    }

    @ViewBuilder
    private func avatar(_ candidate: MentionCandidate) -> some View {
        if candidate.isAgent {
            AgentAvatar(icon: candidate.agentIcon, size: 24)
        } else {
            ChatAvatar(name: candidate.name, url: candidate.picture, size: 24)
        }
    }
}

/// The composer's box: `rounded-[20px]`, bordered, on the background, 10pt inside.
struct ComposerFrame<Content: View>: View {
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) { content() }
            .padding(10)
            .background(Tokens.Palette.background, in: RoundedRectangle(cornerRadius: 20))
            .overlay(RoundedRectangle(cornerRadius: 20).stroke(ComposerColors.border, lineWidth: 1))
            .accessibilityIdentifier("composer")
    }
}

/// An action in the composer's row: a grey icon in a 36pt `rounded-lg` target.
struct ComposerIconButton: View {
    let symbol: String
    let label: String
    let id: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 17))
                .foregroundStyle(ComposerColors.icon)
                .frame(width: 36, height: 36)
                .contentShape(RoundedRectangle(cornerRadius: Tokens.Radius.medium))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityIdentifier(id)
    }
}

/// Send: a `rounded-[12px]` square, the primary colour while there is something to send, plain grey while there isn't.
struct ComposerSendButton: View {
    let canSend: Bool
    let sending: Bool
    let id: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Group {
                if sending {
                    ProgressView().controlSize(.small).tint(canSend ? Tokens.Palette.primaryForeground : ComposerColors.sendIdleText)
                } else {
                    Image(systemName: "arrow.up").font(.system(size: 15, weight: .bold))
                }
            }
            .foregroundStyle(canSend ? Tokens.Palette.primaryForeground : ComposerColors.sendIdleText)
            .frame(width: 34, height: 34)
            .background(canSend ? Tokens.Palette.primary : ComposerColors.sendIdle, in: RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
        .disabled(!canSend || sending)
        .accessibilityLabel(ChatStrings.composerSend)
        .accessibilityIdentifier(id)
    }
}

/// A strip above the field about the next message (what it replies to,
/// that it edits one, a suggestion): `rounded-[10px]` on `gray-100`, 13pt,
/// a grey icon, and a close button.
struct ComposerNotice<Content: View, Actions: View>: View {
    let symbol: String
    let dismissLabel: String
    let dismissID: String
    let onDismiss: () -> Void
    @ViewBuilder var actions: () -> Actions
    @ViewBuilder var content: () -> Content

    var body: some View {
        HStack(spacing: Tokens.Spacing.s) {
            Image(systemName: symbol).font(.system(size: 12)).foregroundStyle(Tokens.Palette.mutedForeground)
            content()
                .font(.inter(size: 13))
                .foregroundStyle(Tokens.Palette.foreground)
                .frame(maxWidth: .infinity, alignment: .leading)
            actions()
            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Tokens.Palette.mutedForeground)
                    .frame(width: 28, height: 28)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(dismissLabel)
            .accessibilityIdentifier(dismissID)
        }
        .padding(.leading, Tokens.Spacing.m)
        .padding(.trailing, 4)
        .padding(.vertical, 4)
        .frame(minHeight: 36)
        .background(ComposerColors.notice, in: RoundedRectangle(cornerRadius: 10))
        .padding(.bottom, 4)
    }
}

extension ComposerNotice where Actions == EmptyView {
    init(symbol: String, dismissLabel: String, dismissID: String, onDismiss: @escaping () -> Void, @ViewBuilder content: @escaping () -> Content) {
        self.init(symbol: symbol, dismissLabel: dismissLabel, dismissID: dismissID, onDismiss: onDismiss, actions: { EmptyView() }, content: content)
    }
}

/// The bottom of a conversation: the mention picker, who is typing, the
/// archived notice, and the composer box (the edit, thread and reply
/// notices, the files about to be sent, the field, and attach, mention,
/// record and send), or the recording bar.
struct ChannelComposer: View {
    @Bindable var model: ChannelModel
    let kind: ConversationKind
    let name: String
    let candidates: [MentionCandidate]
    let isArchived: Bool
    var focus: FocusState<Bool>.Binding
    let onSend: () -> Void
    let onStartRecording: () -> Void
    let onSendVoice: () -> Void
    let onContinueInThread: () -> Void
    let onUnarchive: () -> Void

    @State private var showAttach = false

    var body: some View {
        VStack(spacing: Tokens.Spacing.xs) {
            if model.mentionQuery != nil, !model.isRecording {
                ChannelMentionPicker(candidates: candidates) { candidate in
                    model.insertMention(userID: candidate.userID)
                }
            }
            if let room = model.room, let typing = ChatLogic.typingLabel(room.typingUserIDs, names: model.names) {
                Text(typing)
                    .font(.inter(.caption))
                    .foregroundStyle(Tokens.Palette.mutedForeground)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, Tokens.Spacing.m)
                    .accessibilityIdentifier("typing-indicator")
            }
            if isArchived { archivedBanner }
            if model.isRecording {
                RecordingBar(
                    recorder: model.recorder,
                    sending: model.sendingVoiceDuration != nil,
                    frozenDuration: model.sendingVoiceDuration,
                    onCancel: { model.recorder.cancel() },
                    onSend: onSendVoice
                )
            } else {
                composer
            }
        }
        .padding(.horizontal, Tokens.Spacing.s)
        .padding(.top, Tokens.Spacing.xs)
        .padding(.bottom, Tokens.Spacing.s)
        .background(Tokens.Palette.background)
        // Typing: the draft, the room's "typing", the mention picker.
        .onChange(of: model.input) { _, text in model.inputChanged(text) }
        .attachmentPicker(isPresented: $showAttach) { files in
            model.pendingFiles.append(contentsOf: files)
        }
    }

    private var composer: some View {
        let editing = model.editing != nil
        return ComposerFrame {
            if editing {
                ComposerNotice(symbol: "pencil", dismissLabel: CoreStrings.commonCancel, dismissID: "edit-cancel", onDismiss: { model.cancelEdit() }) {
                    Text(ChatStrings.channelEditingMessage).lineLimit(1)
                }
            }
            if model.showThreadSuggestion {
                ComposerNotice(
                    symbol: "bubble.left.and.bubble.right",
                    dismissLabel: ChatStrings.channelDismissThreadSuggestion,
                    dismissID: "thread-suggestion-dismiss",
                    onDismiss: { model.dismissThreadSuggestion() },
                    actions: {
                        Button(action: onContinueInThread) {
                            Text(ChatStrings.channelCreateThread).font(.inter(size: 12, weight: .medium))
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.mini)
                        .accessibilityIdentifier("thread-suggestion-create")
                    }
                ) {
                    Text(ChatStrings.channelThreadSuggestion).lineLimit(2)
                }
            }
            if let reply = model.replyTo, !editing {
                replyNotice(reply)
            }
            PendingFilesBar(files: model.pendingFiles) { file in
                model.pendingFiles.removeAll { $0.id == file.id }
            }
            TextField(ChannelRules.placeholder(kind: kind, name: name), text: $model.input, axis: .vertical)
                .font(.inter(size: 15))
                .lineLimit(1...6)
                .focused(focus)
                .submitLabel(.return)
                .padding(.leading, 10)
                .padding(.trailing, 4)
                .padding(.top, 6)
                .padding(.bottom, 10)
                .accessibilityIdentifier("composer-input")
            HStack(spacing: 0) {
                if !editing {
                    ComposerIconButton(symbol: "plus", label: ChatStrings.composerAttach, id: "composer-attach") {
                        focus.wrappedValue = false
                        showAttach = true
                    }
                }
                ComposerIconButton(symbol: "at", label: ChatStrings.composerMentionSomeone, id: "composer-mention") {
                    let text = model.input
                    model.input = text + (text.isEmpty || text.last?.isWhitespace == true ? "@" : " @")
                    focus.wrappedValue = true
                }
                if !editing {
                    ComposerIconButton(symbol: "mic", label: ChatStrings.composerRecordVoice, id: "composer-mic", action: onStartRecording)
                }
                Spacer(minLength: 0)
                ComposerSendButton(canSend: (model.canSend || editing) && !model.uploading, sending: model.uploading, id: "composer-send", action: onSend)
            }
        }
    }

    /// Who the reply goes to, whether they are pinged, and close.
    private func replyNotice(_ reply: ReplyReference) -> some View {
        ComposerNotice(
            symbol: "arrowshape.turn.up.left",
            dismissLabel: ChatStrings.channelCancelReply,
            dismissID: "reply-cancel",
            onDismiss: { model.cancelReply() },
            actions: {
                Button {
                    model.replyMention.toggle()
                } label: {
                    Image(systemName: "at")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(model.replyMention ? Tokens.Palette.foreground : Tokens.Palette.mutedForeground)
                        .frame(width: 28, height: 28)
                        .background(model.replyMention ? Tokens.Palette.background : Color.clear, in: RoundedRectangle(cornerRadius: Tokens.Radius.small))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(ChatStrings.channelMentionAuthor(name: reply.authorName))
                .accessibilityAddTraits(model.replyMention ? .isSelected : [])
                .accessibilityIdentifier("reply-mention")
            }
        ) {
            Text(ChatStrings.channelReplyingTo(name: reply.authorName)).lineLimit(1)
        }
    }

    private var archivedBanner: some View {
        HStack(spacing: Tokens.Spacing.s) {
            Image(systemName: "archivebox").foregroundStyle(Tokens.Palette.mutedForeground)
            Text(ChatStrings.channelArchivedNotice).font(.inter(.subheadline)).foregroundStyle(Tokens.Palette.mutedForeground)
            Spacer(minLength: 0)
            Button(ChatStrings.channelUnarchive, action: onUnarchive)
                .font(.inter(.subheadline, weight: .semibold))
                .accessibilityIdentifier("channel-unarchive")
        }
        .padding(.horizontal, Tokens.Spacing.s)
        .padding(.vertical, Tokens.Spacing.xs)
        .overlay(alignment: .top) { Rectangle().fill(Tokens.Palette.border).frame(height: 1) }
    }
}
