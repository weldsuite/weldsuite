import Foundation
import WeldChatAPI
import WeldCore

// The call operations of weldchat.yaml, mapped to the calls' own models here
// and nowhere else, so a change in the generated names stays in this file.

/// A ringing or live call in one of the caller's channels (`listActiveCalls`).
struct ActiveCallSummary: Identifiable, Equatable, Sendable {
    let channelID: String
    let callID: String
    let callType: CallType
    let status: String
    let participantCount: Int
    let initiatorID: String?
    let initiatorName: String?
    /// `dm` for a direct message: only those ring.
    let channelType: String?

    var id: String { callID }
}

/// Someone in a call, as the server lists them.
struct CallParticipantInfo: Equatable, Sendable {
    let userID: String
    let name: String?
    let avatar: String?
    /// Set once they left.
    let leftAt: String?
}

/// A call row (`getCall`, `getActiveCallInChannel`).
struct CallInfo: Equatable, Sendable {
    let id: String
    let channelID: String
    let callType: CallType
    let status: String
    let initiatorID: String?
    let participants: [CallParticipantInfo]
}

/// The person a DM call was with.
struct CallPersonInfo: Equatable, Sendable {
    let userID: String
    let name: String?
    let avatar: String?
}

/// One call of the caller's history (`listCallHistory`).
struct CallHistoryEntry: Identifiable, Equatable, Sendable {
    let id: String
    let channelID: String
    /// `dm` (DMs and group DMs), `public`, `private` or `entity`.
    let channelType: String?
    let channelName: String?
    let callType: CallType
    let status: String
    /// `incoming` or `outgoing`, from the caller's side.
    let direction: String
    /// `ongoing`, `answered`, `missed` or `declined`.
    let outcome: String
    /// DM calls: the person to show; nil for a channel call.
    let counterpart: CallPersonInfo?
    /// DM calls: every member but the caller; more than one in a group DM.
    let otherMembers: [CallPersonInfo]
    /// Seconds, once the call ended.
    let duration: Int?
    let createdAt: String
}

struct CallHistoryPage: Sendable {
    let entries: [CallHistoryEntry]
    /// The next page's cursor; nil on the last page.
    let nextCursor: String?
}

/// What joining a call gives: the video provider's join token.
struct CallJoin: Sendable {
    let callID: String
    let channelID: String?
    /// The call's own type: a start-and-join that joined a running call may differ from the one asked.
    let callType: CallType?
    let authToken: String
    let participants: [CallParticipantInfo]
}

/// The chat-calls endpoints the apps use.
@MainActor
struct CallAPI {
    let env: AppEnvironment

    private func client() throws -> Client {
        guard let api = env.api else { throw APIError(status: nil, code: nil) }
        return Client(serverURL: api.serverURL, transport: api.transport, middlewares: api.middlewares)
    }

    func activeCalls() async throws -> [ActiveCallSummary] {
        do {
            switch try await client().listActiveCalls() {
            case let .ok(ok):
                return try ok.body.json.data.map(Self.summary)
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        } catch {
            throw APIError.from(error)
        }
    }

    /// The channel's live call, or nil.
    func activeCall(in channelID: String) async throws -> CallInfo? {
        do {
            switch try await client().getActiveCallInChannel(path: .init(channelId: channelID)) {
            case let .ok(ok):
                return try ok.body.json.data.map(Self.callInfo)
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        } catch {
            throw APIError.from(error)
        }
    }

    func call(_ callID: String) async throws -> CallInfo? {
        do {
            switch try await client().getCall(path: .init(callId: callID)) {
            case let .ok(ok):
                return try ok.body.json.data.map(Self.callInfo)
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        } catch {
            throw APIError.from(error)
        }
    }

    func history(cursor: String?, limit: Int) async throws -> CallHistoryPage {
        do {
            switch try await client().listCallHistory(query: .init(limit: limit, cursor: cursor)) {
            case let .ok(ok):
                let page = try ok.body.json
                return CallHistoryPage(
                    entries: page.data.map(Self.historyEntry),
                    nextCursor: page.pagination.hasMore ? page.pagination.cursor : nil
                )
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        } catch {
            throw APIError.from(error)
        }
    }

    /// Start a call in the channel and join it; joins the one already running there.
    func startAndJoin(channelID: String, callType: CallType) async throws -> CallJoin {
        let body = Components.Schemas.StartCallInput(
            channelId: channelID,
            callType: callType == .video ? .video : .voice
        )
        do {
            switch try await client().startAndJoinCall(body: .json(body)) {
            case let .ok(ok):
                return Self.started(try ok.body.json.data, channelID: channelID)
            case let .created(created):
                return Self.started(try created.body.json.data, channelID: channelID)
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        } catch {
            throw APIError.from(error)
        }
    }

    func join(_ callID: String) async throws -> CallJoin {
        do {
            switch try await client().joinCall(path: .init(callId: callID)) {
            case let .ok(ok):
                let joined = try ok.body.json.data
                return CallJoin(
                    callID: joined.callId,
                    channelID: joined.channelId,
                    callType: CallType(wire: joined.callType),
                    authToken: joined.authToken,
                    participants: (joined.participants ?? []).map(Self.participant)
                )
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        } catch {
            throw APIError.from(error)
        }
    }

    func leave(_ callID: String) async throws {
        do {
            switch try await client().leaveCall(path: .init(callId: callID)) {
            case .ok:
                return
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        } catch {
            throw APIError.from(error)
        }
    }

    func decline(_ callID: String) async throws {
        do {
            switch try await client().declineCall(path: .init(callId: callID)) {
            case .ok:
                return
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        } catch {
            throw APIError.from(error)
        }
    }

    // MARK: - Mapping

    nonisolated static func summary(_ row: Components.Schemas.ActiveCall) -> ActiveCallSummary {
        ActiveCallSummary(
            channelID: row.channelId,
            callID: row.callId,
            callType: CallType(wire: row.callType),
            status: row.status,
            participantCount: row.participantCount,
            initiatorID: row.initiatorId,
            initiatorName: row.initiatorName,
            channelType: row.channelType
        )
    }

    nonisolated static func callInfo(_ row: Components.Schemas.Call) -> CallInfo {
        CallInfo(
            id: row.id,
            channelID: row.channelId,
            callType: CallType(wire: row.callType),
            status: row.status,
            initiatorID: row.initiatorId,
            participants: (row.participants ?? []).map(participant)
        )
    }

    nonisolated static func participant(_ row: Components.Schemas.CallParticipant) -> CallParticipantInfo {
        CallParticipantInfo(userID: row.userId, name: row.userName, avatar: row.userAvatar, leftAt: row.leftAt)
    }

    nonisolated static func person(_ row: Components.Schemas.CallPerson) -> CallPersonInfo {
        CallPersonInfo(userID: row.userId, name: row.name, avatar: row.avatar)
    }

    nonisolated static func historyEntry(_ row: Components.Schemas.CallHistoryItem) -> CallHistoryEntry {
        CallHistoryEntry(
            id: row.id,
            channelID: row.channelId,
            channelType: row.channelType,
            channelName: row.channelName,
            callType: CallType(wire: row.callType),
            status: row.status,
            direction: row.direction,
            outcome: row.outcome,
            counterpart: row.counterpart.map(person),
            otherMembers: (row.otherMembers ?? []).map(person),
            duration: row.duration,
            createdAt: row.createdAt
        )
    }

    nonisolated static func started(_ row: Components.Schemas.StartedCall, channelID: String) -> CallJoin {
        CallJoin(
            callID: row.callId,
            channelID: channelID,
            callType: row.callType.map { CallType(wire: $0) },
            authToken: row.authToken,
            participants: (row.participants ?? []).map(participant)
        )
    }
}
