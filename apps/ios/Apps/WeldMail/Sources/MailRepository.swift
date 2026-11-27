import Foundation
import WeldCore
import WeldMailAPI

/// A send the server refused, with what it said about why: the composer turns
/// it into words with `SendErrors`. `status` nil: the server wasn't reached.
struct SendFailure: Error {
    let status: Int?
    let code: String?
    let message: String?
    let details: SendErrorDetails

    var isNetwork: Bool { status == nil }
}

/// The WeldMail API for the active workspace. The generated types are mapped
/// to the app's own (`MailModels.swift`) here and nowhere else.
@MainActor
final class MailRepository {
    /// Messages per request; more load as the list nears its end.
    nonisolated static let pageSize = 50

    private let env: AppEnvironment

    init(env: AppEnvironment) {
        self.env = env
    }

    private func client() throws -> Client {
        guard let api = env.api else { throw APIError(status: nil, code: nil) }
        return Client(serverURL: api.serverURL, transport: api.transport, middlewares: api.middlewares)
    }

    /// Runs a call; whatever it throws comes out as an `APIError`.
    private func call<T>(_ body: () async throws -> T) async throws -> T {
        do {
            return try await body()
        } catch let error as APIError {
            throw error
        } catch {
            throw APIError.from(error)
        }
    }

    /// Whether a failure means the server wasn't reached.
    nonisolated static func isNetwork(_ error: Error) -> Bool {
        if let api = error as? APIError { return api.isNetwork }
        if let send = error as? SendFailure { return send.isNetwork }
        return error is URLError
    }

    // MARK: Mailboxes

    /// The workspace's mailboxes the person may open.
    func accounts() async throws -> [MailAccount] {
        try await call {
            switch try await client().listMailAccounts(query: .init(limit: 100)) {
            case let .ok(ok): return try ok.body.json.data.map(Self.account)
            case let .default(status, response): throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    /// Mailboxes in the person's other workspaces, for the mailbox menu; empty when that fails.
    func otherWorkspaceAccounts(activeWorkspace: String) async -> [MailAccount] {
        let groups: [Components.Schemas.MailboxGroup]
        do {
            groups = try await call {
                switch try await client().listMailboxes() {
                case let .ok(ok): return try ok.body.json.data
                case let .default(status, response): throw APIError(status: status, code: try? response.body.json.error.code)
                }
            }
        } catch {
            return []
        }
        return groups.filter { $0.workspaceId != activeWorkspace }.flatMap { group in
            group.accounts.map { account in
                MailAccount(
                    id: account.id,
                    email: account.email,
                    displayName: account.displayName,
                    isDefault: account.isDefault == true,
                    isActive: account.status == "active",
                    workspaceID: group.workspaceId,
                    workspaceName: group.workspaceName
                )
            }
        }
    }

    func labels(accountID: String?) async throws -> [LabelRow] {
        try await call {
            switch try await client().listLabels(query: .init(accountId: accountID)) {
            case let .ok(ok):
                return try ok.body.json.data.map {
                    LabelRow(id: $0.id, name: $0.name, slug: $0.slug, color: $0.color, isSystem: $0.isSystem == true, count: $0.messageCount)
                }
            case let .default(status, response): throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    func createLabel(accountID: String, name: String, color: String?) async throws {
        try await call {
            switch try await client().createLabel(body: .json(.init(accountId: accountID, name: name, color: color, aiEnabled: false))) {
            case .created: return
            case let .default(status, response): throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    // MARK: Messages

    func messages(
        accountID: String?,
        label: String?,
        search: String? = nil,
        unreadOnly: Bool? = nil,
        withAttachments: Bool? = nil,
        limit: Int = MailRepository.pageSize,
        cursor: String? = nil
    ) async throws -> MessagePage {
        let query = search?.trimmingCharacters(in: .whitespaces)
        return try await call {
            let output = try await client().listMessages(query: .init(
                accountId: accountID,
                label: label,
                search: query?.isEmpty == false ? query : nil,
                isRead: unreadOnly.map { String(!$0) },
                hasAttachments: withAttachments.map { String($0) },
                limit: limit,
                cursor: cursor
            ))
            switch output {
            case let .ok(ok):
                let list = try ok.body.json
                let next = list.pagination.hasMore ? list.pagination.cursor : nil
                return MessagePage(messages: list.data.map(Self.message), cursor: next)
            case let .default(status, response): throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    func stats(accountID: String?) async throws -> MessageStats {
        try await call {
            switch try await client().messageStats(query: .init(accountId: accountID)) {
            case let .ok(ok):
                let stats = try ok.body.json.data
                return MessageStats(unread: stats.unread, inboxUnread: stats.inboxUnread, drafts: stats.drafts)
            case let .default(status, response): throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    func message(_ id: String) async throws -> MailMessage {
        try await call {
            switch try await client().getMessage(path: .init(messageId: id)) {
            case let .ok(ok): return Self.message(try ok.body.json.data)
            case let .default(status, response): throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    /// The conversation, oldest first.
    func thread(_ id: String) async throws -> [MailMessage] {
        try await call {
            switch try await client().getThread(path: .init(messageId: id)) {
            case let .ok(ok): return try ok.body.json.data.messages.map(Self.message)
            case let .default(status, response): throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    func update(_ id: String, patch: FlagPatch) async throws {
        try await call {
            let body = Components.Schemas.UpdateMessageInput(isRead: patch.isRead, isStarred: patch.isStarred, isSpam: patch.isSpam, isImportant: patch.isImportant)
            switch try await client().updateMessage(path: .init(messageId: id), body: .json(body)) {
            case .ok: return
            case let .default(status, response): throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    func delete(_ id: String) async throws {
        try await call {
            switch try await client().deleteMessage(path: .init(messageId: id)) {
            case .noContent: return
            case let .default(status, response): throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    private func addLabels(_ id: String, _ labels: [String]) async throws -> [String] {
        try await call {
            switch try await client().addMessageLabels(path: .init(messageId: id), body: .json(.init(labels: labels))) {
            case let .ok(ok): return try ok.body.json.data.labels
            case let .default(status, response): throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    private func removeLabels(_ id: String, _ labels: [String]) async throws -> [String] {
        try await call {
            switch try await client().removeMessageLabels(path: .init(messageId: id), body: .json(.init(labels: labels))) {
            case let .ok(ok): return try ok.body.json.data.labels
            case let .default(status, response): throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    /// Out of the inbox into the archive.
    func archive(_ id: String) async throws {
        _ = try await addLabels(id, [SystemLabel.archive.slug])
        _ = try await removeLabels(id, [SystemLabel.inbox.slug])
    }

    /// Adds and removes labels; the message's labels after.
    func changeLabels(_ id: String, add: [String], remove: [String], current: [String]) async throws -> [String] {
        var labels = current
        if !add.isEmpty { labels = try await addLabels(id, add) }
        if !remove.isEmpty { labels = try await removeLabels(id, remove) }
        return labels
    }

    func snooze(accountID: String, id: String, until: String) async throws {
        try await call {
            switch try await client().snoozeMessage(path: .init(accountId: accountID, messageId: id), body: .json(.init(until: until))) {
            case .ok: return
            case let .default(status, response): throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    func unsnooze(accountID: String, id: String) async throws {
        try await call {
            switch try await client().unsnoozeMessage(path: .init(accountId: accountID, messageId: id)) {
            case .ok: return
            case let .default(status, response): throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    // MARK: Composing

    func createDraft(accountID: String, to: [String], cc: [String], bcc: [String], subject: String, body: String, html: Bool) async throws -> String {
        let input = Components.Schemas.CreateDraftInput(
            accountId: accountID,
            to: to.isEmpty ? nil : to,
            cc: cc.isEmpty ? nil : cc,
            bcc: bcc.isEmpty ? nil : bcc,
            subject: subject.isEmpty ? nil : subject,
            body: html || body.isEmpty ? nil : body,
            htmlBody: html && !body.isEmpty ? body : nil
        )
        return try await call {
            switch try await client().createDraft(body: .json(input)) {
            case let .created(created): return try created.body.json.data.id
            case let .default(status, response): throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    func deleteDraft(_ id: String) async throws {
        try await call {
            switch try await client().deleteDraft(path: .init(draftId: id)) {
            case .noContent: return
            case let .default(status, response): throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    /// Sends now. A refusal is a `SendFailure` with the server's code and
    /// details; offline too, with a nil status, so the composer can queue it.
    func send(accountID: String, payload: SendPayload) async throws {
        let body = Components.Schemas.SendMessageInput(
            to: payload.to,
            cc: payload.cc,
            bcc: payload.bcc,
            subject: payload.subject,
            body: payload.body,
            htmlBody: payload.htmlBody,
            inReplyTo: payload.inReplyTo,
            references: payload.references,
            attachments: payload.attachments.isEmpty ? nil : payload.attachments.map {
                Components.Schemas.SendAttachment(filename: $0.filename, contentType: $0.contentType, size: $0.size, fileKey: $0.fileKey)
            },
            idempotencyKey: payload.idempotencyKey
        )
        do {
            switch try await client().sendMessage(path: .init(accountId: accountID), body: .json(body)) {
            case .ok:
                return
            case let .default(status, response):
                throw Self.sendFailure(status: status, error: try? response.body.json.error)
            }
        } catch let failure as SendFailure {
            throw failure
        } catch {
            let api = APIError.from(error)
            throw SendFailure(status: api.status, code: api.code, message: nil, details: SendErrorDetails())
        }
    }

    /// A refused send as the composer reads it.
    private static func sendFailure(status: Int, error: Components.Schemas.ErrorBody?) -> SendFailure {
        let details = error?.details
        return SendFailure(
            status: status,
            code: error?.code,
            message: error?.message,
            details: SendErrorDetails(
                limit: details?.limit,
                window: details?.window,
                retryAfter: details?.retryAfter,
                suggestWeldReach: details?.suggestWeldReach == true,
                reason: details?.reason,
                sent: details?.sent ?? [],
                failed: details?.failed ?? [],
                recipients: details?.recipients ?? [],
                invalid: (details?.invalidFormat ?? []) + (details?.unreachableDomains ?? [])
            )
        )
    }

    func schedule(_ payload: SchedulePayload) async throws {
        let body = Components.Schemas.ScheduleMessageInput(
            accountId: payload.accountID,
            to: payload.to,
            cc: payload.cc,
            bcc: payload.bcc,
            subject: payload.subject,
            body: payload.body,
            htmlBody: payload.htmlBody,
            scheduledFor: payload.scheduledFor,
            inReplyTo: payload.inReplyTo,
            references: payload.references
        )
        try await call {
            switch try await client().scheduleMessage(body: .json(body)) {
            case .created: return
            case let .default(status, response): throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    // MARK: Subscriptions

    func subscriptions(accountID: String) async throws -> [MailSubscription] {
        try await call {
            switch try await client().listSubscriptions(query: .init(accountId: accountID)) {
            case let .ok(ok): return try ok.body.json.data.map(Self.subscription)
            case let .default(status, response): throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    /// Found and looked through.
    func scan(accountID: String) async throws -> (found: Int, scanned: Int) {
        try await call {
            switch try await client().scanSubscriptions(body: .json(.init(accountId: accountID))) {
            case let .ok(ok):
                let result = try ok.body.json.data
                return (result.subscriptions, result.scanned)
            case let .default(status, response): throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    func unsubscribe(_ id: String) async throws -> UnsubscribeResult {
        try await call {
            switch try await client().unsubscribe(path: .init(subscriptionId: id)) {
            case let .ok(ok):
                let result = try ok.body.json.data
                let method: UnsubscribeMethod
                switch result.method {
                case "one_click": method = .oneClick
                case "mailto": method = .mailto
                default: method = .link
                }
                return UnsubscribeResult(method: method, url: result.url)
            case let .default(status, response): throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    // MARK: New mailboxes

    func weldmailDomain() async throws -> String {
        try await call {
            switch try await client().weldmailDomain() {
            case let .ok(ok): return try ok.body.json.data.domain
            case let .default(status, response): throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    func checkAddress(_ address: String) async throws -> Availability {
        try await call {
            switch try await client().checkWeldmailAddress(body: .json(.init(address: address))) {
            case let .ok(ok):
                let result = try ok.body.json.data
                return Availability(available: result.available, reason: result.reason)
            case let .default(status, response): throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    /// The new address.
    func reserveAddress(_ address: String, displayName: String) async throws -> String {
        let name = displayName.trimmingCharacters(in: .whitespaces).isEmpty ? address : displayName
        return try await call {
            switch try await client().reserveWeldmailAddress(body: .json(.init(address: address, name: name, displayName: name))) {
            case let .created(created): return try created.body.json.data.email
            case let .default(status, response): throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    func mailDomains() async throws -> [String] {
        try await call {
            switch try await client().listMailDomains() {
            case let .ok(ok):
                return try ok.body.json.data.filter { $0.isActive != false }.map(\.domainName).filter { !$0.isEmpty }
            case let .default(status, response): throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    func createAccount(name: String, email: String, displayName: String) async throws -> String {
        try await call {
            switch try await client().createMailAccount(body: .json(.init(name: name, email: email, displayName: displayName))) {
            case let .created(created): return try created.body.json.data.email
            case let .default(status, response): throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    // MARK: Contacts

    func people(search: String?, limit: Int = 10) async throws -> [MailContact] {
        let query = search?.trimmingCharacters(in: .whitespaces)
        return try await call {
            switch try await client().listPeople(query: .init(search: query?.isEmpty == false ? query : nil, limit: limit)) {
            case let .ok(ok): return try ok.body.json.data.map(Self.person)
            case let .default(status, response): throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    func person(_ id: String) async throws -> MailContact {
        try await call {
            switch try await client().getPerson(path: .init(personId: id)) {
            case let .ok(ok): return Self.person(try ok.body.json.data)
            case let .default(status, response): throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    func createPerson(email: String) async throws {
        try await call {
            switch try await client().createPerson(body: .json(.init(email: email))) {
            case .ok, .created: return
            case let .default(status, response): throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    /// Changes the fields given (nil: unchanged).
    func updatePerson(_ id: String, change: ContactLogic.Change) async throws -> MailContact {
        let body = Components.Schemas.UpdatePersonInput(
            firstName: change.firstName,
            lastName: change.lastName,
            email: change.email,
            directPhone: change.phone,
            notes: change.notes,
            department: change.department,
            linkedinUrl: change.linkedinURL
        )
        return try await call {
            switch try await client().updatePerson(path: .init(personId: id), body: .json(body)) {
            case let .ok(ok): return Self.person(try ok.body.json.data)
            case let .default(status, response): throw APIError(status: status, code: try? response.body.json.error.code)
            }
        }
    }

    // MARK: Mapping

    private static func account(_ it: Components.Schemas.MailAccount) -> MailAccount {
        let display = it.displayName?.trimmingCharacters(in: .whitespaces)
        let name = display?.isEmpty == false ? (display ?? it.email) : (it.name.isEmpty ? it.email : it.name)
        return MailAccount(id: it.id, email: it.email, displayName: name, isDefault: it.isDefault == true, isActive: it.status == "active")
    }

    private static func address(_ it: Components.Schemas.MailAddress?) -> MailAddress? {
        guard let it else { return nil }
        let email = (it.email ?? "").trimmingCharacters(in: .whitespaces)
        let name = it.name?.trimmingCharacters(in: .whitespaces).isEmpty == false ? it.name : nil
        if email.isEmpty && name == nil { return nil }
        return MailAddress(email, name: name, avatarURL: it.avatarUrl)
    }

    private static func message(_ it: Components.Schemas.MailMessage) -> MailMessage {
        MailMessage(
            id: it.id,
            accountID: it.accountId,
            smtpMessageID: it.messageId,
            threadID: it.threadId,
            from: address(it.from),
            to: (it.to ?? []).compactMap { address($0) },
            cc: (it.cc ?? []).compactMap { address($0) },
            subject: it.subject,
            preview: it.preview,
            textBody: it.textBody,
            htmlBody: it.htmlBody,
            sentDate: it.sentDate,
            receivedDate: it.receivedDate,
            createdAt: it.createdAt,
            isRead: it.isRead,
            isStarred: it.isStarred == true,
            isImportant: it.isImportant == true,
            isDraft: it.isDraft == true,
            hasAttachments: it.hasAttachments,
            labels: it.labels ?? [],
            references: it.references ?? [],
            attachments: (it.attachments ?? []).map {
                MailAttachment(id: $0.id, fileName: $0.fileName, contentType: $0.contentType, size: $0.size)
            }
        )
    }

    private static func subscription(_ it: Components.Schemas.MailSubscription) -> MailSubscription {
        MailSubscription(
            id: it.id,
            accountID: it.accountId,
            senderEmail: it.senderEmail,
            senderName: it.senderName,
            lastSubject: it.lastSubject,
            messageCount: it.messageCount,
            lastReceivedAt: it.lastReceivedAt,
            active: it.status != "unsubscribed",
            unsubscribedAt: it.unsubscribedAt,
            unsubscribeURL: it.unsubscribeUrl,
            unsubscribeMailto: it.unsubscribeMailto,
            oneClick: it.oneClick
        )
    }

    private static func person(_ it: Components.Schemas.Person) -> MailContact {
        MailContact(
            id: it.id,
            email: it.email,
            firstName: it.firstName,
            lastName: it.lastName,
            fullName: it.fullName,
            phone: it.directPhone ?? it.mobilePhone,
            department: it.department,
            notes: it.notes,
            linkedinURL: it.linkedinUrl,
            bestTimeToContact: it.bestTimeToContact,
            avatarURL: it.avatarUrl
        )
    }
}
