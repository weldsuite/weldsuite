import AudioToolbox
import AVFoundation
import Foundation
import LiveKit
import Observation
import UIKit
import WeldCore

/// Where the call is.
enum CallStatus: Equatable, Sendable {
    case idle
    case ringingIncoming
    case connecting
    case connected
}

/// A camera in the call, the person's own included.
struct VideoTile: Identifiable {
    let id: ObjectIdentifier
    let name: String?
    let track: VideoTrack
    let isLocal: Bool
}

/// WeldChat's calls (port of the Expo app's `CallContext` and `CallHost`):
/// rings (realtime `call_incoming` on `chat.user.<id>`, push taps, CallKit),
/// the call lifecycle over `/api/chat-calls`, the LiveKit room the call's
/// media runs in (ADR CHAT-008), and the state the call screens show.
@MainActor
@Observable
final class CallManager {
    // MARK: What the rest of the app reads

    /// Calls running per channel, for a channel's "Join" button.
    private(set) var activeChannelCalls: [String: ActiveChannelCall] = [:]
    /// The joined call's id; nil when not in a call.
    private(set) var inCallID: String?

    // MARK: What the call screens read

    private(set) var status: CallStatus = .idle
    private(set) var session: CallSession?
    /// A ring the app shows itself (CallKit shows the others).
    private(set) var incoming: IncomingCall?
    private(set) var minimized = false
    /// In the media room.
    private(set) var roomJoined = false
    /// Someone else is in the room (held for 600 ms, so a flicker doesn't count).
    private(set) var peerJoined = false
    private(set) var reconnecting = false
    /// The call's length so far, from when someone else joined.
    private(set) var seconds = 0
    private(set) var micEnabled = true
    private(set) var cameraEnabled = false
    private(set) var tiles: [VideoTile] = []
    /// A message for the call screen's toast.
    private(set) var notice: String?
    /// The signed-in person's WeldSuite user id, once `start` ran.
    private(set) var userID: String?

    @ObservationIgnored let env: AppEnvironment
    @ObservationIgnored private var room: Room?
    @ObservationIgnored private var workspaceID: String?
    @ObservationIgnored private var joinInFlight = false
    @ObservationIgnored private var leaving = false
    @ObservationIgnored private var audioFromCallKit = false
    @ObservationIgnored private var listenTask: Task<Void, Never>?
    @ObservationIgnored private var roomTask: Task<Void, Never>?
    @ObservationIgnored private var watchTask: Task<Void, Never>?
    @ObservationIgnored private var connectingTimeout: Task<Void, Never>?
    @ObservationIgnored private var startedAt: Date?
    @ObservationIgnored private var latchSince: Date?
    @ObservationIgnored private var peerGoneSince: Date?
    @ObservationIgnored private var tileSignature: [ObjectIdentifier] = []
    /// Calls that stopped ringing or ended here, so a late ring can't bring them back.
    @ObservationIgnored private var ended: [String: Date] = [:]
    @ObservationIgnored private var videoURL: String?
    @ObservationIgnored private var registeredVoIP: String?
    @ObservationIgnored private let sounds = CallSounds()
    @ObservationIgnored private var foregroundObserver: NSObjectProtocol?

    /// How long a 1:1 call waits for the other person to come back before hanging up.
    private static let peerGoneGrace: TimeInterval = 10
    /// How long someone must be in the room before the call counts as answered.
    private static let answeredLatch: TimeInterval = 0.6
    /// Joining the room never got anywhere: give up.
    private static let connectingTimeoutSeconds = 30

    init(env: AppEnvironment) {
        self.env = env
        CallKitService.shared.setActionHandler { [weak self] action in
            self?.handleNative(action)
        }
        CallKitService.shared.tokenListener = { [weak self] _ in
            guard let self else { return }
            Task { await self.registerVoIPToken() }
        }
        foregroundObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.willEnterForegroundNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                // The socket slept in the background: a ring may have been missed.
                Task { await self.recoverIncomingFromServer() }
            }
        }
    }

    private var api: CallAPI { CallAPI(env: env) }

    private var callsAvailable: Bool { env.isAvailable("chat-calls") }

    // MARK: - Starting

    /// The person is in `workspace`: listen for rings and call events on
    /// their own topic, register the VoIP token, and pick up a ring the app
    /// missed while it was closed. Returns at once; the listening goes on.
    func start(person: Person, workspace: WorkspaceRef) async {
        CallKitService.shared.rememberServer(env.serverURL.absoluteString)
        let changed = userID != person.id || workspaceID != workspace.id
        if workspaceID != workspace.id { activeChannelCalls = [:] }
        userID = person.id
        workspaceID = workspace.id
        guard callsAvailable else {
            listenTask?.cancel()
            listenTask = nil
            return
        }
        if changed || listenTask == nil { listen(to: person.id) }
        await registerVoIPToken()
        await recoverIncomingFromServer()
    }

    private func listen(to userID: String) {
        listenTask?.cancel()
        guard let realtime = env.realtime else { return }
        let stream = realtime.events(["chat.user.\(userID)"])
        listenTask = Task { [weak self] in
            for await event in stream {
                guard let self else { return }
                self.handle(event)
            }
        }
    }

    private func handle(_ event: RealtimeEvent) {
        if event.isResync {
            Task { await recoverIncomingFromServer() }
            return
        }
        let data = (try? JSONSerialization.jsonObject(with: event.data)) as? [String: Any] ?? [:]
        switch event.event {
        case "call_incoming":
            if let ring = CallPayloads.incoming(fromEvent: data) { presentRing(ring) }
        case "call_started":
            // A call became active in one of the person's channels: its "Join".
            if let channelID = data["channelId"] as? String, let callID = data["callId"] as? String {
                activeChannelCalls[channelID] = ActiveChannelCall(callID: callID, callType: CallType(wire: data["callType"] as? String))
            }
        case "call_ended":
            callEnded(channelID: data["channelId"] as? String, callID: data["callId"] as? String)
        case "call_answered":
            // Answered on another device: stop ringing here. The call goes on.
            if let callID = data["callId"] as? String, incoming?.callID == callID { dismissRing() }
        default:
            break
        }
    }

    /// The person's VoIP token in this workspace (`<deviceId>:call`), so the
    /// server rings this phone through CallKit.
    private func registerVoIPToken() async {
        guard CallKitService.isCallKitAllowed, callsAvailable,
              let workspaceID, let token = CallKitService.shared.voipToken, let push = env.push
        else { return }
        let key = "\(workspaceID)|\(token)"
        guard registeredVoIP != key else { return }
        if await push.register(token: token, type: .voip, deviceID: DeviceIdentity.id + ":call", in: workspaceID) {
            registeredVoIP = key
        }
    }

    // MARK: - Rings

    /// A tapped "Incoming call" notification.
    func presentIncoming(_ payload: PushPayload) {
        if let server = payload.server, URL(string: server)?.host != env.serverURL.host { return }
        guard let ring = CallPayloads.incoming(fromNotification: payload.values) else { return }
        presentRing(ring)
    }

    /// Ring: through CallKit where it is allowed, else on the app's own screen.
    private func presentRing(_ ring: IncomingCall) {
        guard callsAvailable, session?.callID != ring.callID, !recentlyEnded(ring.callID) else { return }
        if CallKitService.isCallKitAllowed {
            // CallKit ignores a call it already shows.
            CallKitService.shared.reportIncoming(CallPayloads.nativePayload(ring))
            return
        }
        guard status == .idle else { return }
        incoming = ring
        status = .ringingIncoming
        sounds.startRinging()
    }

    private func dismissRing() {
        incoming = nil
        sounds.stopRinging()
        if status == .ringingIncoming { status = .idle }
    }

    /// `call_ended`: the channel's "Join" goes, and so does every ring for the call.
    private func callEnded(channelID: String?, callID: String?) {
        if let channelID { activeChannelCalls[channelID] = nil }
        // A call this phone answered ends through `leaveCall`.
        if let callID, session?.callID != callID { CallKitService.shared.endFromApp(callID) }
        if let ring = incoming, callID == nil || callID == ring.callID { dismissRing() }
    }

    /// After the background the socket may have missed `call_incoming`:
    /// look for a DM ring still waiting for this person.
    private func recoverIncomingFromServer() async {
        guard let userID, status == .idle, callsAvailable else { return }
        guard let calls = try? await api.activeCalls() else { return }
        guard status == .idle, let ring = CallRules.recoverableRing(calls, selfID: userID) else { return }
        presentRing(IncomingCall(
            callID: ring.callID,
            channelID: ring.channelID,
            callType: ring.callType,
            callerName: ring.initiatorName,
            callerAvatar: nil
        ))
    }

    private func markEnded(_ callID: String) {
        let now = Date()
        ended = ended.filter { now.timeIntervalSince($0.value) < 120 }
        ended[callID] = now
    }

    private func recentlyEnded(_ callID: String) -> Bool {
        guard let at = ended[callID] else { return false }
        return Date().timeIntervalSince(at) < 120
    }

    /// Answer the ring on the app's own screen.
    func acceptIncoming() {
        guard let ring = incoming else { return }
        Task { await accept(ring, viaCallKit: false) }
    }

    /// Decline the ring on the app's own screen.
    func declineIncoming() {
        guard let ring = incoming else { return }
        dismissRing()
        markEnded(ring.callID)
        CallKitService.shared.endFromApp(ring.callID)
        Task { try? await api.decline(ring.callID) }
    }

    /// Join a ringing call: the in-app Accept, or Answer on CallKit.
    private func accept(_ ring: IncomingCall, viaCallKit: Bool) async {
        if let server = ring.server, URL(string: server)?.host != env.serverURL.host {
            // A ring from a server the app doesn't use: nothing to join here.
            CallKitService.shared.endFromApp(ring.callID)
            return
        }
        guard !joinInFlight, session?.callID != ring.callID else { return }
        joinInFlight = true
        defer { joinInFlight = false }
        sounds.stopRinging()
        incoming = nil
        status = .connecting
        // Answered on a closed app: the session may still be booting.
        await ensureReady()
        do {
            let joined = try await api.join(ring.callID)
            let peer = CallRules.peerOfAnsweredCall(
                callerName: ring.callerName,
                callerAvatar: ring.callerAvatar,
                participants: joined.participants,
                selfID: userID
            )
            begin(
                CallSession(
                    callID: ring.callID,
                    channelID: joined.channelID ?? ring.channelID,
                    callType: joined.callType ?? ring.callType,
                    authToken: joined.authToken,
                    // Only DMs ring, so an answered ring is always direct.
                    isDirect: true,
                    peerName: peer.name,
                    peerAvatar: peer.avatar,
                    answered: true
                ),
                audioFromCallKit: viaCallKit
            )
        } catch {
            CallKitService.shared.endFromApp(ring.callID)
            status = .idle
        }
    }

    /// The system call screen: Answer, Decline, hang up, mute.
    private func handleNative(_ action: NativeCallAction) {
        switch action {
        case let .accept(payload):
            guard let ring = CallPayloads.incoming(fromNative: payload) else { return }
            Task { await accept(ring, viaCallKit: true) }
        case let .decline(payload, handled):
            let callID = payload["callId"] ?? ""
            guard !callID.isEmpty else { return }
            if incoming?.callID == callID { dismissRing() }
            markEnded(callID)
            // Declined natively with the ring token already when it had one.
            guard !handled else { return }
            Task {
                await ensureReady()
                try? await api.decline(callID)
            }
        case let .end(payload):
            if let callID = payload["callId"], session?.callID == callID { Task { await leaveCall() } }
        case let .mute(payload, muted):
            if let callID = payload["callId"], session?.callID == callID { setMic(enabled: !muted) }
        }
    }

    /// Wait for the session (a ring answered before any screen was up).
    private func ensureReady() async {
        if case .ready = env.state { return }
        if case .booting = env.state, env.session == nil { await env.start() }
        for _ in 0..<80 {
            if case .ready = env.state { return }
            try? await Task.sleep(for: .milliseconds(250))
        }
    }

    // MARK: - Starting and joining

    /// Start a call in a channel, or join the one already running there.
    func startCall(channelID: String, callType: CallType, peer: CallPeer?) async throws {
        guard !joinInFlight else { return }
        joinInFlight = true
        defer { joinInFlight = false }
        status = .connecting
        do {
            let joined = try await api.startAndJoin(channelID: channelID, callType: callType)
            begin(CallSession(
                callID: joined.callID,
                channelID: channelID,
                // start-and-join may have joined a running call of the other type.
                callType: joined.callType ?? callType,
                authToken: joined.authToken,
                isDirect: peer?.isDirect ?? false,
                peerName: peer?.name,
                peerAvatar: peer?.avatar,
                answered: false
            ))
        } catch {
            if session == nil { status = .idle }
            throw error
        }
    }

    /// Join a running call by id.
    func joinCall(callID: String, peer: CallPeer?) async throws {
        guard !joinInFlight else { return }
        joinInFlight = true
        defer { joinInFlight = false }
        status = .connecting
        do {
            let joined = try await api.join(callID)
            var channelID = joined.channelID
            var callType = joined.callType
            if channelID == nil || callType == nil, let call = try await api.call(callID) {
                channelID = channelID ?? call.channelID
                callType = callType ?? call.callType
            }
            begin(CallSession(
                callID: callID,
                channelID: channelID ?? "",
                callType: callType ?? .voice,
                authToken: joined.authToken,
                isDirect: peer?.isDirect ?? false,
                peerName: peer?.name,
                peerAvatar: peer?.avatar,
                answered: false
            ))
        } catch {
            if session == nil { status = .idle }
            throw error
        }
    }

    /// The channel's running call, for its "Join" button.
    func refreshActiveCall(channelID: String) async {
        guard callsAvailable else { return }
        do {
            let call = try await api.activeCall(in: channelID)
            activeChannelCalls[channelID] = call.map { ActiveChannelCall(callID: $0.id, callType: $0.callType) }
        } catch {
            // Best effort: the realtime events keep it right from here.
        }
    }

    private func begin(_ new: CallSession, audioFromCallKit: Bool = false) {
        if session != nil || room != nil { tearDownRoom(releaseAudio: false) }
        session = new
        inCallID = new.callID
        minimized = false
        leaving = false
        status = .connecting
        self.audioFromCallKit = audioFromCallKit
        activeChannelCalls[new.channelID] = ActiveChannelCall(callID: new.callID, callType: new.callType)
        // CallKit set the audio up for a call it answered.
        if !audioFromCallKit { CallAudio.configure(video: new.callType == .video) }
        // Ringback only for the caller; an answered ring already has the caller there.
        if new.isDirect, !new.answered { sounds.startRingback() }
        armConnectingTimeout(for: new.callID)
        roomTask = Task { [weak self] in await self?.openRoom(for: new) }
    }

    private func armConnectingTimeout(for callID: String) {
        connectingTimeout?.cancel()
        connectingTimeout = Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.connectingTimeoutSeconds))
            guard !Task.isCancelled, let self, self.session?.callID == callID, !self.roomJoined else { return }
            await self.leaveCall()
        }
    }

    // MARK: - The room

    /// The LiveKit server from the server's `/config.json`, read once.
    private func liveKitURL() async -> String? {
        if let videoURL { return videoURL }
        let url = env.serverURL.appendingPathComponent("config.json")
        guard let result = try? await URLSession.shared.data(from: url),
              (result.1 as? HTTPURLResponse)?.statusCode == 200,
              let json = (try? JSONSerialization.jsonObject(with: result.0)) as? [String: Any]
        else { return nil }
        let target = CallRules.liveKitURL(provider: json["videoProvider"] as? String, url: json["videoUrl"] as? String)
        videoURL = target
        return target
    }

    private func openRoom(for current: CallSession) async {
        guard let url = await liveKitURL() else {
            // The server's tokens are for a provider this app can't join.
            guard session?.callID == current.callID else { return }
            notice = ChatStrings.callUnjoinable
            await leaveCall()
            return
        }
        guard session?.callID == current.callID else { return }
        let room = Room()
        self.room = room
        do {
            try await room.connect(url: url, token: current.authToken)
        } catch {
            guard session?.callID == current.callID, self.room === room else { return }
            await leaveCall()
            return
        }
        guard session?.callID == current.callID, self.room === room else {
            await room.disconnect()
            return
        }
        roomJoined = true
        connectingTimeout?.cancel()
        if status == .connecting { status = .connected }
        _ = try? await room.localParticipant.setMicrophone(enabled: micEnabled)
        if current.callType == .video {
            cameraEnabled = true
            _ = try? await room.localParticipant.setCamera(enabled: true)
        }
        watch(room, callID: current.callID)
    }

    /// Follow the room four times a second: reconnecting, who's in it, cameras.
    private func watch(_ room: Room, callID: String) {
        watchTask?.cancel()
        watchTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(250))
                guard !Task.isCancelled, let self, self.session?.callID == callID, self.room === room else { return }
                self.tick(room)
            }
        }
    }

    private func tick(_ room: Room) {
        let state = room.connectionState
        let isReconnecting = state == .reconnecting
        if reconnecting != isReconnecting { reconnecting = isReconnecting }
        if state == .disconnected {
            // A dropped connection comes back by itself (`reconnecting`); this is a leave.
            Task { await leaveCall() }
            return
        }
        refreshTiles(room)
        let now = Date()
        let present = !room.remoteParticipants.isEmpty
        if !peerJoined {
            if present {
                let since = latchSince ?? now
                latchSince = since
                if now.timeIntervalSince(since) >= Self.answeredLatch {
                    peerJoined = true
                    startedAt = now
                    sounds.stopRingback()
                }
            } else {
                latchSince = nil
            }
        } else if session?.isDirect == true {
            // 1:1 and the other person is gone: their leave doesn't end the
            // call on the server while this phone is in the room. The grace
            // rides out their reconnect after a network drop.
            if present {
                peerGoneSince = nil
            } else {
                let since = peerGoneSince ?? now
                peerGoneSince = since
                if now.timeIntervalSince(since) >= Self.peerGoneGrace, !reconnecting {
                    Task { await leaveCall() }
                    return
                }
            }
        }
        if let startedAt {
            let elapsed = Int(now.timeIntervalSince(startedAt))
            if elapsed != seconds { seconds = elapsed }
        }
    }

    private func refreshTiles(_ room: Room) {
        var next: [VideoTile] = []
        for participant in room.remoteParticipants.values {
            if let track = participant.firstCameraVideoTrack {
                next.append(VideoTile(id: ObjectIdentifier(participant), name: participant.name, track: track, isLocal: false))
            }
        }
        if cameraEnabled, let track = room.localParticipant.firstCameraVideoTrack {
            next.append(VideoTile(id: ObjectIdentifier(room.localParticipant), name: nil, track: track, isLocal: true))
        }
        let signature = next.map { ObjectIdentifier($0.track as AnyObject) }
        guard signature != tileSignature else { return }
        tileSignature = signature
        tiles = next
    }

    // MARK: - In the call

    func setMic(enabled: Bool) {
        micEnabled = enabled
        guard let room else { return }
        Task { _ = try? await room.localParticipant.setMicrophone(enabled: enabled) }
    }

    func toggleMic() {
        setMic(enabled: !micEnabled)
    }

    func toggleCamera() {
        let next = !cameraEnabled
        cameraEnabled = next
        guard let room else { return }
        Task {
            _ = try? await room.localParticipant.setCamera(enabled: next)
            self.refreshTiles(room)
        }
    }

    func flipCamera() {
        guard let room else { return }
        Task {
            guard let track = room.localParticipant.firstCameraVideoTrack as? LocalVideoTrack,
                  let capturer = track.capturer as? CameraCapturer
            else { return }
            _ = try? await capturer.switchCameraPosition()
        }
    }

    func minimize() {
        minimized = true
    }

    func expand() {
        minimized = false
    }

    func clearNotice() {
        notice = nil
    }

    func hangUp() {
        Task { await leaveCall() }
    }

    /// Leave the call: the room, CallKit and the server.
    func leaveCall() async {
        guard let current = session, !leaving else { return }
        leaving = true
        tearDownRoom(releaseAudio: !audioFromCallKit)
        session = nil
        inCallID = nil
        status = .idle
        minimized = false
        CallKitService.shared.endFromApp(current.callID)
        markEnded(current.callID)
        try? await api.leave(current.callID)
    }

    private func tearDownRoom(releaseAudio: Bool) {
        roomTask?.cancel()
        roomTask = nil
        watchTask?.cancel()
        watchTask = nil
        connectingTimeout?.cancel()
        connectingTimeout = nil
        sounds.stopRingback()
        let old = room
        room = nil
        roomJoined = false
        peerJoined = false
        reconnecting = false
        seconds = 0
        tiles = []
        tileSignature = []
        micEnabled = true
        cameraEnabled = false
        latchSince = nil
        peerGoneSince = nil
        startedAt = nil
        Task {
            await old?.disconnect()
            // Only once out of the room: iOS stops what still plays into a session it deactivates.
            if releaseAudio { CallAudio.release() }
        }
    }

    /// Under the name on the call screen and in the bar.
    var statusText: String {
        guard let session else { return "" }
        if !roomJoined {
            return CallRules.connectingLabel(isDirect: session.isDirect, answered: session.answered, peerName: session.peerName)
        }
        return CallRules.statusLabel(answered: session.answered, reconnecting: reconnecting, peerJoined: peerJoined, seconds: seconds)
    }
}

/// The phone's audio for a call the app (not CallKit) set up.
enum CallAudio {
    static func configure(video: Bool) {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(
            .playAndRecord,
            mode: video ? .videoChat : .voiceChat,
            options: video ? [.allowBluetooth, .defaultToSpeaker] : [.allowBluetooth]
        )
        try? session.setActive(true)
    }

    static func release() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}

/// The ringtone of the app's own ring screen, and the caller's ringback.
@MainActor
final class CallSounds {
    private var ringback: AVAudioPlayer?
    private var ringtone: AVAudioPlayer?
    private var vibration: Task<Void, Never>?

    func startRingback() {
        guard ringback == nil else { return }
        ringback = Self.looping("ringback")
    }

    func stopRingback() {
        ringback?.stop()
        ringback = nil
    }

    /// Ring (and vibrate) until answered or declined; the silent switch silences the tone.
    func startRinging() {
        guard ringtone == nil, vibration == nil else { return }
        try? AVAudioSession.sharedInstance().setCategory(.soloAmbient)
        try? AVAudioSession.sharedInstance().setActive(true)
        ringtone = Self.looping("ringtone")
        vibration = Task {
            while !Task.isCancelled {
                AudioServicesPlaySystemSound(kSystemSoundID_Vibrate)
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    func stopRinging() {
        ringtone?.stop()
        ringtone = nil
        vibration?.cancel()
        vibration = nil
    }

    private static func looping(_ name: String) -> AVAudioPlayer? {
        guard let url = Bundle.main.url(forResource: name, withExtension: "wav"),
              let player = try? AVAudioPlayer(contentsOf: url)
        else { return nil }
        player.numberOfLoops = -1
        player.play()
        return player
    }
}
