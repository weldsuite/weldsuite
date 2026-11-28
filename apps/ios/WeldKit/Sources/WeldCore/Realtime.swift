import Foundation
import Observation
import UIKit

/// How a realtime socket is doing.
public enum RealtimeState: Sendable, Equatable {
    case disconnected
    case connecting
    case connected
}

/// A WebSocket to the server's realtime service (`@weldsuite/realtime`): the
/// session token (`?token=`) and the workspace (`?workspace=`, WeldID's
/// membership mode) go in the URL, the server opens with
/// `{"type":"connected"}`, and the socket pings every 25 seconds. It
/// reconnects with backoff (1 s doubling to 30 s) while it's wanted, closes
/// when the app goes to the background and opens again when it comes back.
///
/// Messages are handed over as raw JSON. `RealtimeClient` speaks the
/// workspace hub's protocol on top of it; WeldChat's rooms use it directly.
@MainActor
public final class WeldSocket {
    public private(set) var state: RealtimeState = .disconnected

    private let url: () -> URL?
    private let token: () async -> String?
    private let workspace: () -> String?
    private let onOpen: () -> Void
    private let onMessage: (Data) -> Void
    private let onStateChange: (RealtimeState) -> Void

    private let session = URLSession(configuration: .default)
    private var task: URLSessionWebSocketTask?
    /// Bumped on every connect and close: a late callback of an older socket is ignored.
    private var generation = 0
    private var attempt = 0
    private var wanted = false
    private var inBackground = false
    private var heartbeat: Task<Void, Never>?
    private var retry: Task<Void, Never>?
    nonisolated(unsafe) private var observers: [NSObjectProtocol] = []

    /// - Parameters:
    ///   - url: the socket's URL without the token, nil while there is none.
    ///   - token: the access token; nil (signed out) leaves the socket closed.
    ///   - workspace: the active workspace, sent as `?workspace=`.
    ///   - onOpen: the server said `connected` (also after a reconnect).
    ///   - onMessage: every message, `connected` included, as JSON.
    public init(
        url: @escaping () -> URL?,
        token: @escaping () async -> String?,
        workspace: @escaping () -> String?,
        onOpen: @escaping () -> Void,
        onMessage: @escaping (Data) -> Void,
        onStateChange: @escaping (RealtimeState) -> Void = { _ in }
    ) {
        self.url = url
        self.token = token
        self.workspace = workspace
        self.onOpen = onOpen
        self.onMessage = onMessage
        self.onStateChange = onStateChange
        let center = NotificationCenter.default
        observers = [
            center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.enterBackground() }
            },
            center.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.enterForeground() }
            },
        ]
    }

    deinit {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
    }

    /// Open the socket and keep it open.
    public func start() {
        wanted = true
        if task == nil, retry == nil { connect() }
    }

    /// Close it and stop reconnecting.
    public func stop() {
        wanted = false
        close()
    }

    /// Close and open again at once: after a workspace switch or a new sign-in.
    public func restart() {
        close()
        attempt = 0
        if wanted { connect() }
    }

    /// Send a message as JSON. Dropped while the socket isn't connected.
    public func send(_ message: [String: Any]) {
        guard state == .connected, let task,
              let data = try? JSONSerialization.data(withJSONObject: message),
              let text = String(data: data, encoding: .utf8)
        else { return }
        task.send(.string(text)) { _ in }
    }

    // MARK: - Connection

    private func connect() {
        retry?.cancel()
        retry = nil
        guard wanted, !inBackground else { return }
        generation += 1
        let current = generation
        setState(.connecting)
        Task { [weak self] in
            guard let self else { return }
            let token = await self.token()
            guard current == self.generation, self.wanted else { return }
            guard let token, let url = self.socketURL(token: token) else {
                // Signed out, or no server yet: nothing to connect to until restart().
                self.setState(.disconnected)
                return
            }
            let task = self.session.webSocketTask(with: url)
            self.task = task
            task.resume()
            self.listen(task, generation: current)
            self.watchHandshake(generation: current)
        }
    }

    private func socketURL(token: String) -> URL? {
        guard let base = url(), var components = URLComponents(url: base, resolvingAgainstBaseURL: false) else { return nil }
        var items = components.queryItems ?? []
        items.append(URLQueryItem(name: "token", value: token))
        if let workspace = workspace()?.trimmingCharacters(in: .whitespaces), !workspace.isEmpty {
            items.append(URLQueryItem(name: "workspace", value: workspace))
        }
        components.queryItems = items
        return components.url
    }

    private func listen(_ task: URLSessionWebSocketTask, generation current: Int) {
        Task { [weak self] in
            while true {
                let message: URLSessionWebSocketTask.Message
                do {
                    message = try await task.receive()
                } catch {
                    self?.dropped(generation: current)
                    return
                }
                guard let self, current == self.generation else { return }
                switch message {
                case let .string(text): self.received(Data(text.utf8), generation: current)
                case let .data(data): self.received(data, generation: current)
                @unknown default: break
                }
            }
        }
    }

    /// No `connected` within 15 seconds: give up on this one and try again.
    private func watchHandshake(generation current: Int) {
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(15))
            guard let self, current == self.generation, self.state == .connecting else { return }
            self.task?.cancel(with: .goingAway, reason: nil)
            self.dropped(generation: current)
        }
    }

    private func received(_ data: Data, generation current: Int) {
        if state != .connected, Self.messageType(data) == "connected" {
            attempt = 0
            setState(.connected)
            startHeartbeat(generation: current)
            onOpen()
        }
        onMessage(data)
    }

    private func startHeartbeat(generation current: Int) {
        heartbeat?.cancel()
        heartbeat = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(25))
                guard let self, current == self.generation, !Task.isCancelled else { return }
                self.send(["type": "ping"])
            }
        }
    }

    private func dropped(generation current: Int) {
        guard current == generation else { return }
        generation += 1
        task = nil
        heartbeat?.cancel()
        heartbeat = nil
        setState(.disconnected)
        guard wanted, !inBackground else { return }
        let delay = min(pow(2, Double(attempt)), 30)
        attempt += 1
        retry = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled, let self else { return }
            self.retry = nil
            self.connect()
        }
    }

    private func close() {
        generation += 1
        retry?.cancel()
        retry = nil
        heartbeat?.cancel()
        heartbeat = nil
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
        setState(.disconnected)
    }

    private func enterBackground() {
        inBackground = true
        close()
    }

    private func enterForeground() {
        inBackground = false
        attempt = 0
        if wanted { connect() }
    }

    private func setState(_ new: RealtimeState) {
        guard state != new else { return }
        state = new
        onStateChange(new)
    }

    /// The `type` of a JSON message, if it has one.
    static func messageType(_ data: Data) -> String? {
        (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["type"] as? String
    }
}

/// An event from the workspace hub: an entity changed (`ticket`,
/// `invoice.inv_1`, …), a mail arrived, a notification. `data` is the event's
/// payload as JSON. After a reconnect every stream gets a `resync` event:
/// whatever happened in between was missed, so reload.
public struct RealtimeEvent: Sendable, Equatable {
    public let topic: String
    public let event: String
    public let userID: String?
    public let data: Data

    public init(topic: String, event: String, userID: String?, data: Data) {
        self.topic = topic
        self.event = event
        self.userID = userID
        self.data = data
    }

    public static let resyncEvent = "resync"

    /// Reload: events were missed (a reconnect, or the server's `resync_required`).
    public var isResync: Bool { event == Self.resyncEvent }

    /// The payload as a type of the app's own.
    public func decode<T: Decodable>(_ type: T.Type) -> T? {
        try? JSONDecoder().decode(type, from: data)
    }
}

/// Whether an event on `topic` belongs to a subscription to `subscription`:
/// `ticket` matches `ticket` and `ticket.tkt_1`.
public func realtimeTopic(_ topic: String, matches subscription: String) -> Bool {
    topic == subscription || topic.hasPrefix(subscription + ".")
}

/// The workspace hub (`WorkspaceClient` in `@weldsuite/realtime`): screens
/// ask for the topics they show and reload on what arrives, the same
/// cache-invalidation model as the web platform (ADR EVT-007).
///
/// ```swift
/// .task { for await _ in env.realtime.events(["ticket"]) { await store.refresh() } }
/// ```
///
/// Per-person topics carry the person's id (`mail.<userId>`,
/// `notification.<userId>`, `chat.user.<userId>`); a bare one is refused by
/// the server.
@MainActor
@Observable
public final class RealtimeClient {
    public private(set) var state: RealtimeState = .disconnected

    @ObservationIgnored private var socket: WeldSocket?
    @ObservationIgnored private var listeners: [UUID: Listener] = [:]
    @ObservationIgnored private var subscribed: Set<String> = []
    @ObservationIgnored private var openedBefore = false

    private struct Listener {
        let topics: [String]
        let continuation: AsyncStream<RealtimeEvent>.Continuation
    }

    /// - Parameter baseURL: the server's `realtimeUrl` (without `/ws`).
    public init(baseURL: URL, token: @escaping () async -> String?, workspace: @escaping () -> String?) {
        let url = baseURL.appendingPathComponent("ws")
        socket = WeldSocket(
            url: { url },
            token: token,
            workspace: workspace,
            onOpen: { [weak self] in self?.opened() },
            onMessage: { [weak self] data in self?.received(data) },
            onStateChange: { [weak self] state in self?.state = state }
        )
    }

    /// Events on `topics` (and their children) until the stream's task ends.
    public func events(_ topics: [String]) -> AsyncStream<RealtimeEvent> {
        let (stream, continuation) = AsyncStream.makeStream(of: RealtimeEvent.self, bufferingPolicy: .bufferingNewest(32))
        let id = UUID()
        listeners[id] = Listener(topics: topics, continuation: continuation)
        continuation.onTermination = { [weak self] _ in
            Task { @MainActor in self?.removeListener(id) }
        }
        let fresh = Set(topics).subtracting(subscribed)
        if !fresh.isEmpty, state == .connected {
            subscribed.formUnion(fresh)
            socket?.send(["type": "subscribe", "topics": Array(fresh)])
        }
        socket?.start()
        return stream
    }

    /// Reconnect for another workspace or person; streams carry on.
    public func restart() {
        subscribed = []
        socket?.restart()
    }

    /// Close for good (sign-out). Streams stay open and get events again after `restart()`.
    public func stop() {
        subscribed = []
        openedBefore = false
        socket?.stop()
    }

    private func removeListener(_ id: UUID) {
        listeners[id] = nil
        let wanted = Set(listeners.values.flatMap(\.topics))
        let gone = subscribed.subtracting(wanted)
        if !gone.isEmpty, state == .connected {
            socket?.send(["type": "unsubscribe", "topics": Array(gone)])
        }
        subscribed.subtract(gone)
        if listeners.isEmpty { socket?.stop() }
    }

    private func opened() {
        let topics = Set(listeners.values.flatMap(\.topics))
        subscribed = topics
        if !topics.isEmpty { socket?.send(["type": "subscribe", "topics": Array(topics)]) }
        if openedBefore {
            for listener in listeners.values {
                for topic in listener.topics {
                    listener.continuation.yield(RealtimeEvent(topic: topic, event: RealtimeEvent.resyncEvent, userID: nil, data: Data("null".utf8)))
                }
            }
        }
        openedBefore = true
    }

    private func received(_ data: Data) {
        guard let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = message["type"] as? String
        else { return }
        switch type {
        case "event":
            guard let topic = message["topic"] as? String else { return }
            let payload = message["data"].flatMap { try? JSONSerialization.data(withJSONObject: $0, options: [.fragmentsAllowed]) }
                ?? Data("null".utf8)
            let event = RealtimeEvent(
                topic: topic,
                event: message["event"] as? String ?? "",
                userID: message["userId"] as? String,
                data: payload
            )
            for listener in listeners.values where listener.topics.contains(where: { realtimeTopic(topic, matches: $0) }) {
                listener.continuation.yield(event)
            }
        case "resync_required":
            let topics = message["topics"] as? [String] ?? []
            for listener in listeners.values {
                for topic in listener.topics where topics.isEmpty || topics.contains(where: { realtimeTopic($0, matches: topic) || realtimeTopic(topic, matches: $0) }) {
                    listener.continuation.yield(RealtimeEvent(topic: topic, event: RealtimeEvent.resyncEvent, userID: nil, data: Data("null".utf8)))
                }
            }
        default:
            break
        }
    }
}
