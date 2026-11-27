import SwiftUI
import WeldCore
import WeldUI

/// What a held message offers: six quick reactions and more, reply, reply
/// in a thread, copy, pin or unpin, save, and edit and delete on your own.
struct MessageActionsSheet: View {
    let message: ChatMessage
    let isOwn: Bool
    let onQuickReact: (String) -> Void
    let onMoreReactions: () -> Void
    let onReply: () -> Void
    let onThread: () -> Void
    let onCopy: () -> Void
    let onPin: () -> Void
    let onSave: () -> Void
    let onEdit: () -> Void
    let onDelete: () -> Void

    var body: some View {
        List {
            Section {
                HStack(spacing: 0) {
                    ForEach(Array(ChatLogic.quickEmojis.enumerated()), id: \.offset) { index, emoji in
                        Button {
                            onQuickReact(emoji)
                        } label: {
                            Text(emoji)
                                .font(.system(size: 26))
                                .frame(width: 42, height: 42)
                                .background(Color(.tertiarySystemBackground), in: Circle())
                        }
                        .buttonStyle(.plain)
                        .frame(maxWidth: .infinity)
                        .accessibilityIdentifier("quick-react-\(index)")
                    }
                    Button(action: onMoreReactions) {
                        Image(systemName: "face.smiling")
                            .font(.system(size: 20))
                            .foregroundStyle(.secondary)
                            .frame(width: 42, height: 42)
                            .background(Color(.tertiarySystemBackground), in: Circle())
                    }
                    .buttonStyle(.plain)
                    .frame(maxWidth: .infinity)
                    .accessibilityLabel(ChatStrings.messageActionsMoreReactions)
                    .accessibilityIdentifier("action-more-reactions")
                }
                .listRowInsets(EdgeInsets(top: 8, leading: 4, bottom: 8, trailing: 4))
            }

            Section {
                row(ChatStrings.messageActionsReply, symbol: "arrowshape.turn.up.left", id: "action-reply", action: onReply)
                row(ChatStrings.messageActionsReplyInThread, symbol: "bubble.left.and.bubble.right", id: "action-thread", action: onThread)
                if ChannelRules.canCopy(message) {
                    row(ChatStrings.messageActionsCopyText, symbol: "doc.on.doc", id: "action-copy", action: onCopy)
                }
                row(
                    message.isPinned ? ChatStrings.messageActionsUnpin : ChatStrings.messageActionsPin,
                    symbol: message.isPinned ? "pin.slash" : "pin",
                    id: "action-pin",
                    action: onPin
                )
                row(ChatStrings.messageActionsSave, symbol: "bookmark", id: "action-save", action: onSave)
                if isOwn, !message.isSystem {
                    row(ChatStrings.messageActionsEdit, symbol: "pencil", id: "action-edit", action: onEdit)
                }
            }

            if isOwn {
                Section {
                    Button(role: .destructive, action: onDelete) {
                        Label(ChatStrings.messageActionsDelete, systemImage: "trash")
                    }
                    .accessibilityIdentifier("action-delete")
                }
            }
        }
        .listStyle(.insetGrouped)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private func row(_ title: String, symbol: String, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: symbol)
                .foregroundStyle(Color.primary)
        }
        .accessibilityIdentifier(id)
    }
}

/// Every reaction, for "More reactions".
struct ReactionPickerSheet: View {
    let onSelect: (String) -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: Tokens.Spacing.s), count: 8), spacing: Tokens.Spacing.m) {
                    ForEach(Array(ChatLogic.emojiList.enumerated()), id: \.offset) { index, emoji in
                        Button {
                            onSelect(emoji)
                        } label: {
                            Text(emoji).font(.system(size: 30))
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("emoji-\(index)")
                    }
                }
                .padding(Tokens.Spacing.l)
            }
            .navigationTitle(ChatStrings.messageActionsReactWithEmoji)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(CoreStrings.commonCancel) { dismiss() }
                }
            }
        }
        .presentationDetents([.medium])
    }
}

/// Pinning: for how long, then whether the channel hears about it.
struct PinMessageSheet: View {
    let onConfirm: (PinDuration, Bool) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var duration: PinDuration? = nil

    var body: some View {
        NavigationStack {
            List {
                if let duration {
                    Section(ChatStrings.channelNotifyOthers) {
                        option(
                            title: ChatStrings.channelPinWithAlert,
                            hint: ChatStrings.channelPinWithAlertHint,
                            symbol: "bell",
                            id: "pin-notify"
                        ) { onConfirm(duration, true) }
                        option(
                            title: ChatStrings.channelPinSilently,
                            hint: ChatStrings.channelPinSilentlyHint,
                            symbol: "bell.slash",
                            id: "pin-silent"
                        ) { onConfirm(duration, false) }
                    }
                } else {
                    Section(ChatStrings.channelPinForHowLong) {
                        ForEach(PinDuration.allCases) { choice in
                            Button {
                                duration = choice
                            } label: {
                                Label(choice.label, systemImage: choice == .forever ? "infinity" : "clock")
                                    .foregroundStyle(Color.primary)
                            }
                            .accessibilityIdentifier("pin-duration-\(choice.rawValue)")
                        }
                    }
                }
            }
            .navigationTitle(ChatStrings.messageActionsPin)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(CoreStrings.commonCancel) { dismiss() }
                }
            }
        }
        .presentationDetents([.medium])
    }

    private func option(title: String, hint: String, symbol: String, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: Tokens.Spacing.m) {
                Image(systemName: symbol).frame(width: 24).foregroundStyle(Tokens.Brand.weldchat)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).foregroundStyle(Color.primary)
                    Text(hint).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .accessibilityIdentifier(id)
    }
}
