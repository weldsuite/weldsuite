import Foundation
import Observation
import WeldCore

/// Which mailbox the inbox shows: every one at once, or one.
enum Mailbox: Hashable {
    case unified
    case account(String)

    /// The cache's key for it.
    var key: String {
        switch self {
        case .unified: return "unified"
        case let .account(id): return id
        }
    }

    var accountID: String? {
        if case let .account(id) = self { return id }
        return nil
    }
}

/// The inbox as the screen shows it.
struct InboxState: Equatable {
    var messages: [MailMessage] = []
    /// Where the next page starts; nil once everything is loaded.
    var cursor: String?
    /// False while the list is an offline-cache paint whose place in the mailbox is unknown.
    var cursorKnown = false
    var loading = true
    var refreshing = false
    var loadingMore = false
    var error: APIError?
}

/// The mailboxes, the folder on screen, its messages and every change made to
/// them, for the active workspace (the Expo app's MailContext, inbox and
/// `useMailOutbox` in one; the Android app's `MailStore.kt`): the lists paint
/// from the offline cache first and are then reloaded; a change shows at
/// once, waits in the outbox, and goes to the server now or when the phone is
/// back online.
@MainActor
@Observable
final class MailStore {
    let repository: MailRepository
    let connectivity: Connectivity

    private(set) var accounts: [MailAccount] = []
    private(set) var accountsLoaded = false
    private(set) var mailbox: Mailbox = .unified
    /// The folder or label on screen: a system slug (`INBOX`) or a label's slug.
    private(set) var label = SystemLabel.inbox.slug
    private(set) var labels = LabelState()
    private(set) var inbox = InboxState()
    /// Changes waiting in the outbox.
    private(set) var pending = 0
    /// The message a notification opened, until the inbox lists it.
    private(set) var expected: String?

    /// The messages in the order the screen shows them, for "archive and open the next".
    @ObservationIgnored var visibleIDs: [String] = []

    @ObservationIgnored let cache: MailCache
    @ObservationIgnored private let outbox: OutboxStore
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private var workspace: String?
    /// Each list on screen this session, so going back to one paints at once.
    @ObservationIgnored private var snapshots: [String: InboxState] = [:]
    @ObservationIgnored private var loadMoreTask: Task<Void, Never>?
    @ObservationIgnored private var listGeneration = 0
    @ObservationIgnored private var subscriptionCache: [String: (at: Date, list: [MailSubscription])] = [:]
    @ObservationIgnored private var lastDraft: DraftContent?
    @ObservationIgnored private var lastDraftID: String?
    @ObservationIgnored private var draftTask: Task<Void, Never>?

    private static let defaultsSuite = "weldmail.store"

    init(env: AppEnvironment) {
        repository = MailRepository(env: env)
        connectivity = Connectivity()
        let files = FileManager.default
        let support = files.urls(for: .applicationSupportDirectory, in: .userDomainMask).first ?? files.temporaryDirectory
        let caches = files.urls(for: .cachesDirectory, in: .userDomainMask).first ?? files.temporaryDirectory
        cache = MailCache(directory: caches.appendingPathComponent("weldmail-cache", isDirectory: true))
        outbox = OutboxStore(directory: support.appendingPathComponent("weldmail-outbox", isDirectory: true))
        defaults = UserDefaults(suiteName: Self.defaultsSuite) ?? .standard
        // Back online: what waited in the outbox goes out.
        connectivity.onOnline = { [weak self] in
            Task { await self?.flush() }
        }
    }

    private var scopeKey: String { "\(mailbox.key)::\(label)" }

    /// The mailboxes mail can be sent from: those in the active workspace.
    var sendableAccounts: [MailAccount] { accounts.filter(\.inActiveWorkspace) }

    /// The person's own addresses, left out of a reply-all.
    var ownAddresses: [String] { accounts.map(\.email) }

    /// The selected mailbox, or nil in the unified inbox.
    var selectedAccount: MailAccount? {
        guard let id = mailbox.accountID else { return nil }
        return accounts.first { $0.id == id }
    }

    // MARK: Workspace

    /// The active workspace changed (or the app opened in one): start over in it.
    func use(workspace id: String) {
        guard workspace != id else { return }
        workspace = id
        snapshots = [:]
        accounts = []
        accountsLoaded = false
        labels = LabelState()
        label = SystemLabel.inbox.slug
        let saved = defaults.string(forKey: selectionKey(id))
        mailbox = saved == nil || saved == "unified" ? .unified : .account(saved ?? "")
        inbox = InboxState()
        Task {
            refreshPending()
            await loadAccounts()
            await reloadList()
            await loadLabels()
            await flush()
            await migrateLocalPins()
        }
    }

    /// Sign-out: nothing of this person's mail stays on the phone.
    func clear() {
        workspace = nil
        snapshots = [:]
        accounts = []
        inbox = InboxState()
        labels = LabelState()
        pending = 0
        subscriptionCache = [:]
        lastDraft = nil
        lastDraftID = nil
        defaults.removePersistentDomain(forName: Self.defaultsSuite)
        cache.clearAll()
        outbox.clearAll()
    }

    private func selectionKey(_ workspace: String) -> String { "selection.\(workspace)" }

    /// A mailbox of another workspace was picked: it opens once the app is in that workspace.
    func preselect(workspace: String, accountID: String) {
        defaults.set(accountID, forKey: selectionKey(workspace))
    }

    // MARK: Mailboxes

    func loadAccounts() async {
        guard let ws = workspace else { return }
        do {
            let own = try await repository.accounts()
            let others = await repository.otherWorkspaceAccounts(activeWorkspace: ws)
            guard workspace == ws else { return }
            let all = own + others.filter { other in !own.contains { $0.id == other.id } }
            accounts = all
            await cache.putAccounts(ws, all)
        } catch {
            guard workspace == ws else { return }
            if let cached = await cache.accounts(ws), !cached.isEmpty { accounts = cached }
        }
        guard workspace == ws else { return }
        accountsLoaded = true
        // A saved mailbox that is gone (or in another workspace) falls back to all inboxes.
        if let selected = mailbox.accountID, !sendableAccounts.contains(where: { $0.id == selected }), !accounts.isEmpty {
            select(mailbox: .unified)
        }
    }

    func select(mailbox next: Mailbox) {
        guard let ws = workspace else { return }
        defaults.set(next.accountID ?? "unified", forKey: selectionKey(ws))
        if mailbox == next && label == SystemLabel.inbox.slug { return }
        mailbox = next
        label = SystemLabel.inbox.slug
        labels = LabelState()
        Task {
            await reloadList()
            await loadLabels()
        }
    }

    /// Follows a notification into the mailbox the email arrived in; the
    /// unified inbox already lists it and stays.
    func follow(accountID: String?) {
        guard let accountID, mailbox != .unified else {
            if label != SystemLabel.inbox.slug { select(label: SystemLabel.inbox.slug) }
            return
        }
        if sendableAccounts.contains(where: { $0.id == accountID }) {
            select(mailbox: .account(accountID))
        } else {
            select(label: SystemLabel.inbox.slug)
        }
    }

    func select(label slug: String) {
        guard label != slug else { return }
        label = slug
        Task { await reloadList() }
    }

    func loadLabels() async {
        guard let ws = workspace else { return }
        let current = mailbox
        do {
            let rows = try await repository.labels(accountID: current.accountID)
            var state = MailLogic.processLabels(rows)
            if let drafts = try? await repository.stats(accountID: current.accountID).drafts {
                state.systemCounts[SystemLabel.drafts.slug] = drafts
            }
            guard workspace == ws, mailbox == current else { return }
            labels = state
            await cache.putLabels(ws, scope: current.key, state)
        } catch {
            guard workspace == ws, mailbox == current else { return }
            if let cached = await cache.labels(ws, scope: current.key) { labels = cached }
        }
    }

    func createLabel(accountID: String, name: String, color: String?) async throws {
        try await repository.createLabel(accountID: accountID, name: name, color: color)
        await loadLabels()
    }

    // MARK: The list

    /// Another list on screen: this session's snapshot or the cache at once, then the server.
    private func reloadList() async {
        guard let ws = workspace else { return }
        let key = scopeKey
        listGeneration += 1
        let generation = listGeneration
        if var snapshot = snapshots[key] {
            snapshot.loading = false
            snapshot.refreshing = false
            snapshot.loadingMore = false
            inbox = snapshot
        } else {
            inbox = InboxState(loading: true)
            if let cached = await cache.messages(ws, scope: mailbox.key, label: label), !cached.isEmpty, generation == listGeneration {
                inbox = InboxState(messages: overlay(cached), loading: false)
            }
        }
        await refresh()
    }

    /// Reloads the first page and folds it onto what is on screen.
    func refresh(pullToRefresh: Bool = false) async {
        guard let ws = workspace else { return }
        let key = scopeKey
        let generation = listGeneration
        let current = mailbox
        let folder = label
        if pullToRefresh { inbox.refreshing = true }
        do {
            let page = try await repository.messages(accountID: current.accountID, label: folder)
            guard generation == listGeneration, scopeKey == key else { return }
            let fresh = MailLogic.withThreadCounts(page.messages)
            let shown = inbox
            let merged = MailLogic.mergeFirstPage(
                previous: shown.messages,
                firstPage: overlay(fresh),
                firstPageCursor: page.cursor,
                previousCursor: shown.cursor,
                previousKnown: shown.cursorKnown
            )
            setList(key, InboxState(messages: MailLogic.withThreadCounts(merged.messages), cursor: merged.cursor, cursorKnown: true, loading: false))
            let unread = fresh.filter { !$0.isRead }.count
            if SystemLabel.of(folder) != nil {
                labels.systemCounts[folder] = unread
            } else if let index = labels.custom.firstIndex(where: { $0.slug == folder }) {
                labels.custom[index].count = unread
            }
            await cache.putMessages(ws, scope: current.key, label: folder, fresh)
        } catch {
            guard generation == listGeneration, scopeKey == key else { return }
            // Offline or refused: keep what is on screen.
            inbox.loading = false
            inbox.refreshing = false
            inbox.error = APIError.from(error)
        }
    }

    /// The next page, when the list nears its end.
    func loadMore() {
        guard let cursor = inbox.cursor, !inbox.loadingMore, loadMoreTask == nil else { return }
        let key = scopeKey
        let generation = listGeneration
        let current = mailbox
        let folder = label
        inbox.loadingMore = true
        loadMoreTask = Task {
            defer { loadMoreTask = nil }
            do {
                let page = try await repository.messages(accountID: current.accountID, label: folder, cursor: cursor)
                guard generation == listGeneration, scopeKey == key, inbox.cursor == cursor else { return }
                var next = inbox
                next.messages = MailLogic.withThreadCounts(MailLogic.appendPage(inbox.messages, overlay(page.messages)))
                next.cursor = page.cursor
                next.cursorKnown = true
                next.loadingMore = false
                setList(key, next)
            } catch {
                // The cursor stays: scrolling to the end again retries the page.
                inbox.loadingMore = false
            }
        }
    }

    private func setList(_ key: String, _ state: InboxState) {
        inbox = state
        snapshots[key] = state
    }

    private func changeList(_ change: ([MailMessage]) -> [MailMessage]) {
        var next = inbox
        next.messages = change(inbox.messages)
        setList(scopeKey, next)
    }

    /// A notification opened an email the list may not have yet (the push can
    /// beat the list): reload a few times until it shows up.
    func expect(_ emailID: String?) {
        expected = emailID
        guard let emailID else { return }
        Task {
            for wait in [0, 400, 1_000, 2_000, 4_000] {
                try? await Task.sleep(for: .milliseconds(wait))
                if expected != emailID { return }
                await refresh()
                if inbox.messages.contains(where: { $0.id == emailID }) { break }
            }
            if expected == emailID { expected = nil }
        }
    }

    // MARK: Changes

    private func overlay(_ list: [MailMessage]) -> [MailMessage] {
        guard let ws = workspace else { return list }
        return OutboxRules.overlay(list, outbox.load(ws), label: label)
    }

    private func newOpID() -> String { "op_\(Self.nowMillis())_\(UUID().uuidString.prefix(8))" }

    private static func nowMillis() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

    private func enqueue(_ op: OutboxOp) {
        guard let ws = workspace else { return }
        pending = outbox.enqueue(ws, op).count
        Task { await flush() }
    }

    private func patchCached(_ id: String, _ patch: FlagPatch) async {
        guard let ws = workspace, let cached = await cache.message(ws, id: id) else { return }
        await cache.putMessage(ws, patch.applied(to: cached))
    }

    func setRead(_ id: String, _ read: Bool) {
        changeList { list in list.map { message in
            var copy = message
            if message.id == id { copy.isRead = read }
            return copy
        } }
        let patch = FlagPatch(isRead: read)
        enqueue(.update(newOpID(), message: id, patch: patch, now: Self.nowMillis()))
        Task { await patchCached(id, patch) }
    }

    func setStarred(_ id: String, _ starred: Bool) {
        changeList { list in list.map { message in
            var copy = message
            if message.id == id { copy.isStarred = starred }
            return copy
        } }
        let patch = FlagPatch(isStarred: starred)
        enqueue(.update(newOpID(), message: id, patch: patch, now: Self.nowMillis()))
        Task { await patchCached(id, patch) }
    }

    func markSpam(_ id: String) {
        changeList { $0.filter { $0.id != id } }
        enqueue(.update(newOpID(), message: id, patch: FlagPatch(isSpam: true), now: Self.nowMillis()))
    }

    func archive(_ id: String) {
        changeList { $0.filter { $0.id != id } }
        enqueue(.archive(newOpID(), message: id, now: Self.nowMillis()))
    }

    func delete(_ id: String) {
        changeList { $0.filter { $0.id != id } }
        enqueue(.delete(newOpID(), message: id, now: Self.nowMillis()))
    }

    func snooze(_ message: MailMessage, until: String) {
        changeList { $0.filter { $0.id != message.id } }
        enqueue(.snooze(newOpID(), message: message.id, account: message.accountID, until: until, now: Self.nowMillis()))
    }

    /// Undo a snooze: back at the top of the list.
    func unsnooze(_ message: MailMessage) {
        changeList { [message] + $0.filter { $0.id != message.id } }
        enqueue(.unsnooze(newOpID(), message: message.id, account: message.accountID, now: Self.nowMillis()))
    }

    /// A labels change on the message screen, reflected in the list.
    func labelsChanged(_ id: String, _ labels: [String]) {
        changeList { list in list.map { message in
            var copy = message
            if message.id == id { copy.labels = labels }
            return copy
        } }
    }

    /// Pins or unpins a message with the server's `PINNED` label, as the
    /// platform does, so the pin shows on the web and on every device. The
    /// list and the cache change at once; a refused change puts them back and
    /// throws. Returns the message's labels as the server has them.
    @discardableResult
    func setPinned(_ id: String, labels: [String], on: Bool) async throws -> [String] {
        await applyLabels(id, MailLogic.withPinned(labels, on: on))
        do {
            let pin = [MailLogic.pinnedLabel]
            let next = try await repository.changeLabels(id, add: on ? pin : [], remove: on ? [] : pin, current: labels)
            await applyLabels(id, next)
            return next
        } catch {
            await applyLabels(id, labels)
            throw error
        }
    }

    private func applyLabels(_ id: String, _ labels: [String]) async {
        labelsChanged(id, labels)
        guard let ws = workspace, var cached = await cache.message(ws, id: id) else { return }
        cached.labels = labels
        await cache.putMessage(ws, cached)
    }

    /// Where the phone-only pins were kept, before pins moved to the server.
    private static let localPinsKey = "pinned"

    /// Pins used to be kept on the phone only. Those are pinned on the server
    /// once; a message that is gone is let go, one that fails for another
    /// reason (offline) is tried again next time.
    private func migrateLocalPins() async {
        guard let ids = defaults.stringArray(forKey: Self.localPinsKey) else { return }
        var left: [String] = []
        for id in ids {
            do {
                _ = try await repository.changeLabels(id, add: [MailLogic.pinnedLabel], remove: [], current: [])
            } catch {
                if APIError.from(error).status != 404 { left.append(id) }
            }
        }
        if left.isEmpty {
            defaults.removeObject(forKey: Self.localPinsKey)
        } else {
            defaults.set(left, forKey: Self.localPinsKey)
        }
        if left.count < ids.count { await refresh() }
    }

    /// A send made offline: it goes out when the phone is back online, once (its idempotency key).
    func queueSend(accountID: String, payload: SendPayload) {
        enqueue(.send(newOpID(), account: accountID, payload: payload, now: Self.nowMillis()))
    }

    private func refreshPending() {
        guard let ws = workspace else { return }
        pending = outbox.load(ws).count
    }

    /// Sends what waits in the outbox, and reloads when anything changed on the server.
    func flush() async {
        guard let ws = workspace else { return }
        let result = await outbox.flush(ws, run: { op in try await self.run(op) }, classify: Self.classify)
        guard let result, workspace == ws else { return }
        pending = result.remaining
        if result.shouldReconcile { await refresh() }
    }

    private func run(_ op: OutboxOp) async throws {
        switch op.kind {
        case .update:
            guard let id = op.messageID else { return }
            try await repository.update(id, patch: op.patch ?? FlagPatch())
        case .delete:
            guard let id = op.messageID else { return }
            try await repository.delete(id)
        case .archive:
            guard let id = op.messageID else { return }
            try await repository.archive(id)
        case .snooze:
            guard let id = op.messageID, let account = op.accountID, let until = op.until else { return }
            try await repository.snooze(accountID: account, id: id, until: until)
        case .unsnooze:
            guard let id = op.messageID, let account = op.accountID else { return }
            try await repository.unsnooze(accountID: account, id: id)
        case .send:
            guard let account = op.accountID, let payload = op.payload else { return }
            try await repository.send(accountID: account, payload: payload)
        }
    }

    nonisolated static func classify(_ error: Error) -> FailureKind {
        if MailRepository.isNetwork(error) { return .network }
        guard let status = (error as? APIError)?.status ?? (error as? SendFailure)?.status else { return .rejected }
        if status >= 500 || status == 429 || status == 408 || status == 401 { return .transient }
        return .rejected
    }

    // MARK: One message

    func cachedMessage(_ id: String) async -> MailMessage? {
        guard let ws = workspace else { return nil }
        return await cache.message(ws, id: id)
    }

    func cachedThread(_ id: String) async -> [MailMessage]? {
        guard let ws = workspace else { return nil }
        return await cache.thread(ws, id: id)
    }

    func remember(_ message: MailMessage) async {
        guard let ws = workspace else { return }
        await cache.putMessage(ws, message)
    }

    func rememberThread(_ id: String, _ list: [MailMessage]) async {
        guard let ws = workspace else { return }
        await cache.putThread(ws, id: id, list)
    }

    // MARK: Subscriptions

    /// A mailbox's subscriptions, kept for a minute, so opening emails one
    /// after another doesn't reload the list for every Unsubscribe button.
    func subscriptionsCached(accountID: String) async throws -> [MailSubscription] {
        if let entry = subscriptionCache[accountID], Date().timeIntervalSince(entry.at) < 60 { return entry.list }
        let list = try await repository.subscriptions(accountID: accountID)
        subscriptionCache[accountID] = (Date(), list)
        return list
    }

    /// After an unsubscribe or a scan the list is read again.
    func forgetSubscriptions(accountID: String) {
        subscriptionCache[accountID] = nil
    }

    // MARK: Drafts

    /// What the composer held when it closed.
    struct DraftContent {
        let accountID: String
        let to: [String]
        let cc: [String]
        let bcc: [String]
        let subject: String
        let body: String
        let html: Bool
    }

    /// Keeps a closed composer's content as a draft, in the background.
    func saveDraft(_ content: DraftContent) {
        lastDraft = content
        lastDraftID = nil
        draftTask = Task {
            lastDraftID = try? await repository.createDraft(
                accountID: content.accountID,
                to: content.to,
                cc: content.cc,
                bcc: content.bcc,
                subject: content.subject,
                body: content.body,
                html: content.html
            )
        }
    }

    /// "Discard" on the "Draft saved" bar: waits for the draft if it is still being saved.
    func discardDraft() async {
        await draftTask?.value
        guard let id = lastDraftID else { return }
        try? await repository.deleteDraft(id)
        lastDraftID = nil
    }

    /// "Undo" on the "Draft discarded" bar.
    func restoreDraft() {
        if let lastDraft { saveDraft(lastDraft) }
    }
}
