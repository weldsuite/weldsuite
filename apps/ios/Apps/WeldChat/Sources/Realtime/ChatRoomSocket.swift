import Foundation
import Observation
import WeldCore

/// Where the server's realtime service is: `/config.json`'s `realtimeUrl`
/// (without `/ws`), else the server itself on `ws(s)://`. The core reads the
/// same file but keeps the address to itself, so it is read once here.
@MainActor
enum RealtimeEndpoint {
    private static var cache: [String: URL] = [:]

    static func base(for server: URL) async -> URL {
        if let cached = cache[server.absoluteString] { return cached }
        var configured: String?
        var request = URLRequest(url: server.appendingPathComponent("config.json"))
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 5
        if let (data, _) = try? await URLSession.shared.data(for: request),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            configured = json["realtimeUrl"] as? String
        }
        let base = normalize(configured, server: server)
        cache[server.absoluteString] = base
        return base
    }

    nonisolated static func normalize(_ configured: String?, server: URL) -> URL {
        var text = configured?.trimmingCharacters(in: .whitespaces) ?? ""
        if text.isEmpty {
            text = server.absoluteString.replacingOccurrences(of: "^http", with: "ws", options: .regularExpression)
        }
        while text.hasSuffix("/") { text.removeLast() }
        if text.hasSuffix("/ws") { text.removeLast(3) }
        return URL(string: text) ?? server
    }
}

/// A WeldChat room (`RoomClient` in `@weldsuite/realtime`): the channel's
/// live messages and who is typing, on `<realtime>/ws/chat/<channelId>`.
/// A message (or a reaction, a pin) reloads the channel; so does every
/// reconnect after the first, since the room doesn't replay what was missed.
@MainActor
@Observable
final class ChatRoomSocket {
    /// Who is typing, the caller left out.
    private(set) var typingUserIDs: [String] = []

    @ObservationIgnored private var socket: WeldSocket?
    @ObservationIgnored private let selfID: String?
    @ObservationIgnored private var openedBefore = false
    @ObservationIgnored private var typingExpiry: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var lastTypingSent = Date.distantPast
    @ObservationIgnored var onChange: (() -> Void)?

    init(env: AppEnvironment, base: URL, channelID: String, selfID: String?) {
        self.selfID = selfID
        let url = base.appendingPathComponent("ws").appendingPathComponent("chat").appendingPathComponent(channelID)
        socket = WeldSocket(
            url: { url },
            token: { [weak env] in await env?.session?.token() },
            workspace: { [weak env] in env?.session?.activeWorkspaceID },
            onOpen: { [weak self] in self?.opened() },
            onMessage: { [weak self] data in self?.received(data) }
        )
    }

    func start() {
        socket?.start()
    }

    func stop() {
        socket?.stop()
        for task in typingExpiry.values { task.cancel() }
        typingExpiry = [:]
        typingUserIDs = []
    }

    /// A keystroke: tell the room, at most every three seconds.
    func keystroke() {
        guard Date().timeIntervalSince(lastTypingSent) > 3 else { return }
        lastTypingSent = Date()
        socket?.send(["type": "typing:start"])
    }

    func sent() {
        lastTypingSent = .distantPast
        socket?.send(["type": "typing:stop"])
    }

    private func opened() {
        if openedBefore { onChange?() }
        openedBefore = true
    }

    private func received(_ data: Data) {
        guard let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = message["type"] as? String
        else { return }
        switch type {
        case "message", "reaction", "pin", "channel:updated":
            onChange?()
        case "typing":
            guard let userID = message["userId"] as? String, userID != selfID else { return }
            typing(userID, isTyping: message["isTyping"] as? Bool ?? false)
        default:
            break
        }
    }

    /// A "typing" lasts six seconds unless it is stopped or renewed.
    private func typing(_ userID: String, isTyping: Bool) {
        typingExpiry[userID]?.cancel()
        typingExpiry[userID] = nil
        if isTyping {
            if !typingUserIDs.contains(userID) { typingUserIDs.append(userID) }
            typingExpiry[userID] = Task { [weak self] in
                try? await Task.sleep(for: .seconds(6))
                guard !Task.isCancelled else { return }
                self?.typing(userID, isTyping: false)
            }
        } else {
            typingUserIDs.removeAll { $0 == userID }
        }
    }
}
