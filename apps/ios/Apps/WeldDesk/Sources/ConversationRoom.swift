import Foundation
import Observation
import WeldCore

/// A conversation's realtime room (`/ws/conversation/<id>`), joined while the
/// thread is open, for what the workspace hub doesn't carry: the visitor
/// typing, the visitor's presence, and the agent's own typing signal. The
/// timeline itself stays live through the hub. Built on the core's
/// `WeldSocket`, which reconnects, and closes in the background, on its own.
@MainActor
@Observable
final class ConversationRoom {
    private(set) var state = RoomState()

    @ObservationIgnored private var socket: WeldSocket?
    @ObservationIgnored private var throttle = TypingThrottle()
    @ObservationIgnored private var idle: Task<Void, Never>?
    @ObservationIgnored private var expiries: [String: Task<Void, Never>] = [:]

    init(env: AppEnvironment, base: URL, conversationID: String) {
        let url = base.appendingPathComponent("ws").appendingPathComponent("conversation").appendingPathComponent(conversationID)
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

    /// Leave the room: presence first, while the socket is still open.
    func stop() {
        idle?.cancel()
        idle = nil
        for task in expiries.values { task.cancel() }
        expiries = [:]
        if throttle.stop() { socket?.send(["type": "typing:stop"]) }
        socket?.send(["type": "presence:leave"])
        socket?.stop()
        state = RoomState()
    }

    /// A keystroke in a reply (not a note): "typing" now and then, "stopped" after a pause.
    func typed() {
        guard let socket, socket.state == .connected else { return }
        if throttle.keystroke(now: Date().timeIntervalSince1970) { socket.send(["type": "typing:start"]) }
        idle?.cancel()
        idle = Task { [weak self] in
            try? await Task.sleep(for: DeskLogic.typingIdle)
            guard !Task.isCancelled else { return }
            self?.stopTyping()
        }
    }

    func stopTyping() {
        idle?.cancel()
        idle = nil
        if throttle.stop() { socket?.send(["type": "typing:stop"]) }
    }

    private func opened() {
        socket?.send(["type": "presence:enter", "data": ["role": "agent"]])
    }

    private func received(_ data: Data) {
        guard let message = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
        let type = message["type"] as? String
        let fields = RoomState.fields(of: message)
        state = RoomState.reduce(state, type: type, fields: fields)
        if type == "typing", let userID = fields.userID { expireTyping(userID) }
    }

    /// A typing signal without a stop clears itself.
    private func expireTyping(_ userID: String) {
        expiries[userID]?.cancel()
        expiries[userID] = nil
        guard state.typing[userID] != nil else { return }
        expiries[userID] = Task { [weak self] in
            try? await Task.sleep(for: DeskLogic.typingExpiry)
            guard !Task.isCancelled, let self else { return }
            self.expiries[userID] = nil
            self.state.typing[userID] = nil
        }
    }
}
