import Foundation
import WeldCore
import WeldDeskAPI

/// A file the agent picked, read into memory (at most 10 MB).
struct PickedFile {
    let name: String
    let contentType: String
    let data: Data
}

/// WeldDesk's calls. The generated API types are mapped to the app's own
/// models here and nowhere else, so a rename in the generated code stays in
/// this file.
@MainActor
final class DeskStore {
    private let env: AppEnvironment
    /// The roster, kept for the signed-in person in one workspace: members rarely change.
    private var roster: (key: String, members: [DeskMember])?
    private var roomBase: URL?

    init(env: AppEnvironment) {
        self.env = env
    }

    private func client() throws -> Client {
        guard let api = env.api else { throw APIError(status: nil, code: nil) }
        return Client(serverURL: api.serverURL, transport: api.transport, middlewares: api.middlewares)
    }

    func inbox(_ request: InboxRequest, cursor: String?) async throws -> InboxPage {
        do {
            let output = try await client().listDeskConversations(query: .init(
                state: request.state,
                assigneeId: request.assigneeID,
                unassigned: request.unassigned,
                q: request.q,
                sort: request.sort,
                cursor: cursor,
                limit: DeskLogic.pageSize
            ))
            switch output {
            case let .ok(ok):
                let page = try ok.body.json
                return InboxPage(items: page.data.map { Self.conversation($0) }, hasMore: page.pagination.hasMore, cursor: page.pagination.cursor)
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        } catch {
            throw APIError.from(error)
        }
    }

    func conversation(_ id: String) async throws -> ConversationDetail {
        do {
            switch try await client().getDeskConversation(path: .init(id: id), query: .init(include: "messages")) {
            case let .ok(ok):
                return Self.detail(try ok.body.json.data)
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        } catch {
            throw APIError.from(error)
        }
    }

    /// A reply or a note, with files uploaded to the conversation first.
    func reply(_ id: String, kind: MessageKind, body: String, attachments: [DeskAttachment]) async throws -> ConversationChange {
        let text = body.trimmingCharacters(in: .whitespacesAndNewlines)
        let input = Components.Schemas.DeskReplyInput(
            kind: kind == .note ? .note : .message,
            body: text.isEmpty ? nil : text,
            attachments: attachments.isEmpty ? nil : attachments.map { Self.attachmentInput($0) }
        )
        do {
            switch try await client().replyToDeskConversation(path: .init(id: id), body: .json(input)) {
            case let .created(created):
                return Self.change(try created.body.json.data)
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        } catch {
            throw APIError.from(error)
        }
    }

    func manage(_ id: String, action: ManageAction) async throws -> ConversationChange {
        let input: Components.Schemas.DeskManageInput
        switch action {
        case .close: input = .init(action: .close)
        case .reopen: input = .init(action: .open)
        // Without an assignee the server unassigns.
        case let .assign(assignee): input = .init(action: .assign, assigneeId: assignee)
        }
        do {
            switch try await client().manageDeskConversation(path: .init(id: id), body: .json(input)) {
            case let .ok(ok):
                return Self.change(try ok.body.json.data)
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        } catch {
            throw APIError.from(error)
        }
    }

    /// Active internal members, for the assignee picker; loaded once per person and workspace unless `force`.
    func members(force: Bool = false) async throws -> [DeskMember] {
        let key = rosterKey
        if !force, let roster, roster.key == key { return roster.members }
        do {
            switch try await client().listTeamMembers(query: .init(memberType: "INTERNAL", status: "ACTIVE", limit: 100)) {
            case let .ok(ok):
                let members = try ok.body.json.data.compactMap { member in
                    DeskLogic.member(userID: member.userId, name: member.name, email: member.email, picture: member.picture)
                }
                roster = (key, members)
                return members
            case let .default(status, response):
                throw APIError(status: status, code: try? response.body.json.error.code)
            }
        } catch {
            throw APIError.from(error)
        }
    }

    /// The roster already loaded for this person and workspace, if any.
    var cachedMembers: [DeskMember]? {
        guard let roster, roster.key == rosterKey else { return nil }
        return roster.members
    }

    /// Forget the roster (another workspace).
    func clear() {
        roster = nil
    }

    private var rosterKey: String {
        "\(env.session?.person?.id ?? ""):\(env.session?.activeWorkspaceID ?? "")"
    }

    /// Upload a reply's file to the conversation. `multipart/form-data`,
    /// which the OpenAPI contract can't describe (see `welddesk.yaml`), so
    /// it's sent here with the headers the API client adds to every call.
    func upload(_ conversationID: String, file: PickedFile) async throws -> DeskAttachment {
        let url = env.serverURL
            .appendingPathComponent("api/desk/conversations")
            .appendingPathComponent(conversationID)
            .appendingPathComponent("attachments")
        let boundary = "weld-\(UUID().uuidString)"
        let body = Self.multipart(file, boundary: boundary)
        let token = await env.session?.token()
        var (data, status) = try await send(url: url, body: body, boundary: boundary, token: token)
        if status == 401, let fresh = await env.session?.refreshedToken() {
            (data, status) = try await send(url: url, body: body, boundary: boundary, token: fresh)
        }
        guard status == 201 || status == 200 else {
            let code = (try? JSONDecoder().decode(Components.Schemas.ErrorResponse.self, from: data))?.error.code
            throw APIError(status: status, code: code)
        }
        guard let uploaded = try? JSONDecoder().decode(Components.Schemas.DeskUploadedAttachmentResponse.self, from: data),
              let attachment = Self.attachment(uploaded.data)
        else { throw APIError(status: status, code: nil) }
        return attachment
    }

    private func send(url: URL, body: Data, boundary: String, token: String?) async throws -> (Data, Int) {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(env.app.code, forHTTPHeaderField: "X-Weld-App")
        if let workspace = env.session?.activeWorkspaceID { request.setValue(workspace, forHTTPHeaderField: "X-Weld-Workspace") }
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        do {
            let (data, response) = try await URLSession.shared.upload(for: request, from: body)
            return (data, (response as? HTTPURLResponse)?.statusCode ?? 0)
        } catch {
            throw APIError(status: nil, code: nil)
        }
    }

    /// One `file` part, as the server reads it.
    nonisolated static func multipart(_ file: PickedFile, boundary: String) -> Data {
        let safeName = file.name.replacingOccurrences(of: "\"", with: "_").replacingOccurrences(of: "\r", with: "").replacingOccurrences(of: "\n", with: "")
        var body = Data()
        body.append(Data("--\(boundary)\r\n".utf8))
        body.append(Data("Content-Disposition: form-data; name=\"file\"; filename=\"\(safeName)\"\r\n".utf8))
        body.append(Data("Content-Type: \(file.contentType)\r\n\r\n".utf8))
        body.append(file.data)
        body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        return body
    }

    /// The realtime service's base URL (the server's `realtimeUrl`), for a
    /// conversation's room. The core keeps it to itself, so it's read from
    /// the server's `/config.json` (cached on the phone) once.
    func realtimeRoomBase() async -> URL {
        if let roomBase { return roomBase }
        var configured: String?
        if case let .loaded(config, _) = await ServerConfigLoader().load(env.serverURL) {
            configured = config.realtimeUrl
        }
        let base = DeskLogic.realtimeBase(configured, server: env.serverURL)
        roomBase = base
        return base
    }

    // MARK: - Mapping

    nonisolated static func conversation(_ item: Components.Schemas.DeskConversation) -> DeskConversation {
        DeskConversation(
            id: item.id,
            number: item.conversationNumber,
            title: item.title,
            state: ConversationState(server: item.state),
            channel: DeskChannel(server: item.channel),
            channelValue: item.channel,
            visitorID: item.visitorId,
            name: item.name,
            email: item.email,
            assigneeID: item.assigneeId,
            waitingSince: WeldDate.parse(item.waitingSince),
            lastMessageAt: WeldDate.parse(item.lastMessageAt),
            updatedAt: WeldDate.parse(item.updatedAt),
            lastMessagePreview: item.lastMessagePreview
        )
    }

    /// The thread: the conversation (`allOf`'s first part) and its messages.
    nonisolated static func detail(_ item: Components.Schemas.DeskConversationDetail) -> ConversationDetail {
        ConversationDetail(conversation: conversation(item.value1), messages: item.value2.messages.map { message($0) })
    }

    nonisolated static func message(_ item: Components.Schemas.DeskMessage) -> DeskMessage {
        DeskMessage(
            id: item.id,
            createdAt: WeldDate.parse(item.createdAt),
            conversationID: item.conversationId,
            kind: MessageKind(server: item.kind),
            body: item.body,
            authorType: AuthorType(server: item.authorType),
            authorID: item.authorId,
            attachments: (item.attachments ?? []).compactMap { attachment($0) },
            eventType: item.metadata?.value1.eventType,
            rating: item.metadata?.value1.rating
        )
    }

    nonisolated static func change(_ item: Components.Schemas.DeskConversationChange) -> ConversationChange {
        ConversationChange(conversation: conversation(item.conversation), message: message(item.message))
    }

    /// An attachment without a URL can't be shown or opened, so it's left out.
    nonisolated static func attachment(_ item: Components.Schemas.DeskMessageAttachment) -> DeskAttachment? {
        guard let url = item.url, !url.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
        return DeskAttachment(name: item.name, url: url, contentType: item.contentType, size: item.filesize, width: item.width, height: item.height)
    }

    nonisolated static func attachmentInput(_ item: DeskAttachment) -> Components.Schemas.DeskMessageAttachment {
        Components.Schemas.DeskMessageAttachment(
            name: item.name,
            url: item.url,
            contentType: item.contentType,
            filesize: item.size ?? 0,
            width: item.width,
            height: item.height
        )
    }

    /// A `desk_message` hub event's record, when it is one.
    nonisolated static func message(fromEvent data: Data) -> DeskMessage? {
        (try? JSONDecoder().decode(Components.Schemas.DeskMessage.self, from: data)).map { message($0) }
    }

    /// A `desk_conversation` hub event's record, when it is one.
    nonisolated static func conversation(fromEvent data: Data) -> DeskConversation? {
        (try? JSONDecoder().decode(Components.Schemas.DeskConversation.self, from: data)).map { conversation($0) }
    }
}
