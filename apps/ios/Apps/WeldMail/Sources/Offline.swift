import Foundation
import Network
import Observation

/// A message's flags that can change while offline.
struct FlagPatch: Codable, Equatable {
    var isRead: Bool?
    var isStarred: Bool?
    var isSpam: Bool?
    var isImportant: Bool?

    func merged(with newer: FlagPatch) -> FlagPatch {
        FlagPatch(
            isRead: newer.isRead ?? isRead,
            isStarred: newer.isStarred ?? isStarred,
            isSpam: newer.isSpam ?? isSpam,
            isImportant: newer.isImportant ?? isImportant
        )
    }

    func applied(to message: MailMessage) -> MailMessage {
        var copy = message
        copy.isRead = isRead ?? message.isRead
        copy.isStarred = isStarred ?? message.isStarred
        copy.isImportant = isImportant ?? message.isImportant
        return copy
    }
}

/// A change made on the phone that waits for the server: it shows at once
/// and survives restarts and being offline (the Expo app's
/// `lib/offline/outbox.ts`, the Android app's `Outbox.kt`).
struct OutboxOp: Codable, Equatable, Identifiable {
    enum Kind: String, Codable {
        case update, delete, archive, snooze, unsnooze, send
    }

    let id: String
    let kind: Kind
    /// The message it changes; nil for a send.
    var messageID: String?
    var accountID: String?
    var patch: FlagPatch?
    var until: String?
    /// A composed message; its idempotency key makes a replay safe.
    var payload: SendPayload?
    var attempts = 0
    var createdAt: Int64

    static func update(_ id: String, message: String, patch: FlagPatch, now: Int64) -> OutboxOp {
        OutboxOp(id: id, kind: .update, messageID: message, patch: patch, createdAt: now)
    }

    static func delete(_ id: String, message: String, now: Int64) -> OutboxOp {
        OutboxOp(id: id, kind: .delete, messageID: message, createdAt: now)
    }

    static func archive(_ id: String, message: String, now: Int64) -> OutboxOp {
        OutboxOp(id: id, kind: .archive, messageID: message, createdAt: now)
    }

    static func snooze(_ id: String, message: String, account: String, until: String, now: Int64) -> OutboxOp {
        OutboxOp(id: id, kind: .snooze, messageID: message, accountID: account, until: until, createdAt: now)
    }

    static func unsnooze(_ id: String, message: String, account: String, now: Int64) -> OutboxOp {
        OutboxOp(id: id, kind: .unsnooze, messageID: message, accountID: account, createdAt: now)
    }

    static func send(_ id: String, account: String, payload: SendPayload, now: Int64) -> OutboxOp {
        OutboxOp(id: id, kind: .send, accountID: account, payload: payload, createdAt: now)
    }

    func retried() -> OutboxOp {
        var copy = self
        copy.attempts += 1
        return copy
    }
}

/// What a flush did.
struct FlushResult: Equatable {
    let remaining: Int
    let succeeded: Int
    let dropped: Int

    /// Something changed on the server (or was refused): reload to its state.
    var shouldReconcile: Bool { succeeded > 0 || dropped > 0 }
}

/// How a replayed op failed.
enum FailureKind {
    /// Offline: keep it and everything after it, and stop.
    case network
    /// 5xx, rate limited, a session not ready: keep it, one attempt spent.
    case transient
    /// Refused: drop it (the server wins).
    case rejected
}

/// The queue's rules, without storage or network.
enum OutboxRules {
    /// An op that failed this many flushes is dropped so it can't wedge the queue.
    static let maxAttempts = 6

    /// Folds a new op into the queue: flag changes merge, a delete supersedes
    /// everything else for its message, an archive is queued once, the latest
    /// snooze or unsnooze wins, sends never merge.
    static func collapse(_ ops: [OutboxOp], _ incoming: OutboxOp) -> [OutboxOp] {
        if incoming.kind == .send { return ops + [incoming] }
        let target = incoming.messageID
        let same = { (op: OutboxOp) in op.kind != .send && op.messageID == target }
        if incoming.kind == .delete { return ops.filter { !same($0) } + [incoming] }
        if ops.contains(where: { same($0) && $0.kind == .delete }) { return ops }
        switch incoming.kind {
        case .update:
            guard let index = ops.firstIndex(where: { same($0) && $0.kind == .update }) else { return ops + [incoming] }
            var next = ops
            var merged = ops[index]
            merged.patch = (merged.patch ?? FlagPatch()).merged(with: incoming.patch ?? FlagPatch())
            merged.attempts = 0
            next[index] = merged
            return next
        case .archive:
            return ops.contains(where: { same($0) && $0.kind == .archive }) ? ops : ops + [incoming]
        case .snooze, .unsnooze:
            return ops.filter { !(same($0) && ($0.kind == .snooze || $0.kind == .unsnooze)) } + [incoming]
        case .delete, .send:
            return ops + [incoming]
        }
    }

    /// The queue laid over a list: flags patched, and messages a pending op
    /// moved out of this folder hidden (deleted anywhere, archived outside
    /// Archive, snoozed outside Snoozed).
    static func overlay(_ messages: [MailMessage], _ ops: [OutboxOp], label: String?) -> [MailMessage] {
        if ops.isEmpty { return messages }
        var byMessage: [String: [OutboxOp]] = [:]
        for op in ops where op.kind != .send {
            if let id = op.messageID { byMessage[id, default: []].append(op) }
        }
        let folder = (label ?? "").uppercased()
        return messages.compactMap { message in
            guard let pending = byMessage[message.id] else { return message }
            if hidden(pending, folder: folder) { return nil }
            return pending.filter { $0.kind == .update }.reduce(message) { acc, op in
                (op.patch ?? FlagPatch()).applied(to: acc)
            }
        }
    }

    private static func hidden(_ ops: [OutboxOp], folder: String) -> Bool {
        if ops.contains(where: { $0.kind == .delete }) { return true }
        if ops.contains(where: { $0.kind == .archive }) && folder != "ARCHIVE" { return true }
        if ops.contains(where: { $0.kind == .snooze }) && folder != "SNOOZED" { return true }
        return ops.contains(where: { $0.kind == .unsnooze }) && folder == "SNOOZED"
    }

    struct Replay {
        let handled: Set<String>
        let retried: [String: OutboxOp]
        let succeeded: Int
        let dropped: Int

        /// The pass merged into the queue as it is now: ops enqueued meanwhile
        /// stay; an op whose content changed meanwhile (a merged update) runs again.
        func applied(to current: [OutboxOp], before: [OutboxOp]) -> [OutboxOp] {
            var snapshot: [String: OutboxOp] = [:]
            for op in before { snapshot[op.id] = op }
            return current.compactMap { op in
                let unchanged = snapshot[op.id] == op
                if unchanged && handled.contains(op.id) { return nil }
                if unchanged, let retry = retried[op.id] { return retry }
                return op
            }
        }
    }

    /// One pass over the queue: an op that worked is removed; offline stops
    /// the pass and keeps the rest; a transient failure spends an attempt; a
    /// refusal drops the op.
    @MainActor
    static func replay(
        _ ops: [OutboxOp],
        run: (OutboxOp) async throws -> Void,
        classify: (Error) -> FailureKind
    ) async -> Replay {
        var handled = Set<String>()
        var retried: [String: OutboxOp] = [:]
        var succeeded = 0
        var dropped = 0
        for op in ops {
            if op.attempts >= maxAttempts {
                handled.insert(op.id)
                dropped += 1
                continue
            }
            do {
                try await run(op)
                handled.insert(op.id)
                succeeded += 1
            } catch {
                var stop = false
                switch classify(error) {
                case .network:
                    stop = true
                case .transient:
                    retried[op.id] = op.retried()
                case .rejected:
                    handled.insert(op.id)
                    dropped += 1
                }
                if stop { break }
            }
        }
        return Replay(handled: handled, retried: retried, succeeded: succeeded, dropped: dropped)
    }
}

/// The queue of one workspace, kept in a file on the phone. Everything runs
/// on the main actor; the network calls of a flush suspend outside it.
@MainActor
final class OutboxStore {
    private let directory: URL
    private var flushing = false
    private var again = false

    init(directory: URL) {
        self.directory = directory
    }

    private func file(_ workspace: String) -> URL {
        directory.appendingPathComponent("\(safeName(workspace)).json")
    }

    func load(_ workspace: String) -> [OutboxOp] {
        guard let data = try? Data(contentsOf: file(workspace)) else { return [] }
        return (try? JSONDecoder().decode([OutboxOp].self, from: data)) ?? []
    }

    @discardableResult
    func enqueue(_ workspace: String, _ op: OutboxOp) -> [OutboxOp] {
        let next = OutboxRules.collapse(load(workspace), op)
        write(workspace, next)
        return next
    }

    /// Replays the queue. A call while a flush runs returns nil at once but
    /// makes the running flush take one more pass, so the op that triggered it
    /// goes out now rather than at the next trigger.
    func flush(
        _ workspace: String,
        run: (OutboxOp) async throws -> Void,
        classify: (Error) -> FailureKind
    ) async -> FlushResult? {
        if flushing {
            again = true
            return nil
        }
        flushing = true
        defer { flushing = false }
        var total: FlushResult?
        repeat {
            again = false
            let before = load(workspace)
            if before.isEmpty {
                total = total ?? FlushResult(remaining: 0, succeeded: 0, dropped: 0)
                break
            }
            let pass = await OutboxRules.replay(before, run: run, classify: classify)
            let next = pass.applied(to: load(workspace), before: before)
            write(workspace, next)
            let result = FlushResult(remaining: next.count, succeeded: pass.succeeded, dropped: pass.dropped)
            if let previous = total {
                total = FlushResult(remaining: result.remaining, succeeded: previous.succeeded + result.succeeded, dropped: previous.dropped + result.dropped)
            } else {
                total = result
            }
        } while again
        return total
    }

    /// Forget every queue: at sign-out nobody else replays this person's changes.
    func clearAll() {
        try? FileManager.default.removeItem(at: directory)
    }

    private func write(_ workspace: String, _ ops: [OutboxOp]) {
        let target = file(workspace)
        if ops.isEmpty {
            try? FileManager.default.removeItem(at: target)
            return
        }
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let data = try? JSONEncoder().encode(ops) else { return }
        try? data.write(to: target, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}

/// A file name from a workspace id or a cache key.
func safeName(_ name: String) -> String {
    name.replacingOccurrences(of: "[^A-Za-z0-9_.-]", with: "_", options: .regularExpression)
}

/// The last mail the phone saw, per workspace, so the app reads offline and
/// opens with something on screen (the Expo app's `lib/offline/cache.ts`):
/// each list (mailbox and folder), the mailboxes, the labels, and every
/// message and conversation once opened. Entries carry a version; a different
/// one reads as a miss, so a changed shape never reaches the screens.
struct MailCache: Sendable {
    let directory: URL

    /// Bump to drop every entry after a change in what is stored.
    private static let version = 1
    /// A list keeps its first pages; older ones load from the server.
    static let maxList = 200

    private struct Envelope<T: Codable>: Codable {
        let v: Int
        let t: Double
        let data: T
    }

    private func file(_ workspace: String, _ key: String) -> URL {
        directory.appendingPathComponent(safeName(workspace), isDirectory: true).appendingPathComponent("\(safeName(key)).json")
    }

    private func read<T: Codable & Sendable>(_ workspace: String, _ key: String, as type: T.Type) async -> T? {
        let url = file(workspace, key)
        return await Task.detached(priority: .userInitiated) { () -> T? in
            guard let data = try? Data(contentsOf: url),
                  let envelope = try? JSONDecoder().decode(Envelope<T>.self, from: data),
                  envelope.v == MailCache.version
            else { return nil }
            return envelope.data
        }.value
    }

    private func write<T: Codable & Sendable>(_ workspace: String, _ key: String, _ value: T) async {
        let url = file(workspace, key)
        await Task.detached(priority: .utility) {
            try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            let envelope = Envelope(v: MailCache.version, t: Date().timeIntervalSince1970, data: value)
            guard let data = try? JSONEncoder().encode(envelope) else { return }
            try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        }.value
    }

    func messages(_ workspace: String, scope: String, label: String) async -> [MailMessage]? {
        await read(workspace, "messages.\(scope).\(label)", as: [MailMessage].self)
    }

    func putMessages(_ workspace: String, scope: String, label: String, _ list: [MailMessage]) async {
        await write(workspace, "messages.\(scope).\(label)", Array(list.prefix(Self.maxList)))
    }

    func accounts(_ workspace: String) async -> [MailAccount]? {
        await read(workspace, "accounts", as: [MailAccount].self)
    }

    func putAccounts(_ workspace: String, _ list: [MailAccount]) async {
        await write(workspace, "accounts", list)
    }

    func labels(_ workspace: String, scope: String) async -> LabelState? {
        await read(workspace, "labels.\(scope)", as: LabelState.self)
    }

    func putLabels(_ workspace: String, scope: String, _ state: LabelState) async {
        await write(workspace, "labels.\(scope)", state)
    }

    func message(_ workspace: String, id: String) async -> MailMessage? {
        await read(workspace, "message.\(id)", as: MailMessage.self)
    }

    func putMessage(_ workspace: String, _ message: MailMessage) async {
        await write(workspace, "message.\(message.id)", message)
    }

    func thread(_ workspace: String, id: String) async -> [MailMessage]? {
        await read(workspace, "thread.\(id)", as: [MailMessage].self)
    }

    func putThread(_ workspace: String, id: String, _ list: [MailMessage]) async {
        await write(workspace, "thread.\(id)", list)
    }

    /// Everything, for every workspace: at sign-out nothing stays behind.
    func clearAll() {
        try? FileManager.default.removeItem(at: directory)
    }
}

/// Whether the phone has a working connection, as it changes.
@MainActor
@Observable
final class Connectivity {
    private(set) var online = true
    /// Called when the phone comes back online.
    @ObservationIgnored var onOnline: (() -> Void)?
    @ObservationIgnored private let monitor = NWPathMonitor()

    init() {
        monitor.pathUpdateHandler = { [weak self] path in
            let online = path.status == .satisfied
            Task { @MainActor in self?.update(online) }
        }
        monitor.start(queue: DispatchQueue(label: "weldmail.connectivity"))
    }

    private func update(_ value: Bool) {
        let cameBack = value && !online
        online = value
        if cameBack { onOnline?() }
    }
}
