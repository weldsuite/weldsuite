import SwiftUI
import UIKit
import WeldCore
import WeldUI

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
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: Tokens.Radius.large))
            .padding(.horizontal, Tokens.Spacing.m)
            .accessibilityIdentifier("mention-picker")
        }
    }

    private var rows: some View {
        VStack(spacing: 0) {
            ForEach(candidates) { candidate in
                Button {
                    onSelect(candidate)
                } label: {
                    HStack(spacing: Tokens.Spacing.m) {
                        avatar(candidate)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(candidate.name).font(.subheadline.weight(.semibold)).lineLimit(1)
                            if !candidate.isAgent, let email = candidate.email, !email.isEmpty {
                                Text(email).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                            }
                        }
                        Spacer(minLength: 0)
                        if candidate.isAgent {
                            Text(ChatStrings.channelAgentBadge)
                                .font(.caption2.weight(.bold))
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(Tokens.Brand.weldchat.opacity(0.15), in: Capsule())
                        }
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
            Group {
                if let icon = candidate.agentIcon, !icon.isEmpty {
                    Text(icon).font(.system(size: 15))
                } else {
                    Image(systemName: "sparkles").font(.caption).foregroundStyle(.white)
                }
            }
            .frame(width: 30, height: 30)
            .background(Tokens.Brand.weldchat, in: Circle())
        } else {
            ChatAvatar(name: candidate.name, url: candidate.picture, size: 30)
        }
    }
}

/// The bottom of a conversation: the mention picker, the edit and thread
/// bars, the files about to be sent, who is typing, the archived notice and
/// the input (or the recording bar).
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
        VStack(spacing: Tokens.Spacing.s) {
            if model.mentionQuery != nil, !model.isRecording {
                ChannelMentionPicker(candidates: candidates) { candidate in
                    model.insertMention(userID: candidate.userID)
                }
            }
            if model.editing != nil { editBar }
            if model.showThreadSuggestion { threadSuggestion }
            PendingFilesBar(files: model.pendingFiles) { file in
                model.pendingFiles.removeAll { $0.id == file.id }
            }
            if let room = model.room, let typing = ChatLogic.typingLabel(room.typingUserIDs, names: model.names) {
                Text(typing)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, Tokens.Spacing.l)
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
                .padding(.horizontal, Tokens.Spacing.m)
            } else {
                inputBar
            }
        }
        .padding(.top, Tokens.Spacing.xs)
        .padding(.bottom, Tokens.Spacing.s)
        .background(.bar)
        // Typing: the draft, the room's "typing", the mention picker.
        .onChange(of: model.input) { _, text in model.inputChanged(text) }
        .attachmentPicker(isPresented: $showAttach) { files in
            model.pendingFiles.append(contentsOf: files)
        }
    }

    private var inputBar: some View {
        HStack(alignment: .bottom, spacing: Tokens.Spacing.s) {
            if model.editing == nil {
                Button {
                    focus.wrappedValue = false
                    showAttach = true
                } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 18, weight: .semibold))
                        .frame(width: 36, height: 36)
                        .background(Color(.secondarySystemBackground), in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(ChatStrings.composerAttach)
                .accessibilityIdentifier("composer-attach")
            }

            VStack(alignment: .leading, spacing: 4) {
                if let reply = model.replyTo, model.editing == nil {
                    replyHeader(reply)
                }
                TextField(ChannelRules.placeholder(kind: kind, name: name), text: $model.input, axis: .vertical)
                    .lineLimit(1...6)
                    .focused(focus)
                    .submitLabel(.return)
                    .accessibilityIdentifier("composer-input")
            }
            .padding(.horizontal, Tokens.Spacing.m)
            .padding(.vertical, 8)
            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 20))

            if model.canSend || model.editing != nil {
                Button(action: onSend) {
                    Group {
                        if model.uploading {
                            ProgressView().tint(.white)
                        } else {
                            Image(systemName: model.editing != nil ? "checkmark" : "arrow.up")
                                .font(.system(size: 16, weight: .bold))
                        }
                    }
                    .frame(width: 36, height: 36)
                    .foregroundStyle(.white)
                    .background(Tokens.Brand.weldchat, in: Circle())
                }
                .buttonStyle(.plain)
                .disabled(model.uploading)
                .accessibilityLabel(ChatStrings.composerSend)
                .accessibilityIdentifier("composer-send")
            } else {
                Button(action: onStartRecording) {
                    Image(systemName: "mic")
                        .font(.system(size: 18, weight: .semibold))
                        .frame(width: 36, height: 36)
                        .background(Color(.secondarySystemBackground), in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(ChatStrings.composerRecordVoice)
                .accessibilityIdentifier("composer-mic")
            }
        }
        .padding(.horizontal, Tokens.Spacing.m)
    }

    /// Who the reply goes to, whether they are pinged, and close.
    private func replyHeader(_ reply: ReplyReference) -> some View {
        HStack(spacing: Tokens.Spacing.s) {
            Text(ChatStrings.channelReplyingTo(name: reply.authorName))
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Spacer(minLength: 0)
            Button {
                model.replyMention.toggle()
            } label: {
                Image(systemName: "at")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(model.replyMention ? Tokens.Brand.weldchat : Color.secondary)
                    .padding(4)
                    .background(model.replyMention ? Tokens.Brand.weldchat.opacity(0.15) : Color.clear, in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(ChatStrings.channelMentionAuthor(name: reply.authorName))
            .accessibilityAddTraits(model.replyMention ? .isSelected : [])
            .accessibilityIdentifier("reply-mention")
            Button {
                model.cancelReply()
            } label: {
                Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(ChatStrings.channelCancelReply)
            .accessibilityIdentifier("reply-cancel")
        }
    }

    private var editBar: some View {
        HStack(spacing: Tokens.Spacing.s) {
            Image(systemName: "pencil").foregroundStyle(Tokens.Brand.weldchat)
            Text(ChatStrings.channelEditingMessage).font(.subheadline.weight(.semibold)).lineLimit(1)
            Spacer()
            Button {
                model.cancelEdit()
            } label: {
                Image(systemName: "xmark").font(.caption.weight(.bold))
            }
            .buttonStyle(.plain)
            .accessibilityLabel(CoreStrings.commonCancel)
            .accessibilityIdentifier("edit-cancel")
        }
        .padding(.horizontal, Tokens.Spacing.l)
    }

    private var threadSuggestion: some View {
        HStack(spacing: Tokens.Spacing.s) {
            Image(systemName: "bubble.left.and.bubble.right").foregroundStyle(Tokens.Brand.weldchat)
            Text(ChatStrings.channelThreadSuggestion).font(.caption).lineLimit(2)
            Spacer(minLength: 0)
            Button(ChatStrings.channelCreateThread, action: onContinueInThread)
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .accessibilityIdentifier("thread-suggestion-create")
            Button {
                model.dismissThreadSuggestion()
            } label: {
                Image(systemName: "xmark").font(.caption.weight(.bold)).foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(ChatStrings.channelDismissThreadSuggestion)
            .accessibilityIdentifier("thread-suggestion-dismiss")
        }
        .padding(Tokens.Spacing.s)
        .background(Tokens.Brand.weldchat.opacity(0.08), in: RoundedRectangle(cornerRadius: Tokens.Radius.medium))
        .padding(.horizontal, Tokens.Spacing.m)
    }

    private var archivedBanner: some View {
        HStack(spacing: Tokens.Spacing.s) {
            Image(systemName: "archivebox").foregroundStyle(.secondary)
            Text(ChatStrings.channelArchivedNotice).font(.subheadline).foregroundStyle(.secondary)
            Spacer(minLength: 0)
            Button(ChatStrings.channelUnarchive, action: onUnarchive)
                .font(.subheadline.weight(.semibold))
                .accessibilityIdentifier("channel-unarchive")
        }
        .padding(.horizontal, Tokens.Spacing.l)
    }
}
