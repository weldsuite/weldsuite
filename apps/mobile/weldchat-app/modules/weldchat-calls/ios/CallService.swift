import AVFoundation
import CallKit
import CryptoKit
import Foundation
import PushKit
import UIKit

/// iOS side of the WeldChat incoming-call ring. PushKit receives the ring (a
/// VoIP push, also while the app is not running) and CallKit shows it as a real
/// phone call: the system incoming-call screen, the ringtone, the lock screen,
/// the Phone app's Recents.
///
/// iOS terminates an app that receives a VoIP push without reporting a call to
/// CallKit, and stops delivering them after repeated misses. So every push is
/// reported: a ring that is already over, or a cancel for a call this phone is
/// not showing, is reported and ended in the same breath.
///
/// Everything here runs on the main queue (PushKit and CallKit both deliver
/// there), except the JS hand-off, which is guarded by `lock`.
///
/// China's MIIT does not allow CallKit (App Review guideline 5). On a phone
/// whose region is mainland China none of this runs: no PushKit registry (a
/// VoIP push must be reported to CallKit), no CXProvider, no VoIP token. JS
/// then drops the call token and rings with the in-app screen, and the server
/// sends the ordinary "Incoming call" push instead.
final class CallService: NSObject {
  static let shared = CallService()

  /// Read once per process, so a region change applies from the next launch.
  static let isCallKitAllowed: Bool = Locale.current.region?.identifier != "CN"

  private static let tokenKey = "weldchat.calls.voipToken"
  private static let declineUrlKey = "weldchat.calls.declineUrl"
  /// The server cancels long before; this bounds a ring whose cancel never comes.
  private static let ringTimeout: TimeInterval = 60

  private struct KnownCall {
    var payload: [String: String]
    var answered = false
  }

  /// Lazy so a phone in China never creates one (see `isCallKitAllowed`).
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
  /// Calls that stopped ringing here, so JS cannot ring them again while the
  /// server has not caught up (the foreground poll still sees a declined call
  /// as ringing for a moment).
  private var ended: [UUID: Date] = [:]

  private let lock = NSLock()
  private var pending: [[String: Any]] = []
  private var actionListener: (([String: Any]) -> Void)?
  var tokenListener: ((String) -> Void)?

  private override init() {
    super.init()
  }

  /// Called at launch (WeldChatCallsAppDelegate). PushKit hands over a VoIP push
  /// that woke the app as soon as a registry with a delegate exists.
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

  var voipToken: String? {
    Self.isCallKitAllowed ? UserDefaults.standard.string(forKey: Self.tokenKey) : nil
  }

  /// Persisted: a CallKit Decline on an app that was not running happens before JS does.
  var declineUrl: String? {
    get { UserDefaults.standard.string(forKey: Self.declineUrlKey) }
    set { UserDefaults.standard.set(newValue, forKey: Self.declineUrlKey) }
  }

  // MARK: - JS hand-off

  func setActionListener(_ listener: (([String: Any]) -> Void)?) {
    lock.lock()
    actionListener = listener
    lock.unlock()
  }

  /// Actions taken before JS listened (an Answer that launched the app).
  func takePending() -> [[String: Any]] {
    lock.lock()
    defer { lock.unlock() }
    let out = pending
    pending = []
    return out
  }

  private func dispatch(_ action: String, _ payload: [String: String]) {
    let event: [String: Any] = ["action": action, "payload": payload]
    lock.lock()
    let listener = actionListener
    if listener == nil { pending.append(event) }
    lock.unlock()
    listener?(event)
  }

  // MARK: - Ringing

  /// Same call id, same CallKit UUID: a ring from the push and one from the
  /// app's realtime socket collapse into one call, and a cancel finds its ring
  /// even in a freshly launched process.
  static func uuid(for callId: String) -> UUID {
    var bytes = Array(SHA256.hash(data: Data(callId.utf8)).prefix(16))
    bytes[6] = (bytes[6] & 0x0F) | 0x50
    bytes[8] = (bytes[8] & 0x3F) | 0x80
    return bytes.withUnsafeBufferPointer { NSUUID(uuidBytes: $0.baseAddress!) as UUID }
  }

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

  /// Show a ring in CallKit. From a VoIP push (`completion` is PushKit's) or
  /// from JS (the realtime ring while the app runs).
  func reportIncoming(_ payload: [String: String], completion: (() -> Void)? = nil) {
    guard Self.isCallKitAllowed else {
      completion?()
      return
    }
    let callId = payload["callId"] ?? ""
    let uuid = callId.isEmpty ? UUID() : Self.uuid(for: callId)
    // JS ringing a call CallKit already shows, or one that just stopped here.
    // A push must still report (below).
    if completion == nil, calls[uuid] != nil || recentlyEnded(uuid) { return }

    let expiresAt = Double(payload["expiresAt"] ?? "") ?? .infinity
    let expired = expiresAt < Date().timeIntervalSince1970 * 1000
    let name = (payload["callerName"]).flatMap { $0.isEmpty ? nil : $0 } ?? "WeldChat"
    let update = Self.update(name: name, video: payload["callType"] == "video")

    provider.reportNewIncomingCall(with: uuid, update: update) { [weak self] error in
      DispatchQueue.main.async {
        defer { completion?() }
        // An error: already ringing (the socket beat the push), or iOS refused
        // it (Focus, blocked). Nothing to add either way.
        guard let self, error == nil else { return }
        if callId.isEmpty || expired || self.recentlyEnded(uuid) {
          // iOS insists every VoIP push shows a call; one already over (a late
          // push, or a ring this phone already answered or declined) ends at once.
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

  /// The server says the call stopped ringing for this user.
  private func cancel(_ payload: [String: String], completion: @escaping () -> Void) {
    let uuid = Self.uuid(for: payload["callId"] ?? "")
    let reason = Self.endReason(payload["reason"])
    // Reporting the call's own UUID satisfies the report-every-push rule: when
    // CallKit knows the call it fails with "already exists" and changes nothing.
    provider.reportNewIncomingCall(with: uuid, update: Self.update(name: "WeldChat", video: false)) { [weak self] error in
      DispatchQueue.main.async {
        defer { completion() }
        guard let self else { return }
        if error == nil {
          // Nothing rang here for this call: take the placeholder down at once.
          self.forget(uuid)
          self.provider.reportCall(with: uuid, endedAt: nil, reason: reason)
        } else if let call = self.calls[uuid], !call.answered {
          self.forget(uuid)
          self.provider.reportCall(with: uuid, endedAt: nil, reason: reason)
        }
        // Answered on this phone: the cancel is for the user's other devices.
      }
    }
  }

  /// JS is done with the call (declined in-app, hung up, or it ended): take it
  /// out of CallKit without reporting anything back to JS.
  func endFromApp(_ callId: String) {
    let uuid = Self.uuid(for: callId)
    guard let call = forget(uuid) else { return }
    if call.answered {
      controller.request(CXTransaction(action: CXEndCallAction(call: uuid))) { [weak self] error in
        if error != nil {
          DispatchQueue.main.async { self?.provider.reportCall(with: uuid, endedAt: nil, reason: .remoteEnded) }
        }
      }
    } else {
      provider.reportCall(with: uuid, endedAt: nil, reason: .remoteEnded)
    }
  }

  // MARK: - Decline without a session

  /// POST the ring token to chat-api's `/public/chat-calls/decline`. Returns
  /// false when there is no token or URL to do it with (JS declines then).
  private func postDecline(token: String?) -> Bool {
    guard let token, !token.isEmpty,
          let urlString = declineUrl, let url = URL(string: urlString),
          let body = try? JSONSerialization.data(withJSONObject: ["token": token]) else { return false }
    var request = URLRequest(url: url, timeoutInterval: 8)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = body

    // Keep the app alive for the request when it was woken just for this ring.
    let app = UIApplication.shared
    var task = UIBackgroundTaskIdentifier.invalid
    let finish = {
      guard task != .invalid else { return }
      app.endBackgroundTask(task)
      task = .invalid
    }
    task = app.beginBackgroundTask(withName: "weldchat.call.decline") { finish() }
    URLSession.shared.dataTask(with: request) { _, _, _ in
      DispatchQueue.main.async { finish() }
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

  /// CallKit owns the audio session during a call; WebRTC must be told when it
  /// is handed over or the call stays silent. Looked up at runtime so this pod
  /// does not link WebRTC itself.
  private func notifyWebRTC(_ selectorName: String, _ session: AVAudioSession) {
    let sharedInstance = NSSelectorFromString("sharedInstance")
    guard let type: AnyObject = NSClassFromString("RTCAudioSession"),
          type.responds(to: sharedInstance),
          let shared = type.perform(sharedInstance)?.takeUnretainedValue() as? NSObject
    else { return }
    let selector = NSSelectorFromString(selectorName)
    if shared.responds(to: selector) { shared.perform(selector, with: session) }
  }
}

// MARK: - PushKit

extension CallService: PKPushRegistryDelegate {
  func pushRegistry(_ registry: PKPushRegistry, didUpdate credentials: PKPushCredentials, for type: PKPushType) {
    let token = credentials.token.map { String(format: "%02x", $0) }.joined()
    UserDefaults.standard.set(token, forKey: Self.tokenKey)
    tokenListener?(token)
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
    if data["notificationType"] == "chat_call_cancel" {
      cancel(data, completion: completion)
    } else {
      reportIncoming(data, completion: completion)
    }
  }
}

// MARK: - CallKit

extension CallService: CXProviderDelegate {
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
    dispatch("accept", call.payload)
    action.fulfill()
  }

  func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
    // Not in `calls`: JS ended it (endFromApp), nothing to report back.
    if let call = forget(action.callUUID) {
      if call.answered {
        dispatch("end", call.payload)
      } else {
        var payload = call.payload
        payload["handledNatively"] = postDecline(token: call.payload["declineToken"]) ? "true" : "false"
        dispatch("decline", payload)
      }
    }
    action.fulfill()
  }

  func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
    if let call = calls[action.callUUID] {
      var payload = call.payload
      payload["muted"] = action.isMuted ? "true" : "false"
      dispatch("mute", payload)
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
