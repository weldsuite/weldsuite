import Foundation
import Observation
import WeldCore

/// One open conversation: the channel, its messages (older pages on
/// demand), the room socket, the composer's text, files, reply and edit
/// state, the draft that is saved as you type, and every action on a message.
@MainActor
@Observable
final class ChannelModel {
    let channelID: String
    private(set) var channel: ChatChannel?
    /// The DM as the DM list maps it: the header's name and picture.
    private(set) var dm: DmConversation?
    private(set) var messages: [ChatMessage] = []
    private(set) var loading = true
    private(set) var hasOlder = false
    private(set) var loadingOlder = false
    private(set) var agents: [ChannelMemberInfo] = []
    /// Follow and mute of a record chat, shown before the channel reloads.
    private(set) var followOverride: Bool?
    private(set) var muteOverride: Bool?

    var input = ""
    var pendingFiles: [PendingFile] = []
    private(set) var uploading = false
    private(set) var replyTo: ReplyReference?
    var replyMention = true
    private(set) var editing: ChatMessage?
    private(set) var dismissedSuggestions: Set<String> = []
    private(set) var mentionQuery: String?
    var pinnedIndex = 0
    private(set) var sendingVoiceDuration: TimeInterval?
    let recorder = VoiceRecorder()
    private(set) var room: ChatRoomSocket?

    @ObservationIgnored let store: ChatStore
    @ObservationIgnored let env: AppEnvironment
    @ObservationIgnored let selfID: String
    @ObservationIgnored private let selfName: String?
    @ObservationIgnored private var olderCursor: String?
    @ObservationIgnored private var olderLoaded = false
    @ObservationIgnored private var pendingSends: [String: String?] = [:]
    @ObservationIgnored private var localPins: Set<String> = []
    @ObservationIgnored private var started = false
    @ObservationIgnored private var draftID: String?
    @ObservationIgnored private var draftTask: Task<Void, Never>?
    @ObservationIgnored private var deletingDraft = false
    @ObservationIgnored private var draftBeforeEdit = ""
    @ObservationIgnored private var programmaticInput = false
    @ObservationIgnored private var reloadTask: Task<Void, Never>?

    init(channelID: String, store: ChatStore, env: AppEnvironment, person: Person) {
        self.channelID = channelID
        self.store = store
        self.env = env
        selfID = person.id
        selfName = person.name
    }

    // MARK: Derived

    var names: [String: String] {
        var names = store.memberNames
        for agent in agents {
            if let name = agent.name { names[agent.userID] = name }
        }
        return names
    }

    /// Oldest first; a call's end message folded into its start's card.
    var timeline: (rows: [ChatMessage], calls: [String: CallLogEntry], openCallID: String?) {
        let chronological = MessageLayout.chronological(messages)
        let log = CallLog.build(chronological)
        return (chronological.filter { !log.folded.contains($0.id) }, log.entries, log.openID)
    }

    var pinned: [ChatMessage] {
        MessageLayout.chronological(messages).filter { $0.isPinned && !$0.pending }
    }

    var canSend: Bool {
        !input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !pendingFiles.isEmpty
    }

    var isRecording: Bool { recorder.isRecording || sendingVoiceDuration != nil }

    var showThreadSuggestion: Bool {
        guard let reply = replyTo, editing == nil, channel?.threadsEnabled != false else { return false }
        return reply.depth >= ChatLogic.threadSuggestionDepth && !dismissedSuggestions.contains(reply.rootID)
    }

    /// A record chat's follow state: a membership row in the loaded channel.
    var following: Bool? {
        guard let channel else { return nil }
        return followOverride ?? channel.members.contains { $0.userID == selfID }
    }

    var recordMuted: Bool {
        muteOverride ?? channel?.members.first { $0.userID == selfID }?.isMuted ?? false
    }

    // MARK: Lifecycle

    /// Load everything the first time; reconnect and refresh on a return.
    func start() async {
        if !started {
            started = true
            await loadDraft()
            async let channelLoad: Void = loadChannel()
            async let messageLoad: Void = loadMessages()
            _ = await (channelLoad, messageLoad)
            await loadAgents()
        } else {
            await loadMessages()
        }
        if room == nil {
            let base = await RealtimeEndpoint.base(for: env.serverURL)
            let room = ChatRoomSocket(env: env, base: base, channelID: channelID, selfID: selfID)
            room.onChange = { [weak self] in self?.scheduleReload() }
            self.room = room
        }
        room?.start()
    }

    func stop() {
        room?.stop()
    }

    private func scheduleReload() {
        reloadTask?.cancel()
        reloadTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(150))
            guard !Task.isCancelled else { return }
            await self?.loadMessages()
        }
    }

    // MARK: Loading

    func loadChannel() async {
        do {
            var loaded = try await store.channel(channelID)
            if loaded.isDM, let dm = try? await store.listDms().first(where: { $0.id == channelID }) {
                self.dm = dm
                loaded.name = dm.name
            }
            channel = loaded
            followOverride = nil
            muteOverride = nil
        } catch {
            // The header keeps the name the list gave.
        }
    }

    private func loadAgents() async {
        guard let members = try? await store.channelMembers(channelID) else { return }
        agents = members.filter { $0.isAgent && $0.name != nil }
    }

    func loadMessages() async {
        do {
            let page = try await store.messages(channelID: channelID)
            let fetched = page.items.map { message -> ChatMessage in
                var next = message
                if localPins.contains(next.id) { next.isPinned = true }
                return next
            }
            let fetchedIDs = Set(fetched.map(\.id))
            for (temp, server) in pendingSends {
                if let server, fetchedIDs.contains(server) { pendingSends[temp] = nil }
            }
            let pending = messages.filter { $0.pending && pendingSends[$0.id] != nil }
            messages = MessageLayout.merge(existing: messages, fetched: fetched, pending: pending)
            if !olderLoaded {
                olderCursor = page.cursor
                hasOlder = page.hasMore
            }
            // Viewing it reads it.
            Task { try? await store.markRead(channelID) }
        } catch {
            // Keep what is on screen.
        }
        loading = false
    }

    func loadOlder() async {
        guard hasOlder, let cursor = olderCursor, !loadingOlder else { return }
        loadingOlder = true
        defer { loadingOlder = false }
        guard let page = try? await store.messages(channelID: channelID, cursor: cursor) else { return }
        olderLoaded = true
        let known = Set(messages.map(\.id))
        messages = page.items.filter { !known.contains($0.id) } + messages
        olderCursor = page.cursor
        hasOlder = page.hasMore
    }

    // MARK: Drafts

    private func loadDraft() async {
        guard let draft = try? await store.listDrafts(channelID: channelID).first, !draft.content.isEmpty else { return }
        draftID = draft.id
        setInput(draft.content)
    }

    /// The composer's text changed by typing.
    func inputChanged(_ text: String) {
        if programmaticInput {
            programmaticInput = false
            return
        }
        if !text.isEmpty { room?.keystroke() }
        if editing == nil {
            if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Task { await clearDraft() }
            } else {
                saveDraft(text)
            }
        }
        mentionQuery = MentionText.mentionQuery(text)
    }

    private func setInput(_ text: String) {
        if input != text { programmaticInput = true }
        input = text
    }

    /// Saved 800 ms after the last keystroke.
    private func saveDraft(_ text: String) {
        draftTask?.cancel()
        draftTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(800))
            guard let self, !Task.isCancelled, !self.deletingDraft else { return }
            do {
                let id = try await self.store.saveDraft(draftID: self.draftID, channelID: self.channelID, content: text)
                if self.deletingDraft {
                    // Cleared while this was being made: don't keep an orphan.
                    if let id { Task { try? await self.store.deleteDraft(id) } }
                } else {
                    self.draftID = id
                }
            } catch {
                // Best effort.
            }
        }
    }

    private func clearDraft() async {
        draftTask?.cancel()
        deletingDraft = true
        defer { deletingDraft = false }
        guard let id = draftID else { return }
        draftID = nil
        try? await store.deleteDraft(id)
    }

    // MARK: Composer

    func insertMention(userID: String) {
        setInput(MentionText.insertMention(input, userID: userID))
        mentionQuery = nil
    }

    func startReply(_ message: ChatMessage) {
        replyTo = ReplyReference(
            messageID: message.id,
            rootID: message.replyTo?.rootID ?? message.id,
            depth: message.replyTo?.depth ?? 0,
            authorID: message.authorID,
            authorName: message.authorName,
            authorAvatar: message.authorAvatar,
            content: message.content,
            hasAttachments: message.hasAttachments || !message.attachments.isEmpty
        )
        replyMention = true
    }

    func cancelReply() {
        replyTo = nil
    }

    func startEdit(_ message: ChatMessage) {
        if editing == nil { draftBeforeEdit = input }
        editing = message
        setInput(message.content)
    }

    func cancelEdit() {
        editing = nil
        setInput(draftBeforeEdit)
        draftBeforeEdit = ""
    }

    func dismissThreadSuggestion() {
        guard let reply = replyTo else { return }
        dismissedSuggestions.insert(reply.rootID)
    }

    /// Move a long reply chain into a thread on its root, the text carried over.
    func continueInThread() -> (rootID: String, draft: String)? {
        guard let reply = replyTo else { return nil }
        let draft = input
        replyTo = nil
        setInput("")
        mentionQuery = nil
        Task { await clearDraft() }
        return (reply.rootID, draft)
    }

    enum SendOutcome { case sent, aiUnavailable, failed, edited, editFailed }

    /// Send what the composer holds (or save the edit). Shown at once; the
    /// text, reply and files come back when it fails.
    func send() async -> SendOutcome {
        if let message = editing { return await submitEdit(message) }
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty || !pendingFiles.isEmpty, !uploading else { return .sent }
        if text.hasPrefix("/ask "), !text.dropFirst(5).trimmingCharacters(in: .whitespaces).isEmpty {
            return .aiUnavailable
        }
        let files = pendingFiles
        let reply = replyTo
        let mention = replyMention
        setInput("")
        mentionQuery = nil
        replyTo = nil
        pendingFiles = []
        Task { await clearDraft() }
        room?.sent()

        let tempID = "pending-\(UUID().uuidString)"
        let ownLast = messages.last { $0.authorID == selfID && !$0.pending }
        let optimistic = ChatMessage(
            id: tempID,
            channelID: channelID,
            authorID: selfID,
            authorName: ChatLogic.optimisticAuthorName(userID: selfID, names: names, fallbacks: [selfName, ownLast?.authorName]),
            authorAvatar: ownLast?.authorAvatar,
            authorType: "user",
            content: text,
            type: "text",
            parentID: nil,
            threadReplyCount: 0,
            editedAt: nil,
            isPinned: false,
            hasAttachments: !files.isEmpty,
            attachments: [],
            reactions: [:],
            replyTo: reply.map { ref in
                var next = ref
                next.depth = ref.depth + 1
                return next
            },
            visuals: [],
            createdAt: WeldDate.timestampString(Date()),
            pending: true
        )
        pendingSends[tempID] = .some(nil)
        messages.append(optimistic)
        do {
            var attachments: [ChatAttachment] = []
            if !files.isEmpty {
                uploading = true
                defer { uploading = false }
                for file in files {
                    if let uploaded = try? await ChatUpload.upload(file, channelID: channelID, env: env) {
                        attachments.append(uploaded)
                    }
                }
                if attachments.isEmpty { throw APIError(status: 0, code: nil) }
            }
            let id = try await store.send(
                channelID: channelID,
                body: text,
                replyToID: reply?.messageID,
                replyMention: reply == nil ? nil : mention,
                attachments: attachments
            )
            pendingSends[tempID] = .some(id)
            await loadMessages()
            // Posting in a record chat follows it.
            if channel?.isRecord == true, following == false { await loadChannel() }
            return .sent
        } catch {
            pendingSends[tempID] = nil
            messages.removeAll { $0.id == tempID }
            if input.isEmpty { setInput(text) }
            if replyTo == nil { replyTo = reply }
            if pendingFiles.isEmpty { pendingFiles = files }
            return .failed
        }
    }

    private func submitEdit(_ message: ChatMessage) async -> SendOutcome {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return .edited }
        messages = messages.map { item in
            guard item.id == message.id else { return item }
            var next = item
            next.content = text
            next.editedAt = WeldDate.timestampString(Date())
            return next
        }
        editing = nil
        setInput(draftBeforeEdit)
        draftBeforeEdit = ""
        do {
            try await store.editMessage(message.id, content: text)
            await loadMessages()
            return .edited
        } catch {
            await loadMessages()
            return .editFailed
        }
    }

    enum VoiceOutcome { case sent, tooShort, failed }

    func sendVoice() async -> VoiceOutcome {
        guard recorder.duration >= ChatLogic.minVoiceMessageSeconds else {
            recorder.cancel()
            return .tooShort
        }
        sendingVoiceDuration = recorder.duration
        defer { sendingVoiceDuration = nil }
        guard let file = recorder.stop() else { return .failed }
        do {
            let uploaded = try await ChatUpload.upload(file, channelID: channelID, env: env)
            _ = try await store.send(channelID: channelID, body: "", attachments: [uploaded])
            room?.sent()
            await loadMessages()
            return .sent
        } catch {
            return .failed
        }
    }

    // MARK: Message actions

    /// Shown at once, then the server's version.
    func toggleReaction(_ message: ChatMessage, emoji: String) async -> Bool {
        let has = message.reactions[emoji]?.contains(selfID) ?? false
        messages = messages.map { item in
            guard item.id == message.id else { return item }
            var next = item
            next.reactions = ChatLogic.withReaction(item.reactions, emoji: emoji, userID: selfID, add: !has)
            return next
        }
        var ok = true
        do {
            try await store.react(message.id, emoji: emoji, add: !has)
        } catch {
            ok = false
        }
        await loadMessages()
        return ok
    }

    func pin(_ message: ChatMessage, duration: PinDuration, notify: Bool) async -> Bool {
        localPins.insert(message.id)
        setPinned(message.id, true)
        do {
            try await store.pin(message.id, expiresAt: duration.expiresAt(), notify: notify)
            await loadMessages()
            return true
        } catch {
            localPins.remove(message.id)
            await loadMessages()
            return false
        }
    }

    func unpin(_ message: ChatMessage) async {
        localPins.remove(message.id)
        setPinned(message.id, false)
        try? await store.unpin(message.id)
        await loadMessages()
    }

    private func setPinned(_ id: String, _ pinned: Bool) {
        messages = messages.map { item in
            guard item.id == id else { return item }
            var next = item
            next.isPinned = pinned
            return next
        }
    }

    func delete(_ message: ChatMessage) async -> Bool {
        messages.removeAll { $0.id == message.id }
        do {
            try await store.deleteMessage(message.id)
            await loadMessages()
            return true
        } catch {
            await loadMessages()
            return false
        }
    }

    func unarchive() async -> Bool {
        do {
            try await store.setArchived(channelID, archived: false)
            return true
        } catch {
            return false
        }
    }

    // MARK: Record chats

    func toggleFollow() async -> Bool {
        guard let isFollowing = following, let loaded = channel, let type = loaded.entityType, let id = loaded.entityID else { return true }
        let next = !isFollowing
        followOverride = next
        muteOverride = next && recordMuted
        store.forgetMembership(channelID)
        do {
            try await store.setFollowing(entityType: type, entityID: id, following: next)
            await loadChannel()
            return true
        } catch {
            followOverride = nil
            muteOverride = nil
            return false
        }
    }

    func toggleRecordMute() async -> Bool {
        guard following == true else { return true }
        let next = !recordMuted
        muteOverride = next
        do {
            try await store.updateMembership(channelID: channelID, isMuted: next)
            return true
        } catch {
            muteOverride = !next
            return false
        }
    }
}
