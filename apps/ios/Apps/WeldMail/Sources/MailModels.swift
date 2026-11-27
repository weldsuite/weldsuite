import Foundation

// The app's own view of the mail API, mapped from the generated types in
// `MailRepository.swift` and nowhere else, so a generator rename stays there.
// These are what the screens use and what the offline cache keeps.

struct MailAddress: Codable, Equatable, Hashable, Sendable {
    var email: String
    var name: String?
    var avatarURL: String?

    init(_ email: String, name: String? = nil, avatarURL: String? = nil) {
        self.email = email
        self.name = name
        self.avatarURL = avatarURL
    }

    /// The name, else the address.
    var label: String {
        if let name, !name.trimmingCharacters(in: .whitespaces).isEmpty { return name }
        return email
    }
}

struct MailAttachment: Codable, Equatable, Hashable, Identifiable, Sendable {
    let id: String
    let fileName: String
    var contentType: String?
    var size: Int
}

struct MailMessage: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let accountID: String
    /// The SMTP Message-ID, for threading a reply.
    var smtpMessageID: String?
    var threadID: String?
    var from: MailAddress?
    var to: [MailAddress]
    var cc: [MailAddress]
    var subject: String?
    var preview: String?
    var textBody: String?
    var htmlBody: String?
    var sentDate: String
    var receivedDate: String?
    var createdAt: String
    var isRead: Bool
    var isStarred: Bool
    var isImportant: Bool
    var isDraft: Bool
    var hasAttachments: Bool
    var labels: [String]
    var references: [String]
    var attachments: [MailAttachment]
    /// Messages of this thread in the loaded list (worked out on the phone).
    var threadCount: Int

    init(
        id: String,
        accountID: String,
        smtpMessageID: String? = nil,
        threadID: String? = nil,
        from: MailAddress? = nil,
        to: [MailAddress] = [],
        cc: [MailAddress] = [],
        subject: String? = nil,
        preview: String? = nil,
        textBody: String? = nil,
        htmlBody: String? = nil,
        sentDate: String,
        receivedDate: String? = nil,
        createdAt: String,
        isRead: Bool,
        isStarred: Bool = false,
        isImportant: Bool = false,
        isDraft: Bool = false,
        hasAttachments: Bool = false,
        labels: [String] = [],
        references: [String] = [],
        attachments: [MailAttachment] = [],
        threadCount: Int = 1
    ) {
        self.id = id
        self.accountID = accountID
        self.smtpMessageID = smtpMessageID
        self.threadID = threadID
        self.from = from
        self.to = to
        self.cc = cc
        self.subject = subject
        self.preview = preview
        self.textBody = textBody
        self.htmlBody = htmlBody
        self.sentDate = sentDate
        self.receivedDate = receivedDate
        self.createdAt = createdAt
        self.isRead = isRead
        self.isStarred = isStarred
        self.isImportant = isImportant
        self.isDraft = isDraft
        self.hasAttachments = hasAttachments
        self.labels = labels
        self.references = references
        self.attachments = attachments
        self.threadCount = threadCount
    }

    /// When it arrived (or was sent): what the list sorts and groups by.
    var listDate: String { receivedDate ?? sentDate }

    var senderName: String? {
        guard let label = from?.label, !label.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
        return label
    }
}

/// A mailbox the person can open, in this workspace or another one.
struct MailAccount: Codable, Equatable, Hashable, Identifiable, Sendable {
    let id: String
    var email: String
    var displayName: String
    var isDefault = false
    var isActive = true
    /// Nil for the active workspace; else the workspace it belongs to (`workspaces.id`).
    var workspaceID: String?
    var workspaceName: String?

    var inActiveWorkspace: Bool { workspaceID == nil }
}

/// A label of the mailbox's own, with its message count.
struct CustomLabel: Codable, Equatable, Hashable, Identifiable, Sendable {
    let id: String
    var name: String
    var slug: String
    var color: String?
    var count = 0
}

/// The counts of the system folders, and the mailbox's own labels.
struct LabelState: Codable, Equatable, Sendable {
    var systemCounts: [String: Int] = [:]
    var custom: [CustomLabel] = []
}

/// A label row as the server lists it, before `MailLogic.processLabels` folds it.
struct LabelRow: Equatable {
    let id: String
    let name: String
    let slug: String?
    let color: String?
    let isSystem: Bool
    let count: Int
}

struct MailSubscription: Equatable, Identifiable {
    let id: String
    let accountID: String
    let senderEmail: String
    var senderName: String?
    var lastSubject: String?
    var messageCount = 0
    var lastReceivedAt: String
    var active: Bool
    var unsubscribedAt: String?
    var unsubscribeURL: String?
    var unsubscribeMailto: String?
    var oneClick = false

    var senderLabel: String {
        if let senderName, !senderName.trimmingCharacters(in: .whitespaces).isEmpty { return senderName }
        return senderEmail
    }
}

/// How the server unsubscribed.
enum UnsubscribeMethod: Equatable {
    case oneClick, mailto, link
}

struct UnsubscribeResult: Equatable {
    let method: UnsubscribeMethod
    let url: String?
}

/// A contact (`/api/people`).
struct MailContact: Equatable, Identifiable {
    let id: String
    var email: String?
    var firstName: String?
    var lastName: String?
    var fullName: String?
    var phone: String?
    var department: String?
    var notes: String?
    var linkedinURL: String?
    var bestTimeToContact: String?
    var avatarURL: String?

    var name: String? {
        if let fullName, !fullName.trimmingCharacters(in: .whitespaces).isEmpty { return fullName }
        let joined = [firstName, lastName].compactMap { $0 }.joined(separator: " ").trimmingCharacters(in: .whitespaces)
        return joined.isEmpty ? nil : joined
    }
}

/// A page of messages and where the next one starts (nil: the end).
struct MessagePage: Equatable {
    let messages: [MailMessage]
    let cursor: String?
}

struct MessageStats: Equatable {
    let unread: Int
    let inboxUnread: Int
    let drafts: Int
}

/// A file to attach, once uploaded to storage.
struct UploadedAttachment: Codable, Equatable, Sendable {
    let filename: String
    let contentType: String
    let size: Int
    let fileKey: String
}

/// What a send carries; also what the outbox keeps for a send made offline.
struct SendPayload: Codable, Equatable, Sendable {
    var to: [String]
    var cc: [String]?
    var bcc: [String]?
    var subject: String
    var body: String?
    var htmlBody: String?
    var attachments: [UploadedAttachment] = []
    var idempotencyKey: String?
    var inReplyTo: String?
    var references: [String]?
}

/// What a scheduled send carries.
struct SchedulePayload: Equatable {
    let accountID: String
    let to: [String]
    let cc: [String]?
    let bcc: [String]?
    let subject: String?
    let body: String?
    let htmlBody: String?
    let scheduledFor: String
    let inReplyTo: String?
    let references: [String]?
}

/// Whether a free address can be taken.
struct Availability: Equatable {
    let available: Bool
    let reason: String?
}
