import AVFoundation
import CallKit
import Foundation
import PushKit
import UIKit

/// What the person did on the system call screen, for `CallManager`.
enum NativeCallAction: Sendable {
    /// Answered a ring.
    case accept([String: String])
    /// Declined a ring; `handledNatively` when the ring token already declined it on the server.
    case decline([String: String], handledNatively: Bool)
    /// Hung up an answered call.
    case end([String: String])
    /// Muted or unmuted from the system call screen.
    case mute([String: String], muted: Bool)
}

/// The incoming-call ring (ADR CHAT-005), ported from the Expo app's
/// `weldchat-calls` module. PushKit receives the ring (a VoIP push, also
/// while the app isn't running) and CallKit shows it as a phone call: the
/// system ring screen, the lock screen, Recents.
///
/// iOS ends an app that receives a VoIP push without reporting a call to
/// CallKit, and stops delivering them after repeated misses. So every push is
/// reported: a ring that is already over, or a cancel for a call this phone
/// doesn't show, is reported and ended in the same breath.
///
/// Everything runs on the main queue (PushKit and CallKit both deliver
/// there). China's MIIT doesn't allow CallKit: on a phone whose region is
/// mainland China none of this runs, and the app rings with its own screen.
final class CallKitService: NSObject, @unchecked Sendable {
    static let shared = CallKitService()

    /// Read once per process, so a region change applies from the next launch.
    static let isCallKitAllowed: Bool = Locale.current.region?.identifier != "CN"

    private static let tokenKey = "weldchat.calls.voipToken"
    private static let serverKey = "weldchat.calls.server"
    /// The server cancels long before; this bounds a ring whose cancel never comes.
    private static let ringTimeout: TimeInterval = 60

    private struct KnownCall {
        var payload: [String: String]
        var answered = false
    }

    /// Lazy so a phone in China never makes one.
    private lazy var provider: CXProvider = {
        let configuration = CXProviderConfiguration()
        configuration.supportsVideo = true
        configuration.maximumCallGroups = 1
        configuration.maximumCallsPerCallGroup = 1
        configuration.supportedHandleTypes = [.generic]
        configuration.includesCallsInRecents = true
        let provider = CXProvider(configuration: configuration)
        provider.setDelegate(self, queue: nil)
        return provider
    }()

    private lazy var controller = CXCallController()
    private var registry: PKPushRegistry?
    private var calls: [UUID: KnownCall] = [:]
    /// Calls that stopped ringing here, so a late realtime ring or the
    /// foreground recovery can't ring them again while the server catches up.
    private var ended: [UUID: Date] = [:]
    private var pending: [NativeCallAction] = []
    private var actionHandler: (@MainActor (NativeCallAction) -> Void)?
    /// A new VoIP token, to register with the server.
    var tokenListener: (@MainActor (String) -> Void)?

    override private init() {
        super.init()
    }

    /// At launch (`WeldChatAppDelegate`): PushKit hands over a VoIP push that
    /// woke the app as soon as a registry with a delegate exists.
    func start() {
        guard Self.isCallKitAllowed else {
            // A token from before (another region) must not be registered again.
            UserDefaults.standard.removeObject(forKey: Self.tokenKey)
            return
        }
        guard registry == nil else { return }
        let registry = PKPushRegistry(queue: .main)
        registry.delegate = self
        registry.desiredPushTypes = [.voIP]
        self.registry = registry
    }

    /// This phone's VoIP token, hex, once PushKit handed it over.
    var voipToken: String? {
        Self.isCallKitAllowed ? UserDefaults.standard.string(forKey: Self.tokenKey) : nil
    }

    /// The server the app runs against, for a Decline on a ring that names none.
    func rememberServer(_ server: String) {
        UserDefaults.standard.set(server, forKey: Self.serverKey)
    }

    /// `CallManager` takes the actions; those taken before it was there (an
    /// Answer that launched the app) come at once.
    func setActionHandler(_ handler: @escaping @MainActor (NativeCallAction) -> Void) {
        actionHandler = handler
        let queued = pending
        pending = []
        for action in queued { deliver(action, to: handler) }
    }

    private func dispatch(_ action: NativeCallAction) {
        guard let actionHandler else {
            pending.append(action)
            return
        }
        deliver(action, to: actionHandler)
    }

    private func deliver(_ action: NativeCallAction, to handler: @escaping @MainActor (NativeCallAction) -> Void) {
        Task { @MainActor in handler(action) }
    }

    // MARK: - Ringing

    /// Forget a call (it stopped ringing or ended) and remember that it did.
    @discardableResult
    private func forget(_ uuid: UUID) -> KnownCall? {
        let now = Date()
        ended = ended.filter { now.timeIntervalSince($0.value) < 120 }
        ended[uuid] = now
        return calls.removeValue(forKey: uuid)
    }

    private func recentlyEnded(_ uuid: UUID) -> Bool {
        guard let at = ended[uuid] else { return false }
        return Date().timeIntervalSince(at) < 120
    }

    /// Whether CallKit shows this call, or just stopped showing it.
    func knows(callID: String) -> Bool {
        let uuid = callKitUUID(for: callID)
        return calls[uuid] != nil || recentlyEnded(uuid)
    }

    private static func endReason(_ reason: String?) -> CXCallEndedReason {
        switch reason {
        case "answered": return .answeredElsewhere
        case "declined": return .declinedElsewhere
        default: return .remoteEnded
        }
    }

    private static func update(name: String, video: Bool) -> CXCallUpdate {
        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: name)
        update.localizedCallerName = name
        update.hasVideo = video
        update.supportsHolding = false
        update.supportsGrouping = false
        update.supportsUngrouping = false
        update.supportsDTMF = false
        return update
    }

    /// Show a ring in CallKit: from a VoIP push (`completion` is PushKit's),
    /// or from the app (the realtime ring while it runs).
    func reportIncoming(_ payload: [String: String], completion: (() -> Void)? = nil) {
        guard Self.isCallKitAllowed else {
            completion?()
            return
        }
        let callID = payload["callId"] ?? ""
        let uuid = callID.isEmpty ? UUID() : callKitUUID(for: callID)
        // The app ringing a call CallKit already shows, or one that just
        // stopped here. A push must still report (below).
        if completion == nil, calls[uuid] != nil || recentlyEnded(uuid) { return }

        let expiresAt = Double(payload["expiresAt"] ?? "") ?? .infinity
        let expired = expiresAt < Date().timeIntervalSince1970 * 1000
        let name = (payload["callerName"]).flatMap { $0.isEmpty ? nil : $0 } ?? ChatStrings.callUnknownCaller
        let update = Self.update(name: name, video: payload["callType"] == "video")

        provider.reportNewIncomingCall(with: uuid, update: update) { [weak self] error in
            DispatchQueue.main.async {
                defer { completion?() }
                // An error: already ringing (the socket beat the push), or iOS
                // refused it (Focus, blocked). Nothing to add either way.
                guard let self, error == nil else { return }
                if callID.isEmpty || expired || self.recentlyEnded(uuid) {
                    // iOS insists every VoIP push shows a call; one already
                    // over ends at once.
                    self.forget(uuid)
                    self.provider.reportCall(with: uuid, endedAt: nil, reason: .unanswered)
                    return
                }
                self.calls[uuid] = KnownCall(payload: payload)
                DispatchQueue.main.asyncAfter(deadline: .now() + Self.ringTimeout) { [weak self] in
                    guard let self, let call = self.calls[uuid], !call.answered else { return }
                    self.forget(uuid)
                    self.provider.reportCall(with: uuid, endedAt: nil, reason: .unanswered)
                }
            }
        }
    }

    /// The server says the call stopped ringing for this person.
    private func cancel(callID: String, reason: String, completion: @escaping () -> Void) {
        let uuid = callKitUUID(for: callID)
        let endReason = Self.endReason(reason)
        // Reporting the call's own UUID satisfies the report-every-push rule:
        // when CallKit knows the call it fails with "already exists".
        provider.reportNewIncomingCall(with: uuid, update: Self.update(name: ChatStrings.appName, video: false)) { [weak self] error in
            DispatchQueue.main.async {
                defer { completion() }
                guard let self else { return }
                if error == nil {
                    // Nothing rang here for this call: take the placeholder down at once.
                    self.forget(uuid)
                    self.provider.reportCall(with: uuid, endedAt: nil, reason: endReason)
                } else if let call = self.calls[uuid], !call.answered {
                    self.forget(uuid)
                    self.provider.reportCall(with: uuid, endedAt: nil, reason: endReason)
                }
                // Answered on this phone: the cancel is for the person's other devices.
            }
        }
    }

    /// A push that is no ring this app can join (no `server`, or unreadable):
    /// iOS insists it shows a call, so it is reported and ended at once.
    private func reportForeign(completion: @escaping () -> Void) {
        guard Self.isCallKitAllowed else {
            completion()
            return
        }
        let uuid = UUID()
        provider.reportNewIncomingCall(with: uuid, update: Self.update(name: ChatStrings.appName, video: false)) { [weak self] error in
            DispatchQueue.main.async {
                defer { completion() }
                guard let self, error == nil else { return }
                self.provider.reportCall(with: uuid, endedAt: nil, reason: .failed)
            }
        }
    }

    /// The app is done with the call (declined in the app, hung up, or it
    /// ended): take it out of CallKit without reporting anything back.
    func endFromApp(_ callID: String) {
        guard Self.isCallKitAllowed else { return }
        let uuid = callKitUUID(for: callID)
        guard let call = forget(uuid) else { return }
        if call.answered {
            controller.request(CXTransaction(action: CXEndCallAction(call: uuid))) { [weak self] error in
                guard error != nil else { return }
                DispatchQueue.main.async {
                    self?.provider.reportCall(with: uuid, endedAt: nil, reason: .remoteEnded)
                }
            }
        } else {
            provider.reportCall(with: uuid, endedAt: nil, reason: .remoteEnded)
        }
    }

    // MARK: - Decline without a session

    /// POST the ring token to `/public/chat-calls/decline` (`declineRing`).
    /// False when there is no token or server to do it with (the app declines then).
    private func postDecline(token: String?, server: String?) -> Bool {
        guard let token, !token.isEmpty,
              let base = server ?? UserDefaults.standard.string(forKey: Self.serverKey),
              let url = URL(string: base.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/public/chat-calls/decline"),
              let body = try? JSONSerialization.data(withJSONObject: ["token": token])
        else { return false }
        var request = URLRequest(url: url, timeoutInterval: 8)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body

        // Keep the app alive for the request when it was woken just for this ring.
        let background = BackgroundTask()
        MainActor.assumeIsolated {
            background.begin()
        }
        URLSession.shared.dataTask(with: request) { _, _, _ in
            DispatchQueue.main.async {
                MainActor.assumeIsolated { background.end() }
            }
        }.resume()
        return true
    }

    // MARK: - Audio

    private func configureAudioSession(video: Bool) {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(
            .playAndRecord,
            mode: video ? .videoChat : .voiceChat,
            options: video ? [.allowBluetooth, .defaultToSpeaker] : [.allowBluetooth]
        )
    }

    /// CallKit owns the audio session during a call it shows; WebRTC must be
    /// told when it is handed over or the call stays silent. Looked up at run
    /// time (LiveKit's WebRTC prefixes its classes `LKRTC`).
    private func notifyWebRTC(_ selectorName: String, _ session: AVAudioSession) {
        let shared = NSSelectorFromString("sharedInstance")
        for name in ["LKRTCAudioSession", "RTCAudioSession"] {
            guard let type: AnyObject = NSClassFromString(name),
                  type.responds(to: shared),
                  let instance = type.perform(shared)?.takeUnretainedValue() as? NSObject
            else { continue }
            let selector = NSSelectorFromString(selectorName)
            if instance.responds(to: selector) { instance.perform(selector, with: session) }
            return
        }
    }
}

/// A background task around one request, ended once (or when iOS runs out of time).
private final class BackgroundTask: @unchecked Sendable {
    private var id = UIBackgroundTaskIdentifier.invalid

    @MainActor
    func begin() {
        id = UIApplication.shared.beginBackgroundTask(withName: "weldchat.call.decline") { [weak self] in
            MainActor.assumeIsolated { self?.end() }
        }
    }

    @MainActor
    func end() {
        guard id != .invalid else { return }
        UIApplication.shared.endBackgroundTask(id)
        id = .invalid
    }
}

// MARK: - PushKit

extension CallKitService: PKPushRegistryDelegate {
    func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
        let token = pushCredentials.token.map { String(format: "%02x", $0) }.joined()
        UserDefaults.standard.set(token, forKey: Self.tokenKey)
        if let listener = tokenListener {
            Task { @MainActor in listener(token) }
        }
    }

    func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
        UserDefaults.standard.removeObject(forKey: Self.tokenKey)
    }

    func pushRegistry(
        _ registry: PKPushRegistry,
        didReceiveIncomingPushWith payload: PKPushPayload,
        for type: PKPushType,
        completion: @escaping () -> Void
    ) {
        let raw = payload.dictionaryPayload["weldchat"] as? [String: Any] ?? [:]
        let data = raw.compactMapValues { $0 as? String }
        // A ring without `server` is WeldSuite cloud's, sent to the token a
        // 1.x install registered there, for a call this app can't join.
        let fromAServer = !(data["server"] ?? "").trimmingCharacters(in: .whitespaces).isEmpty
        switch CallPayloads.parseCallPush(data) {
        case let .cancel(callID, reason):
            cancel(callID: callID, reason: reason, completion: completion)
        case let .ring(ring) where fromAServer:
            reportIncoming(CallPayloads.nativePayload(ring), completion: completion)
        case .ring, nil:
            reportForeign(completion: completion)
        }
    }
}

// MARK: - CallKit

extension CallKitService: CXProviderDelegate {
    func providerDidReset(_ provider: CXProvider) {
        calls.removeAll()
    }

    func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        guard var call = calls[action.callUUID] else {
            action.fail()
            return
        }
        call.answered = true
        calls[action.callUUID] = call
        configureAudioSession(video: call.payload["callType"] == "video")
        dispatch(.accept(call.payload))
        action.fulfill()
    }

    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        // Not in `calls`: the app ended it (`endFromApp`), nothing to report back.
        if let call = forget(action.callUUID) {
            if call.answered {
                dispatch(.end(call.payload))
            } else {
                let handled = postDecline(token: call.payload["declineToken"], server: call.payload["server"])
                dispatch(.decline(call.payload, handledNatively: handled))
            }
        }
        action.fulfill()
    }

    func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        if let call = calls[action.callUUID] {
            dispatch(.mute(call.payload, muted: action.isMuted))
        }
        action.fulfill()
    }

    func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        notifyWebRTC("audioSessionDidActivate:", audioSession)
    }

    func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        notifyWebRTC("audioSessionDidDeactivate:", audioSession)
    }
}
