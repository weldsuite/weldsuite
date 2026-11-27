import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers
import WeldCore
import WeldUI

/// A conversation pushed onto the inbox's stack.
struct ConversationRoute: Hashable {
    let id: String
}

/// A file on the reply being written: uploading, or uploaded to the conversation.
struct PendingFile: Identifiable, Equatable {
    let id: UUID
    let name: String
    var uploaded: DeskAttachment?

    var uploading: Bool { uploaded == nil }
}

/// The conversation that's open, so its notifications don't pop up over it.
@MainActor
enum OpenConversation {
    static var id: String?
}

/// One conversation: its thread, kept live by the hub (`desk_message`,
/// `desk_conversation`) and by its room (the visitor typing and online),
/// the composer, and close / reopen / assign.
@MainActor
@Observable
final class ConversationModel {
    let conversationID: String
    private(set) var detail: ConversationDetail?
    private(set) var error: APIError?
    var body = ""
    var mode: MessageKind = .message
    private(set) var files: [PendingFile] = []
    private(set) var sending = false
    private(set) var managing = false
    private(set) var members: [DeskMember]?
    private(set) var membersLoading = false
    private(set) var membersFailed = false
    private(set) var room: ConversationRoom?
    /// Bumped on every success and failure, for the haptics.
    private(set) var successes = 0
    private(set) var failures = 0

    @ObservationIgnored private let env: AppEnvironment
    @ObservationIgnored private let store: DeskStore
    @ObservationIgnored private let toaster: Toaster
    @ObservationIgnored let userID: String?

    init(env: AppEnvironment, store: DeskStore, toaster: Toaster, conversationID: String, userID: String?) {
        self.env = env
        self.store = store
        self.toaster = toaster
        self.conversationID = conversationID
        self.userID = userID
        members = store.cachedMembers
    }

    var canSend: Bool {
        !sending && !files.contains(where: \.uploading)
            && (!body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !files.isEmpty)
    }

    /// The thread is on screen: load it and join its room.
    func start() async {
        if room == nil {
            let base = await store.realtimeRoomBase()
            // Left the screen meanwhile: no room to leave behind.
            guard !Task.isCancelled else { return }
            if room == nil {
                let joined = ConversationRoom(env: env, base: base, conversationID: conversationID)
                room = joined
                joined.start()
            }
        }
        await load()
    }

    /// The thread left the screen: leave the room.
    func stop() {
        room?.stop()
        room = nil
    }

    func load() async {
        do {
            let loaded = try await store.conversation(conversationID)
            detail = loaded
            error = nil
            loadAssigneeName(loaded.conversation.assigneeID)
        } catch {
            self.error = APIError.from(error)
        }
    }

    func bodyChanged() {
        if mode == .message, !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { room?.typed() }
    }

    func modeChanged() {
        if mode == .note { room?.stopTyping() }
    }

    func send() async {
        guard canSend else { return }
        sending = true
        room?.stopTyping()
        let attachments = files.compactMap(\.uploaded)
        do {
            let change = try await store.reply(conversationID, kind: mode, body: body, attachments: attachments)
            body = ""
            files = []
            apply(change.conversation)
            merge(change.message)
            successes += 1
        } catch {
            // The draft stays, to try again.
            toaster.show(DeskStrings.conversationSendError)
            failures += 1
        }
        sending = false
    }

    func toggleState() async {
        guard let conversation = detail?.conversation else { return }
        await manage(conversation.state == .open ? .close : .reopen, failure: DeskStrings.conversationManageError)
    }

    /// Nil unassigns.
    func assign(_ assigneeID: String?) async {
        await manage(.assign(assigneeID), failure: DeskStrings.conversationAssignError)
    }

    private func manage(_ action: ManageAction, failure: String) async {
        guard !managing else { return }
        managing = true
        do {
            let change = try await store.manage(conversationID, action: action)
            apply(change.conversation)
            merge(change.message)
            successes += 1
        } catch {
            toaster.show(failure)
            failures += 1
        }
        managing = false
    }

    func loadMembers(force: Bool = false) async {
        guard !membersLoading else { return }
        membersLoading = true
        membersFailed = false
        do {
            members = try await store.members(force: force)
        } catch {
            membersFailed = true
        }
        membersLoading = false
    }

    /// A teammate's name for the header: the roster, loaded once.
    private func loadAssigneeName(_ assigneeID: String?) {
        guard let assigneeID, !assigneeID.isEmpty, assigneeID != userID, members == nil else { return }
        Task { await loadMembers() }
    }

    /// A picked file: checked against the server's rules, then uploaded.
    func attach(_ file: PickedFile) async {
        guard files.count < DeskLogic.maxAttachments else {
            toaster.show(DeskStrings.conversationTooManyAttachments)
            return
        }
        switch DeskLogic.attachmentProblem(contentType: file.contentType, size: Int64(file.data.count)) {
        case .tooLarge:
            toaster.show(DeskStrings.conversationUploadTooLarge(name: file.name))
            return
        case .typeNotAllowed:
            toaster.show(DeskStrings.conversationUploadTypeNotAllowed(name: file.name))
            return
        case nil:
            break
        }
        let pending = PendingFile(id: UUID(), name: file.name, uploaded: nil)
        files.append(pending)
        do {
            let uploaded = try await store.upload(conversationID, file: file)
            if let index = files.firstIndex(where: { $0.id == pending.id }) { files[index].uploaded = uploaded }
        } catch {
            files.removeAll { $0.id == pending.id }
            if (error as? APIError)?.status == 503 {
                toaster.show(DeskStrings.conversationUploadUnavailable)
            } else {
                toaster.show(DeskStrings.conversationUploadError(name: file.name))
            }
        }
    }

    func remove(_ file: PendingFile) {
        files.removeAll { $0.id == file.id }
    }

    func attachmentOpenFailed() {
        toaster.show(DeskStrings.conversationAttachmentOpenError)
    }

    /// A picked file that couldn't be read.
    func attachmentReadFailed() {
        toaster.show(DeskStrings.conversationUploadError(name: DeskStrings.conversationAttachment))
    }

    /// A picked file larger than the server takes, refused before it's read.
    func attachmentTooLarge(_ name: String) {
        toaster.show(DeskStrings.conversationUploadTooLarge(name: name))
    }

    /// A hub event: patch the thread with the record, or reload after a gap.
    func hubEvent(_ event: RealtimeEvent) async {
        if event.isResync {
            await load()
            return
        }
        if realtimeTopic(event.topic, matches: "desk_message"),
           let message = DeskStore.message(fromEvent: event.data), message.conversationID == conversationID {
            merge(message)
        } else if realtimeTopic(event.topic, matches: "desk_conversation"),
                  let conversation = DeskStore.conversation(fromEvent: event.data), conversation.id == conversationID {
            apply(conversation)
        }
    }

    private func merge(_ message: DeskMessage) {
        guard var current = detail else { return }
        current.messages = DeskLogic.merge(current.messages, message)
        detail = current
    }

    private func apply(_ conversation: DeskConversation) {
        guard var current = detail else { return }
        current.conversation = conversation
        detail = current
        loadAssigneeName(conversation.assigneeID)
    }
}

struct ConversationView: View {
    let env: AppEnvironment
    @State private var model: ConversationModel
    @State private var picking = false

    init(env: AppEnvironment, store: DeskStore, toaster: Toaster, route: ConversationRoute, userID: String?) {
        self.env = env
        _model = State(initialValue: ConversationModel(env: env, store: store, toaster: toaster, conversationID: route.id, userID: userID))
    }

    var body: some View {
        Group {
            if let detail = model.detail {
                VStack(spacing: 0) {
                    ConversationHeader(model: model, conversation: detail.conversation) { picking = true }
                    Divider()
                    thread(detail.messages)
                    if let name = model.room?.state.visitorsTyping.first {
                        Text(DeskStrings.conversationTyping(name: name.isEmpty ? DeskStrings.conversationTypingFallback : name))
                            .font(.caption.italic())
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, Tokens.Spacing.l)
                            .padding(.bottom, Tokens.Spacing.xs)
                            .accessibilityIdentifier("typing")
                    }
                    ComposerView(model: model)
                }
            } else if model.error != nil {
                DeskLoadErrorView(title: DeskStrings.conversationLoadError, error: model.error) { await model.load() }
            } else {
                ProgressView()
            }
        }
        .navigationTitle(model.detail.map { DeskLogic.threadTitle($0.conversation) } ?? DeskStrings.conversationTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let conversation = model.detail?.conversation {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        Task { await model.toggleState() }
                    } label: {
                        Label(
                            conversation.state == .open ? DeskStrings.conversationClose : DeskStrings.conversationReopen,
                            systemImage: conversation.state == .open ? "checkmark.circle" : "arrow.uturn.backward.circle"
                        )
                    }
                    .disabled(model.managing)
                    .accessibilityIdentifier("conversation-toggle-state")
                }
            }
        }
        .sheet(isPresented: $picking) {
            AssigneePicker(model: model) { assignee in
                picking = false
                Task { await model.assign(assignee) }
            }
        }
        .sensoryFeedback(.success, trigger: model.successes)
        .sensoryFeedback(.error, trigger: model.failures)
        .task { await model.start() }
        .task {
            // The hub, while the thread is on screen.
            guard let realtime = env.realtime else { return }
            for await event in realtime.events(["desk_message", "desk_conversation"]) {
                await model.hubEvent(event)
            }
        }
        .onAppear { OpenConversation.id = model.conversationID }
        .onDisappear {
            if OpenConversation.id == model.conversationID { OpenConversation.id = nil }
            model.stop()
        }
    }

    private func thread(_ messages: [DeskMessage]) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 10) {
                    if messages.isEmpty {
                        Text(DeskStrings.conversationEmptyThread)
                            .foregroundStyle(.secondary)
                            .padding(.top, 40)
                    }
                    ForEach(messages) { message in
                        MessageRow(message: message) { model.attachmentOpenFailed() }
                            .id(message.id)
                    }
                }
                .padding(.horizontal, Tokens.Spacing.l)
                .padding(.vertical, Tokens.Spacing.m)
            }
            .scrollDismissesKeyboard(.interactively)
            .accessibilityIdentifier("thread")
            .onAppear { scrollToEnd(messages, proxy, animated: false) }
            .onChange(of: messages.count) { _, _ in scrollToEnd(messages, proxy, animated: true) }
        }
    }

    private func scrollToEnd(_ messages: [DeskMessage], _ proxy: ScrollViewProxy, animated: Bool) {
        guard let last = messages.last?.id else { return }
        if animated {
            withAnimation { proxy.scrollTo(last, anchor: .bottom) }
        } else {
            proxy.scrollTo(last, anchor: .bottom)
        }
    }
}

/// State, channel, number, the visitor online, and who it's assigned to, with the assign actions.
private struct ConversationHeader: View {
    let model: ConversationModel
    let conversation: DeskConversation
    let onPick: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Spacing.s) {
            HStack(spacing: Tokens.Spacing.s) {
                StateBadge(state: conversation.state)
                ChannelBadge(channel: conversation.channel, value: conversation.channelValue)
                Text("#\(conversation.number)").font(.footnote.weight(.medium)).foregroundStyle(.secondary)
                if model.room?.state.visitorOnline == true {
                    HStack(spacing: 4) {
                        Circle().fill(Color.green).frame(width: 7, height: 7)
                        Text(DeskStrings.conversationVisitorOnline).font(.footnote.weight(.medium)).foregroundStyle(.secondary)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("visitor-online")
                }
                Spacer(minLength: 0)
            }
            if let email = conversation.email, !email.isEmpty, conversation.name != nil {
                Text(email).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
            }
            HStack(spacing: 4) {
                Text(DeskStrings.conversationAssignee).foregroundStyle(.secondary)
                Text(assigneeText).fontWeight(.semibold).lineLimit(1).accessibilityIdentifier("assignee-label")
            }
            .font(.footnote)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Tokens.Spacing.s) {
                    let mine = conversation.assigneeID != nil && conversation.assigneeID == model.userID
                    if !mine, let userID = model.userID {
                        AssignChip(title: DeskStrings.conversationAssignToMe, icon: "person.crop.circle.badge.checkmark", identifier: "assign-to-me", disabled: model.managing) {
                            Task { await model.assign(userID) }
                        }
                    }
                    AssignChip(title: DeskStrings.conversationChangeAssignee, icon: "person.badge.plus", identifier: "change-assignee", disabled: model.managing, action: onPick)
                    if let assignee = conversation.assigneeID, !assignee.isEmpty {
                        AssignChip(title: DeskStrings.conversationUnassign, icon: "person.badge.minus", identifier: "unassign", disabled: model.managing) {
                            Task { await model.assign(nil) }
                        }
                    }
                }
            }
        }
        .padding(.horizontal, Tokens.Spacing.l)
        .padding(.vertical, Tokens.Spacing.s)
    }

    private var assigneeText: String {
        switch DeskLogic.assigneeLabel(assigneeID: conversation.assigneeID, userID: model.userID, members: model.members) {
        case .unassigned: DeskStrings.conversationUnassignedLabel
        case .you: DeskStrings.conversationAssignedToYou
        case .someone: DeskStrings.conversationAssignedEvent
        case let .teammate(name): name
        }
    }
}

private struct AssignChip: View {
    let title: String
    let icon: String
    let identifier: String
    let disabled: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label(title, systemImage: icon)
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(Tokens.Brand.welddesk.opacity(0.12), in: Capsule())
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.5 : 1)
        .accessibilityIdentifier(identifier)
    }
}

/// Reply or note, the files on it, the text, and send.
private struct ComposerView: View {
    @Bindable var model: ConversationModel
    @State private var photoItem: PhotosPickerItem?
    @State private var choosingPhoto = false
    @State private var choosingFile = false
    @State private var takingPhoto = false

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Spacing.s) {
            Picker(DeskStrings.conversationReply, selection: $model.mode) {
                Text(DeskStrings.conversationReply).tag(MessageKind.message)
                Text(DeskStrings.conversationNote).tag(MessageKind.note)
            }
            .pickerStyle(.segmented)
            .fixedSize()
            .accessibilityIdentifier("composer-mode")
            .onChange(of: model.mode) { _, _ in model.modeChanged() }

            if !model.files.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: Tokens.Spacing.s) {
                        ForEach(model.files) { file in
                            HStack(spacing: 4) {
                                if file.uploading {
                                    ProgressView().controlSize(.mini).accessibilityLabel(DeskStrings.conversationUploading)
                                } else {
                                    Image(systemName: "doc").accessibilityHidden(true)
                                }
                                Text(file.name).lineLimit(1)
                                Button {
                                    model.remove(file)
                                } label: {
                                    Image(systemName: "xmark.circle.fill")
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel(DeskStrings.conversationRemoveAttachment(name: file.name))
                            }
                            .font(.caption)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .background(Color(.secondarySystemFill), in: Capsule())
                            .accessibilityIdentifier("pending-attachment")
                        }
                    }
                }
            }

            HStack(alignment: .bottom, spacing: Tokens.Spacing.s) {
                Menu {
                    if UIImagePickerController.isSourceTypeAvailable(.camera) {
                        Button { takingPhoto = true } label: { Label(DeskStrings.conversationTakePhoto, systemImage: "camera") }
                            .accessibilityIdentifier("attach-camera")
                    }
                    Button { choosingPhoto = true } label: { Label(DeskStrings.conversationChoosePhoto, systemImage: "photo") }
                        .accessibilityIdentifier("attach-photo")
                    Button { choosingFile = true } label: { Label(DeskStrings.conversationChooseFile, systemImage: "doc") }
                        .accessibilityIdentifier("attach-file")
                } label: {
                    Image(systemName: "paperclip")
                        .font(.system(size: 18))
                        .frame(width: 36, height: 36)
                }
                .accessibilityLabel(DeskStrings.conversationAttach)
                .accessibilityIdentifier("composer-attach")

                TextField(
                    model.mode == .note ? DeskStrings.conversationNotePlaceholder : DeskStrings.conversationReplyPlaceholder,
                    text: $model.body,
                    axis: .vertical
                )
                .lineLimit(1...5)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 18))
                .onChange(of: model.body) { _, _ in model.bodyChanged() }
                .accessibilityIdentifier("composer-input")

                Button {
                    Task { await model.send() }
                } label: {
                    Group {
                        if model.sending {
                            ProgressView().tint(.white)
                        } else {
                            Image(systemName: "paperplane.fill").foregroundStyle(.white)
                        }
                    }
                    .frame(width: 36, height: 36)
                    .background(model.canSend ? Tokens.Brand.welddesk : Color(.systemGray3), in: Circle())
                }
                .buttonStyle(.plain)
                .disabled(!model.canSend)
                .accessibilityLabel(DeskStrings.conversationSend)
                .accessibilityIdentifier("composer-send")
            }
        }
        .padding(.horizontal, Tokens.Spacing.m)
        .padding(.vertical, Tokens.Spacing.s)
        .background(.bar)
        .photosPicker(isPresented: $choosingPhoto, selection: $photoItem, matching: .images)
        .onChange(of: photoItem) { _, item in
            guard let item else { return }
            photoItem = nil
            Task {
                if let file = await PickedFiles.photo(item) {
                    await model.attach(file)
                } else {
                    model.attachmentReadFailed()
                }
            }
        }
        .fileImporter(isPresented: $choosingFile, allowedContentTypes: PickedFiles.documentTypes) { result in
            guard case let .success(url) = result else { return }
            Task {
                switch PickedFiles.document(url) {
                case let .file(file): await model.attach(file)
                case let .tooLarge(name): model.attachmentTooLarge(name)
                case .unreadable: model.attachmentReadFailed()
                }
            }
        }
        .fullScreenCover(isPresented: $takingPhoto) {
            CameraPicker { image in
                takingPhoto = false
                guard let image, let file = PickedFiles.camera(image) else { return }
                Task { await model.attach(file) }
            }
            .ignoresSafeArea()
        }
    }
}

/// Reading what the agent picked into a `PickedFile`.
enum PickedFiles {
    /// What the file picker offers: the types the server takes.
    static let documentTypes: [UTType] = DeskLogic.attachmentTypes.compactMap { UTType(mimeType: $0) }

    /// A library photo, as JPEG unless it's already a type the server takes (HEIC isn't).
    static func photo(_ item: PhotosPickerItem) async -> PickedFile? {
        guard let data = try? await item.loadTransferable(type: Data.self) else { return nil }
        let type = item.supportedContentTypes.first
        if let type, let mime = type.preferredMIMEType, DeskLogic.attachmentTypes.contains(mime) {
            let ext = type.preferredFilenameExtension ?? "jpg"
            return PickedFile(name: "photo.\(ext)", contentType: mime, data: data)
        }
        guard let image = UIImage(data: data), let jpeg = image.jpegData(compressionQuality: 0.85) else { return nil }
        return PickedFile(name: "photo.jpg", contentType: "image/jpeg", data: jpeg)
    }

    static func camera(_ image: UIImage) -> PickedFile? {
        guard let jpeg = image.jpegData(compressionQuality: 0.85) else { return nil }
        return PickedFile(name: "photo.jpg", contentType: "image/jpeg", data: jpeg)
    }

    enum Document {
        case file(PickedFile)
        case tooLarge(String)
        case unreadable
    }

    /// A document from Files: its name and type from the file; one over 10 MB isn't read.
    static func document(_ url: URL) -> Document {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let name = url.lastPathComponent
        let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize
        if let size, Int64(size) > DeskLogic.maxAttachmentBytes { return .tooLarge(name) }
        let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        guard let data = try? Data(contentsOf: url) else { return .unreadable }
        return .file(PickedFile(name: name, contentType: mime, data: data))
    }
}

/// The camera, for a photo on a reply.
struct CameraPicker: UIViewControllerRepresentable {
    let onDone: (UIImage?) -> Void

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onDone: onDone) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let onDone: (UIImage?) -> Void

        init(onDone: @escaping (UIImage?) -> Void) {
            self.onDone = onDone
        }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            onDone(info[.originalImage] as? UIImage)
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            onDone(nil)
        }
    }
}
