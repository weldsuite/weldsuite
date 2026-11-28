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
            loadRoster()
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

    /// The roster, loaded once: the timeline names the teammate behind each
    /// reply and event, and the header shows the assignee's avatar.
    private func loadRoster() {
        guard members == nil, !membersLoading else { return }
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
        loadRoster()
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
                    // The clock the SLA countdown and "4min" read, once a minute.
                    TimelineView(.periodic(from: .now, by: 60)) { context in
                        VStack(spacing: 0) {
                            StatusStrip(conversation: detail.conversation, visitorOnline: model.room?.state.visitorOnline == true, now: context.date)
                            Divider()
                            thread(detail, now: context.date)
                        }
                    }
                    ComposerView(model: model)
                }
            } else if model.error != nil {
                DeskLoadErrorView(title: DeskStrings.conversationLoadError, error: model.error) { await model.load() }
            } else {
                ProgressView()
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 0) {
                    Text(title)
                        .font(.inter(.subheadline, weight: .semibold))
                        .lineLimit(1)
                        .accessibilityIdentifier("conversation-title")
                    if let conversation = model.detail?.conversation {
                        Text(DeskLogic.threadSubtitle(conversation))
                            .font(.inter(.caption))
                            .foregroundStyle(Tokens.Palette.mutedForeground)
                            .lineLimit(1)
                            .accessibilityIdentifier("conversation-subtitle")
                    }
                }
            }
            if let conversation = model.detail?.conversation {
                ToolbarItemGroup(placement: .primaryAction) {
                    AssignButton(model: model, conversation: conversation) { picking = true }
                    StateButton(model: model, conversation: conversation)
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

    /// The platform's header title: the subject, the customer's name, their email, or "Untitled conversation".
    private var title: String {
        guard let conversation = model.detail?.conversation else { return DeskStrings.conversationTitle }
        return DeskLogic.threadTitle(conversation) ?? DeskStrings.conversationUntitled
    }

    /// Who's typing, when the visitor is.
    private var typingName: String? {
        guard let name = model.room?.state.visitorsTyping.first else { return nil }
        return name.isEmpty ? DeskStrings.conversationTypingFallback : name
    }

    private func thread(_ detail: ConversationDetail, now: Date) -> some View {
        let messages = detail.messages
        let names = TimelineNames(
            members: model.members,
            visitor: DeskLogic.rowTitle(detail.conversation) ?? DeskStrings.conversationVisitor
        )
        return ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 0) {
                    if messages.isEmpty {
                        Text(DeskStrings.conversationEmptyThread)
                            .font(.inter(.subheadline))
                            .foregroundStyle(Tokens.Palette.mutedForeground)
                            .padding(.vertical, 64)
                    }
                    ForEach(Array(messages.enumerated()), id: \.element.id) { index, message in
                        if DeskLogic.startsDay(index > 0 ? messages[index - 1] : nil, message), let day = message.createdAt {
                            DaySeparator(day: day)
                        }
                        MessageRow(message: message, names: names, now: now) { model.attachmentOpenFailed() }
                            .id(message.id)
                    }
                    if let typingName {
                        TypingBubble(name: typingName).id("typing")
                    }
                }
                .padding(.vertical, Tokens.Spacing.s)
            }
            .scrollDismissesKeyboard(.interactively)
            .accessibilityIdentifier("thread")
            .onAppear { scrollToEnd(messages, proxy, animated: false) }
            .onChange(of: messages.count) { _, _ in scrollToEnd(messages, proxy, animated: true) }
            .onChange(of: typingName) { _, name in
                if name != nil { withAnimation { proxy.scrollTo("typing", anchor: .bottom) } }
            }
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

/// What the platform's header shows beside the title: the SLA chip, and the visitor online.
private struct StatusStrip: View {
    let conversation: DeskConversation
    let visitorOnline: Bool
    let now: Date

    var body: some View {
        let sla = DeskLogic.slaDisplay(conversation, now: now, showPaused: true, showFinished: true)
        if sla != nil || visitorOnline {
            HStack(spacing: Tokens.Spacing.m) {
                if let sla { SlaChip(display: sla) }
                if visitorOnline { OnlineIndicator() }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, Tokens.Spacing.l)
            .padding(.vertical, Tokens.Spacing.s)
        }
    }
}

/// Assign: the assignee's avatar once someone has it, else the add-person icon; opens the picker.
private struct AssignButton: View {
    let model: ConversationModel
    let conversation: DeskConversation
    let action: () -> Void

    var body: some View {
        let member = conversation.assigneeID.flatMap { id in model.members?.first { $0.userID == id } }
        Button(action: action) {
            if let member {
                InitialAvatar(name: member.name, url: member.picture.flatMap(URL.init(string:)), size: 24)
            } else {
                Image(systemName: "person.badge.plus")
            }
        }
        .disabled(model.managing)
        .accessibilityLabel(label(member))
        .accessibilityIdentifier("change-assignee")
    }

    private func label(_ member: DeskMember?) -> String {
        switch DeskLogic.assigneeLabel(assigneeID: conversation.assigneeID, userID: model.userID, members: model.members) {
        case .unassigned, .someone: DeskStrings.conversationAssign
        case .you: member?.name ?? DeskStrings.conversationAssignedToYou
        case let .teammate(name): name
        }
    }
}

/// Close while open (the primary button), Reopen once closed (outline), as on the platform.
private struct StateButton: View {
    let model: ConversationModel
    let conversation: DeskConversation

    var body: some View {
        let open = conversation.state == .open
        let title = open ? DeskStrings.conversationClose : DeskStrings.conversationReopen
        Group {
            if open {
                Button(title) { Task { await model.toggleState() } }
                    .buttonStyle(.borderedProminent)
            } else {
                Button(title) { Task { await model.toggleState() } }
                    .buttonStyle(.bordered)
                    .tint(Tokens.Palette.foreground)
            }
        }
        .font(.inter(.subheadline, weight: .medium))
        .controlSize(.small)
        .disabled(model.managing)
        .accessibilityIdentifier("conversation-toggle-state")
    }
}

/// The platform's composer: a rounded box with the field on top, the files
/// under it, and a row of attach, reply or note, and send. A note tints the
/// box amber, so it never reads as a reply.
private struct ComposerView: View {
    @Bindable var model: ConversationModel
    @State private var photoItem: PhotosPickerItem?
    @State private var choosingPhoto = false
    @State private var choosingFile = false
    @State private var takingPhoto = false

    private var isNote: Bool { model.mode == .note }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            TextField(
                isNote ? DeskStrings.conversationNotePlaceholder : DeskStrings.conversationReplyPlaceholder,
                text: $model.body,
                axis: .vertical
            )
            .font(.inter(.subheadline))
            .lineLimit(1...8)
            .padding(.leading, 10)
            .padding(.top, 7)
            .padding(.bottom, Tokens.Spacing.m)
            .frame(minHeight: 40, alignment: .topLeading)
            .onChange(of: model.body) { _, _ in model.bodyChanged() }
            .accessibilityIdentifier("composer-input")

            if !model.files.isEmpty {
                let flow = FlowLayout(spacing: 6)
                flow {
                    ForEach(model.files) { file in
                        PendingFileChip(file: file) { model.remove(file) }
                    }
                }
                .padding(.horizontal, 10)
                .padding(.bottom, Tokens.Spacing.s)
            }

            HStack(spacing: 6) {
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
                    Image(systemName: "plus")
                        .font(.system(size: 16, weight: .medium))
                        .foregroundStyle(Tokens.Palette.mutedForeground)
                        .frame(width: 32, height: 32)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel(DeskStrings.conversationAttach)
                .accessibilityIdentifier("composer-attach")

                FilterChip(title: DeskStrings.conversationReply, selected: !isNote, identifier: "mode-reply") { setMode(.message) }
                FilterChip(title: DeskStrings.conversationNote, selected: isNote, identifier: "mode-note") { setMode(.note) }

                Spacer(minLength: 0)

                Button {
                    Task { await model.send() }
                } label: {
                    Group {
                        if model.sending {
                            ProgressView().tint(Tokens.Palette.primaryForeground)
                        } else {
                            Image(systemName: "arrow.up")
                                .font(.system(size: 14, weight: .bold))
                                .foregroundStyle(model.canSend ? Tokens.Palette.primaryForeground : DeskColors.idleSendIcon)
                        }
                    }
                    .frame(width: 32, height: 32)
                    .background(model.canSend || model.sending ? Tokens.Palette.primary : DeskColors.idleSend, in: RoundedRectangle(cornerRadius: 12))
                }
                .buttonStyle(.plain)
                .disabled(!model.canSend)
                .accessibilityLabel(isNote ? DeskStrings.conversationAddNote : DeskStrings.conversationSendReply)
                .accessibilityIdentifier("composer-send")
            }
        }
        .padding(10)
        .background(isNote ? DeskColors.noteComposer : Tokens.Palette.background, in: RoundedRectangle(cornerRadius: 20))
        .overlay(RoundedRectangle(cornerRadius: 20).stroke(isNote ? DeskColors.noteBorder : Tokens.Palette.border, lineWidth: 1))
        .padding(.horizontal, Tokens.Spacing.m)
        .padding(.top, Tokens.Spacing.s)
        .padding(.bottom, Tokens.Spacing.m)
        .background(Tokens.Palette.background)
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

    private func setMode(_ mode: MessageKind) {
        model.mode = mode
        model.modeChanged()
    }
}

/// A file on the reply: uploading (a spinner) or uploaded (a paperclip and its size), with a remove button.
private struct PendingFileChip: View {
    let file: PendingFile
    let onRemove: () -> Void

    var body: some View {
        HStack(spacing: 6) {
            if file.uploading {
                ProgressView().controlSize(.mini).accessibilityLabel(DeskStrings.conversationUploading)
            } else {
                Image(systemName: "paperclip")
                    .font(.system(size: 10))
                    .foregroundStyle(Tokens.Palette.mutedForeground)
                    .accessibilityHidden(true)
            }
            Text(file.name).lineLimit(1)
            if let size = file.uploaded.map({ DeskLogic.formatFileSize($0.size) }), !size.isEmpty {
                Text(size).foregroundStyle(Tokens.Palette.mutedForeground)
            }
            Button(action: onRemove) {
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(Tokens.Palette.mutedForeground)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(DeskStrings.conversationRemoveAttachment(name: file.name))
        }
        .font(.inter(.caption))
        .padding(.horizontal, Tokens.Spacing.s)
        .padding(.vertical, Tokens.Spacing.xs)
        .frame(maxWidth: 240, alignment: .leading)
        .background(Tokens.Palette.muted.opacity(0.6), in: RoundedRectangle(cornerRadius: Tokens.Radius.medium))
        .overlay(RoundedRectangle(cornerRadius: Tokens.Radius.medium).stroke(Tokens.Palette.border, lineWidth: 1))
        .accessibilityIdentifier("pending-attachment")
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
