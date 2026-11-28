import CryptoKit
import Foundation
import WeldCore

// What the calls and the rest of the app share (PARITY.md, "Interfaces
// between chat and calls"), and the rules of the calls that need no screen:
// pure, so they are unit-tested.

enum CallType: String, Sendable {
    case voice, video

    /// The server's `callType`: anything but `video` is a voice call.
    init(wire: String?) {
        self = wire == "video" ? .video : .voice
    }
}

/// Who a call is with, for the call screen.
struct CallPeer: Equatable, Sendable {
    var name: String?
    var avatar: String?
    /// A 1:1 (or group) conversation: the "calling" screen with ringback.
    var isDirect = false

    init(name: String? = nil, avatar: String? = nil, isDirect: Bool = false) {
        self.name = name
        self.avatar = avatar
        self.isDirect = isDirect
    }
}

/// A call running in a channel, for its "Join" button.
struct ActiveChannelCall: Equatable, Sendable {
    let callID: String
    let callType: CallType
}

/// A joined call: what the call screen shows and the room joins with.
struct CallSession: Equatable, Sendable {
    let callID: String
    let channelID: String
    let callType: CallType
    /// The video provider's join token (LiveKit's on the Kubernetes editions).
    let authToken: String
    var isDirect: Bool
    var peerName: String?
    var peerAvatar: String?
    /// Joined by answering a ring: the caller is already in the room, so no ringback.
    var answered: Bool
}

/// A call ringing for this person.
struct IncomingCall: Equatable, Sendable {
    let callID: String
    let channelID: String
    let callType: CallType
    /// Nil when the ring didn't say who calls: shown as "Incoming call".
    let callerName: String?
    let callerAvatar: String?
    /// Declines the ring without a session (`/public/chat-calls/decline`).
    var declineToken: String?
    /// When the ring stops, in milliseconds since 1970.
    var expiresAt: Double?
    /// The install the ring comes from (`data.server`).
    var server: String?
}

/// The server's native call push (`chat_call_ring` / `chat_call_cancel`).
enum CallPush: Equatable, Sendable {
    case ring(IncomingCall)
    case cancel(callID: String, reason: String)
}

/// Rings out of push and realtime payloads (ports of `lib/call-push.ts` and
/// `lib/incoming-call-bridge.ts`).
enum CallPayloads {
    static let ringType = "chat_call_ring"
    static let cancelType = "chat_call_cancel"
    /// The ordinary push the server sends for a ring (to phones without a call token).
    static let incomingType = "chat_incoming_call"

    /// An id the server could have made: letters, digits, `_` and `-`.
    static func isID(_ text: String) -> Bool {
        !text.isEmpty && text.unicodeScalars.allSatisfy { scalar in
            (scalar.value >= 48 && scalar.value <= 57) // 0-9
                || (scalar.value >= 65 && scalar.value <= 90) // A-Z
                || (scalar.value >= 97 && scalar.value <= 122) // a-z
                || scalar == "_" || scalar == "-"
        }
    }

    private static func text(_ value: String?) -> String {
        (value ?? "").trimmingCharacters(in: .whitespaces)
    }

    private static func nonEmpty(_ value: String?) -> String? {
        let trimmed = text(value)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// The chat channel of a `/weldchat/<id>` or `/weldchat/dm/<id>` action URL.
    static func channelID(fromActionURL actionURL: String?) -> String? {
        guard let actionURL, let range = actionURL.range(of: "/weldchat/") else { return nil }
        var rest = actionURL[range.upperBound...]
        if rest.hasPrefix("dm/") { rest = rest.dropFirst(3) }
        let id = rest.prefix { $0 != "/" && $0 != "?" && $0 != "#" }
        return id.isEmpty ? nil : String(id)
    }

    /// `channelId` is renamed `chatChannelId` in push data (Android reads
    /// `channelId` as its notification channel); a ring may carry either.
    private static func channel(_ data: [String: String]) -> String {
        nonEmpty(data["chatChannelId"]) ?? nonEmpty(data["channelId"]) ?? channelID(fromActionURL: data["actionUrl"]) ?? ""
    }

    /// The VoIP push's `weldchat` data: a ring or a cancel, or nil for anything else.
    static func parseCallPush(_ data: [String: String]) -> CallPush? {
        let callID = nonEmpty(data["callId"]) ?? text(data["entityId"])
        guard isID(callID) else { return nil }
        if data["notificationType"] == cancelType {
            return .cancel(callID: callID, reason: nonEmpty(data["reason"]) ?? "ended")
        }
        guard data["notificationType"] == ringType else { return nil }
        let channelID = channel(data)
        guard isID(channelID) else { return nil }
        return .ring(IncomingCall(
            callID: callID,
            channelID: channelID,
            callType: CallType(wire: data["callType"]),
            callerName: nonEmpty(data["callerName"]),
            callerAvatar: nonEmpty(data["callerAvatar"]),
            declineToken: nonEmpty(data["declineToken"]),
            expiresAt: nonEmpty(data["expiresAt"]).flatMap(Double.init),
            server: nonEmpty(data["server"])
        ))
    }

    /// A tapped (or still shown) "Incoming call" notification.
    static func incoming(fromNotification data: [String: String]) -> IncomingCall? {
        guard data["notificationType"] == incomingType else { return nil }
        let callID = text(data["entityId"])
        guard isID(callID) else { return nil }
        let channelID = channel(data)
        guard !channelID.isEmpty else { return nil }
        return IncomingCall(
            callID: callID,
            channelID: channelID,
            callType: CallType(wire: data["callType"]),
            callerName: nonEmpty(data["callerName"]),
            callerAvatar: nonEmpty(data["callerAvatar"]),
            declineToken: nonEmpty(data["declineToken"]),
            server: nonEmpty(data["server"])
        )
    }

    /// The realtime `call_incoming` event on `chat.user.<id>`.
    static func incoming(fromEvent data: [String: Any]) -> IncomingCall? {
        guard let callID = data["callId"] as? String, isID(callID) else { return nil }
        let channelID = data["channelId"] as? String ?? ""
        return IncomingCall(
            callID: callID,
            channelID: channelID,
            callType: CallType(wire: data["callType"] as? String),
            callerName: nonEmpty(data["callerName"] as? String),
            callerAvatar: nonEmpty(data["callerAvatar"] as? String)
        )
    }

    /// A ring as CallKit keeps it, keyed as the native payload always was.
    static func nativePayload(_ incoming: IncomingCall) -> [String: String] {
        var payload: [String: String] = [
            "callId": incoming.callID,
            "channelId": incoming.channelID,
            "callType": incoming.callType.rawValue,
        ]
        if let name = incoming.callerName { payload["callerName"] = name }
        if let avatar = incoming.callerAvatar { payload["callerAvatar"] = avatar }
        if let token = incoming.declineToken { payload["declineToken"] = token }
        if let expiresAt = incoming.expiresAt { payload["expiresAt"] = String(format: "%.0f", expiresAt) }
        if let server = incoming.server { payload["server"] = server }
        return payload
    }

    /// The ring back out of CallKit's payload (an Answer or a Decline).
    static func incoming(fromNative payload: [String: String]) -> IncomingCall? {
        let callID = text(payload["callId"])
        let channelID = channel(payload)
        guard isID(callID), isID(channelID) else { return nil }
        return IncomingCall(
            callID: callID,
            channelID: channelID,
            callType: CallType(wire: payload["callType"]),
            callerName: nonEmpty(payload["callerName"]),
            callerAvatar: nonEmpty(payload["callerAvatar"]),
            declineToken: nonEmpty(payload["declineToken"]),
            expiresAt: nonEmpty(payload["expiresAt"]).flatMap(Double.init),
            server: nonEmpty(payload["server"])
        )
    }
}

/// Same call id, same CallKit UUID: a ring from the VoIP push and one from
/// the realtime socket collapse into one call, and a cancel finds its ring
/// even in a freshly launched process.
func callKitUUID(for callID: String) -> UUID {
    var bytes = Array(SHA256.hash(data: Data(callID.utf8)).prefix(16))
    bytes[6] = (bytes[6] & 0x0F) | 0x50
    bytes[8] = (bytes[8] & 0x3F) | 0x80
    return UUID(uuid: (
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
        bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
    ))
}

/// The call screens' wording and the calls' decisions.
enum CallRules {
    /// The LiveKit server from `/config.json` (`videoProvider`, `videoUrl`):
    /// nil when the server runs another provider (RealtimeKit, WeldSuite
    /// cloud) or names no usable URL, so the call can't be joined.
    static func liveKitURL(provider: String?, url: String?) -> String? {
        guard provider?.trimmingCharacters(in: .whitespaces).lowercased() == "livekit" else { return nil }
        var server = (url ?? "").trimmingCharacters(in: .whitespaces)
        while server.hasSuffix("/") { server.removeLast() }
        let lower = server.lowercased()
        let schemes = ["wss://", "ws://", "https://", "http://"]
        guard schemes.contains(where: { lower.hasPrefix($0) && lower.count > $0.count }) else { return nil }
        return server
    }

    /// A DM ring the person may have missed while the app was away: rung by
    /// someone else, nobody but the caller in it yet, still ringing or live.
    static func recoverableRing(_ calls: [ActiveCallSummary], selfID: String) -> ActiveCallSummary? {
        calls.first { call in
            guard call.channelType == "dm" else { return false }
            guard let initiator = call.initiatorID, initiator != selfID else { return false }
            guard call.participantCount <= 1 else { return false }
            return call.status == "ringing" || call.status == "active"
        }
    }

    /// Who you talk to on an answered ring: the caller in the join answer
    /// (already in the room), else what the ring said.
    static func peerOfAnsweredCall(
        callerName: String?,
        callerAvatar: String?,
        participants: [CallParticipantInfo],
        selfID: String?
    ) -> (name: String?, avatar: String?) {
        let caller = participants.first { $0.userID != selfID && $0.leftAt == nil }
        let name = caller?.name.flatMap { $0.isEmpty ? nil : $0 } ?? callerName
        let avatar = caller?.avatar.flatMap { $0.isEmpty ? nil : $0 } ?? callerAvatar
        return (name, avatar)
    }

    static func isDM(_ entry: CallHistoryEntry) -> Bool {
        entry.channelType == "dm"
    }

    static func isGroupDM(_ entry: CallHistoryEntry) -> Bool {
        isDM(entry) && entry.otherMembers.count > 1
    }

    /// The person (DM), the people (group DM) or `#channel` the call was with.
    static func title(_ entry: CallHistoryEntry) -> String {
        if isGroupDM(entry) {
            return entry.otherMembers.map { nonEmpty($0.name) ?? ChatStrings.callsUnknown }.joined(separator: ", ")
        }
        if isDM(entry) {
            return nonEmpty(entry.counterpart?.name) ?? nonEmpty(entry.channelName) ?? ChatStrings.callsUnknown
        }
        return "#\(entry.channelName ?? "")"
    }

    /// "Missed" / "No answer" / "Declined" / "Incoming" / "Outgoing" / "Ongoing".
    static func outcomeLabel(_ entry: CallHistoryEntry) -> String {
        let incoming = entry.direction == "incoming"
        switch entry.outcome {
        case "ongoing": return ChatStrings.callsOngoing
        case "missed": return incoming ? ChatStrings.callsMissed : ChatStrings.callsNoAnswer
        case "declined": return ChatStrings.callsDeclined
        default: return incoming ? ChatStrings.callsIncoming : ChatStrings.callsOutgoing
        }
    }

    /// Red like a phone's recents: a call that rang you and you never picked up.
    static func isMissedIncoming(_ entry: CallHistoryEntry) -> Bool {
        entry.outcome == "missed" && entry.direction == "incoming"
    }

    /// "Missed · Voice call", "Outgoing · Video call · 1:05".
    static func subtitle(_ entry: CallHistoryEntry) -> String {
        var parts = [outcomeLabel(entry), entry.callType == .video ? ChatStrings.callsVideoCall : ChatStrings.callsVoiceCall]
        if entry.outcome == "answered", let seconds = entry.duration, seconds > 0 {
            parts.append(duration(seconds))
        }
        return joined(parts)
    }

    /// Parts of a line joined with the strings' own " · ".
    static func joined(_ parts: [String]) -> String {
        guard var line = parts.first else { return "" }
        for part in parts.dropFirst() {
            line = ChatStrings.callBarTitle(name: line, status: part)
        }
        return line
    }

    /// 65 → "1:05", 3725 → "1:02:05".
    static func duration(_ seconds: Int) -> String {
        let total = max(0, seconds)
        let hours = total / 3600
        let minutes = (total % 3600) / 60
        let rest = total % 60
        if hours > 0 { return String(format: "%d:%02d:%02d", hours, minutes, rest) }
        return String(format: "%d:%02d", minutes, rest)
    }

    /// The running call's length: "00:42", "12:05", "75:00".
    static func timer(_ seconds: Int) -> String {
        let total = max(0, seconds)
        return String(format: "%02d:%02d", total / 60, total % 60)
    }

    /// Phone-style recents time: the time today, "Yesterday", the weekday this week, else the date.
    static func time(_ date: Date, now: Date = Date(), calendar: Calendar = .current) -> String {
        if calendar.isDate(date, inSameDayAs: now) { return date.formatted(date: .omitted, time: .shortened) }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) {
            return CoreStrings.commonYesterday
        }
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)).day ?? 0
        if days > 0, days < 7 { return date.formatted(.dateTime.weekday(.wide)) }
        return date.formatted(date: .numeric, time: .omitted)
    }

    /// Under the name while the room is being joined: "Calling Ann…" for a
    /// direct call you make, else "Connecting…".
    static func connectingLabel(isDirect: Bool, answered: Bool, peerName: String?) -> String {
        guard isDirect, !answered else { return ChatStrings.callConnecting }
        if let name = nonEmpty(peerName) { return ChatStrings.callCalling(name: name) }
        return ChatStrings.callCallingSomeone
    }

    /// Under the name once in the room: Reconnecting, the timer, or Ringing / Connecting.
    static func statusLabel(answered: Bool, reconnecting: Bool, peerJoined: Bool, seconds: Int) -> String {
        if reconnecting { return ChatStrings.callReconnecting }
        if peerJoined { return timer(seconds) }
        return answered ? ChatStrings.callConnecting : ChatStrings.callRinging
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespaces), !value.isEmpty else { return nil }
        return value
    }
}
