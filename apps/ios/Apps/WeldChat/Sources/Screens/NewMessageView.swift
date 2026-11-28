import SwiftUI
import UIKit
import WeldCore
import WeldUI

/// Slack's "New message": pick any mix of channels, conversations and people
/// in "To:", write the message (with files, or as a voice message) and send
/// it. Every channel and conversation gets it; the people picked share one
/// DM (an existing one with the same people is reused). With a single
/// destination it opens after sending.
struct NewMessageView: View {
    let env: AppEnvironment
    let store: ChatStore
    let person: Person

    @Environment(ChatNavigator.self) private var navigator
    @Environment(\.dismiss) private var dismiss

    @State private var query = ""
    @State private var recipients: [MessageRecipient] = []
    @State private var message = ""
    @State private var pendingFiles: [PendingFile] = []
    @State private var sending = false
    @State private var error: String?
    @State private var loaded = false
    @State private var showAttach = false
    @State private var micDenied = false
    @State private var recorder = VoiceRecorder()
    /// A recorded voice message is uploading: the bar stays, frozen at its length.
    @State private var sendingVoiceDuration: TimeInterval?
    @FocusState private var toFocused: Bool
    @FocusState private var messageFocused: Bool

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                toField
                Divider()
                choices
            }
            .safeAreaInset(edge: .bottom) {
                if !recipients.isEmpty { composer }
            }
            .navigationTitle(ChatStrings.newMessageTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(CoreStrings.commonCancel) {
                        if recorder.isRecording { recorder.cancel() }
                        dismiss()
                    }
                    .disabled(sending)
                }
            }
            .alert(ChatStrings.composerMicPermissionTitle, isPresented: $micDenied) {
                Button(CoreStrings.commonCancel, role: .cancel) {}
                Button(ChatStrings.composerOpenSettings) {
                    if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                }
            } message: {
                Text(ChatStrings.composerMicPermissionBody)
            }
        }
        .interactiveDismissDisabled(sending || sendingVoiceDuration != nil)
        .task {
            toFocused = true
            await store.loadHome()
            await store.loadRoster()
            loaded = true
        }
        .onDisappear {
            if recorder.isRecording { recorder.cancel() }
        }
    }

    // MARK: To

    private var toField: some View {
        HStack(alignment: .firstTextBaseline, spacing: Tokens.Spacing.s) {
            Text(ChatStrings.newMessageTo).foregroundStyle(.secondary)
            FlowLayout(spacing: 6) {
                ForEach(recipients) { recipient in
                    Button {
                        toggle(recipient)
                    } label: {
                        HStack(spacing: 4) {
                            Text(recipient.label).lineLimit(1)
                            Image(systemName: "xmark").font(.inter(.caption2, weight: .bold))
                        }
                        .font(.inter(.subheadline, weight: .medium))
                        .foregroundStyle(Tokens.Palette.primary)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                        .background(Tokens.Palette.primary.opacity(0.12), in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(ChatStrings.newMessageRemoveRecipient(name: recipient.name))
                    .accessibilityIdentifier("recipient-chip-\(recipient.id)")
                }
                TextField(recipients.isEmpty ? ChatStrings.newMessageToPlaceholder : "", text: Binding(
                    get: { query },
                    set: { text in
                        query = text
                        error = nil
                    }
                ))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .focused($toFocused)
                .frame(minWidth: 140)
                .accessibilityIdentifier("new-message-to")
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Tokens.Spacing.l)
        .padding(.vertical, Tokens.Spacing.m)
        .contentShape(Rectangle())
        .onTapGesture { toFocused = true }
    }

    private var choices: some View {
        let recent = NewMessageRules.recent(channels: store.channels, dms: store.dms)
        let term = NewMessageRules.term(query)
        let people = NewMessageRules.people(store.roster, selfID: person.id, query: query, recent: recent)
        let channels = NewMessageRules.channels(store.channels, query: query, recent: recent)
        let selected = Set(recipients.map(\.id))
        return List {
            if term.isEmpty, !loaded, recent.isEmpty {
                ProgressView().frame(maxWidth: .infinity).listRowSeparator(.hidden)
            }
            if term.isEmpty, !recent.isEmpty {
                Section(ChatStrings.newMessageRecent) {
                    ForEach(recent) { recipient in row(recipient, selected: selected.contains(recipient.id)) }
                }
            }
            if !people.isEmpty {
                Section(ChatStrings.newMessagePeople) {
                    ForEach(people) { recipient in row(recipient, selected: selected.contains(recipient.id)) }
                }
            }
            if !channels.isEmpty {
                Section(ChatStrings.newMessageChannels) {
                    ForEach(channels) { recipient in row(recipient, selected: selected.contains(recipient.id)) }
                }
            }
            if !term.isEmpty, people.isEmpty, channels.isEmpty {
                Text(ChatStrings.newMessageNoResults(query: query.trimmingCharacters(in: .whitespacesAndNewlines)))
                    .foregroundStyle(.secondary)
                    .listRowSeparator(.hidden)
            }
        }
        .listStyle(.plain)
        .scrollDismissesKeyboard(.interactively)
    }

    private func row(_ recipient: MessageRecipient, selected: Bool) -> some View {
        Button {
            toggle(recipient)
        } label: {
            HStack(spacing: Tokens.Spacing.m) {
                switch recipient {
                case let .channel(_, _, isPrivate):
                    Image(systemName: isPrivate ? "lock" : "number")
                        .foregroundStyle(.secondary)
                        .frame(width: 32, height: 32)
                case let .dm(_, _, people):
                    GroupAvatar(people: people, size: 32)
                case let .person(_, name, picture):
                    ChatAvatar(name: name, url: picture, size: 32)
                }
                Text(recipient.label).lineLimit(1).foregroundStyle(Color.primary)
                Spacer(minLength: 0)
                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                    .font(.inter(.title3))
                    .foregroundStyle(selected ? Tokens.Palette.primary : Color.secondary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("recipient-\(recipient.id)")
    }

    // MARK: Composer

    private var composer: some View {
        let canSend = NewMessageRules.canSend(recipients: recipients, text: message, fileCount: pendingFiles.count, sending: sending)
        return VStack(spacing: Tokens.Spacing.s) {
            if let error {
                InlineError(text: error)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, Tokens.Spacing.l)
            }
            PendingFilesBar(files: pendingFiles) { file in
                pendingFiles.removeAll { $0.id == file.id }
            }
            if recorder.isRecording || sendingVoiceDuration != nil {
                RecordingBar(
                    recorder: recorder,
                    sending: sendingVoiceDuration != nil,
                    frozenDuration: sendingVoiceDuration,
                    onCancel: { recorder.cancel() },
                    onSend: { Task { await sendVoice() } }
                )
                .padding(.horizontal, Tokens.Spacing.m)
            } else {
                HStack(alignment: .bottom, spacing: Tokens.Spacing.s) {
                    Button {
                        messageFocused = false
                        toFocused = false
                        showAttach = true
                    } label: {
                        Image(systemName: "plus")
                            .font(.system(size: 18, weight: .semibold))
                            .frame(width: 36, height: 36)
                            .background(Color(.secondarySystemBackground), in: Circle())
                    }
                    .buttonStyle(.plain)
                    .disabled(sending)
                    .accessibilityLabel(ChatStrings.composerAttach)
                    .accessibilityIdentifier("new-message-attach")

                    TextField(ChatStrings.newMessageMessagePlaceholder, text: $message, axis: .vertical)
                        .lineLimit(1...6)
                        .focused($messageFocused)
                        .padding(.horizontal, Tokens.Spacing.m)
                        .padding(.vertical, 8)
                        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 20))
                        .accessibilityIdentifier("new-message-input")

                    if canSend || sending {
                        Button {
                            Task { await send() }
                        } label: {
                            Group {
                                if sending {
                                    ProgressView().tint(.white)
                                } else {
                                    Image(systemName: "arrow.up").font(.system(size: 16, weight: .bold))
                                }
                            }
                            .frame(width: 36, height: 36)
                            .foregroundStyle(.white)
                            .background(Tokens.Palette.primary, in: Circle())
                        }
                        .buttonStyle(.plain)
                        .disabled(!canSend)
                        .accessibilityLabel(ChatStrings.composerSend)
                        .accessibilityIdentifier("new-message-send")
                    } else {
                        Button {
                            Task { await startRecording() }
                        } label: {
                            Image(systemName: "mic")
                                .font(.system(size: 18, weight: .semibold))
                                .frame(width: 36, height: 36)
                                .background(Color(.secondarySystemBackground), in: Circle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(ChatStrings.composerRecordVoice)
                        .accessibilityIdentifier("new-message-mic")
                    }
                }
                .padding(.horizontal, Tokens.Spacing.m)
            }
        }
        .padding(.vertical, Tokens.Spacing.s)
        .background(.bar)
        .attachmentPicker(isPresented: $showAttach) { files in
            pendingFiles.append(contentsOf: files)
        }
    }

    // MARK: Actions

    private func toggle(_ recipient: MessageRecipient) {
        guard !sending else { return }
        error = nil
        query = ""
        recipients = NewMessageRules.toggled(recipients, recipient)
    }

    private func send() async {
        guard NewMessageRules.canSend(recipients: recipients, text: message, fileCount: pendingFiles.count, sending: sending) else { return }
        sending = true
        error = nil
        do {
            try await deliver(body: message.trimmingCharacters(in: .whitespacesAndNewlines), files: pendingFiles)
        } catch {
            self.error = ChatStrings.newMessageSendFailed
            sending = false
        }
    }

    private func startRecording() async {
        messageFocused = false
        toFocused = false
        switch await recorder.start() {
        case .started:
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        case .denied:
            micDenied = true
        case .failed:
            error = ChatStrings.composerRecordFailed
        }
    }

    /// A tap-and-send by accident gives a near-silent clip: it is dropped instead.
    private func sendVoice() async {
        guard recorder.duration >= ChatLogic.minVoiceMessageSeconds else {
            recorder.cancel()
            error = ChatStrings.composerVoiceTooShort
            return
        }
        sendingVoiceDuration = recorder.duration
        guard let file = recorder.stop() else {
            sendingVoiceDuration = nil
            error = ChatStrings.composerVoiceSendFailed
            return
        }
        do {
            try await deliver(body: "", files: [file])
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        } catch {
            self.error = ChatStrings.composerVoiceSendFailed
            sendingVoiceDuration = nil
        }
    }

    /// Every channel and conversation picked gets the message; the people
    /// share one DM. Files are uploaded once per destination (an upload
    /// belongs to its channel). On a failure whoever already has it leaves
    /// "To:", so sending again doesn't post it twice.
    private func deliver(body: String, files: [PendingFile]) async throws {
        let plan = NewMessageRules.split(recipients)
        var delivered = Set<String>()
        var destinations: [(id: String, isDM: Bool, name: String?)] = []
        let names = Dictionary(recipients.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
        do {
            for conversation in plan.conversations {
                try await post(to: conversation.id, body: body, files: files)
                delivered.insert(conversation.key)
                destinations.append((id: conversation.id, isDM: conversation.isDM, name: names[conversation.key]))
            }
            if !plan.people.isEmpty {
                let dm = try await store.createDm(userIDs: plan.people)
                try await post(to: dm.id, body: body, files: files)
                for recipient in recipients {
                    if case .person = recipient { delivered.insert(recipient.id) }
                }
                destinations.append((id: dm.id, isDM: true, name: dm.name))
            }
        } catch {
            recipients.removeAll { delivered.contains($0.id) }
            throw error
        }
        await store.loadHome()
        // One destination: open it. Several: back to where you were.
        if destinations.count == 1, let only = destinations.first {
            navigator.finishSheet(opening: .channel(ChannelRoute(channelID: only.id, name: only.name, type: only.isDM ? "dm" : nil)))
        } else {
            navigator.finishSheet(opening: nil)
        }
    }

    private func post(to channelID: String, body: String, files: [PendingFile]) async throws {
        var attachments: [ChatAttachment] = []
        for file in files {
            if let uploaded = try? await ChatUpload.upload(file, channelID: channelID, env: env) {
                attachments.append(uploaded)
            }
        }
        if !files.isEmpty, attachments.isEmpty { throw APIError(status: nil, code: nil) }
        _ = try await store.send(channelID: channelID, body: body, attachments: attachments)
    }
}
