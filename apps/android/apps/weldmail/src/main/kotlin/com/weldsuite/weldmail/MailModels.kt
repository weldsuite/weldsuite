package com.weldsuite.weldmail

import kotlinx.serialization.Serializable

/**
 * The app's own view of the mail API, mapped from the generated types in
 * [MailRepository] and nowhere else, so a generator rename stays there. These
 * are what the screens use and what the offline cache keeps.
 */
@Serializable
data class MailAddress(val email: String, val name: String? = null, val avatarUrl: String? = null) {
    /** The name, else the address. */
    val label: String get() = name?.takeIf { it.isNotBlank() } ?: email
}

@Serializable
data class MailAttachment(
    val id: String,
    val fileName: String,
    val contentType: String? = null,
    val size: Long = 0,
)

@Serializable
data class MailMessage(
    val id: String,
    val accountId: String,
    /** The SMTP Message-ID, for threading a reply. */
    val smtpMessageId: String? = null,
    val threadId: String? = null,
    val from: MailAddress? = null,
    val to: List<MailAddress> = emptyList(),
    val cc: List<MailAddress> = emptyList(),
    val subject: String? = null,
    val preview: String? = null,
    val textBody: String? = null,
    val htmlBody: String? = null,
    val sentDate: String,
    val receivedDate: String? = null,
    val createdAt: String,
    val isRead: Boolean,
    val isStarred: Boolean = false,
    val isImportant: Boolean = false,
    val isDraft: Boolean = false,
    val hasAttachments: Boolean = false,
    val labels: List<String> = emptyList(),
    val references: List<String> = emptyList(),
    val attachments: List<MailAttachment> = emptyList(),
    /** Messages of this thread in the loaded list (worked out on the phone). */
    val threadCount: Int = 1,
) {
    /** When it arrived (or was sent): what the list sorts and groups by. */
    val listDate: String get() = receivedDate ?: sentDate

    val senderName: String? get() = from?.label?.takeIf { it.isNotBlank() }
}

/** A mailbox the person can open, in this workspace or another one. */
@Serializable
data class MailAccount(
    val id: String,
    val email: String,
    val displayName: String,
    val isDefault: Boolean = false,
    val isActive: Boolean = true,
    /** Null for the active workspace; else the workspace it belongs to (`workspaces.id`). */
    val workspaceId: String? = null,
    val workspaceName: String? = null,
) {
    val inActiveWorkspace: Boolean get() = workspaceId == null
}

/** A label of the mailbox's own, with its message count. */
@Serializable
data class CustomLabel(
    val id: String,
    val name: String,
    val slug: String,
    val color: String? = null,
    val count: Int = 0,
)

/** The counts of the system folders, and the mailbox's own labels. */
@Serializable
data class LabelState(
    val systemCounts: Map<String, Int> = emptyMap(),
    val custom: List<CustomLabel> = emptyList(),
)

/** A label row as the server lists it, before [MailLogic.processLabels] folds it. */
data class LabelRow(
    val id: String,
    val name: String,
    val slug: String?,
    val color: String?,
    val isSystem: Boolean,
    val count: Int,
)

@Serializable
data class MailSubscription(
    val id: String,
    val accountId: String,
    val senderEmail: String,
    val senderName: String? = null,
    val lastSubject: String? = null,
    val messageCount: Int = 0,
    val lastReceivedAt: String,
    val active: Boolean,
    val unsubscribedAt: String? = null,
    val unsubscribeUrl: String? = null,
    val unsubscribeMailto: String? = null,
    val oneClick: Boolean = false,
) {
    val senderLabel: String get() = senderName?.takeIf { it.isNotBlank() } ?: senderEmail
}

/** How the server unsubscribed. */
enum class UnsubscribeMethod { ONE_CLICK, MAILTO, LINK }

data class UnsubscribeResult(val method: UnsubscribeMethod, val url: String?)

/** A contact (`/api/people`). */
data class Person(
    val id: String,
    val email: String?,
    val firstName: String?,
    val lastName: String?,
    val fullName: String?,
    val phone: String?,
    val department: String?,
    val notes: String?,
    val linkedinUrl: String?,
    val bestTimeToContact: String?,
    val avatarUrl: String?,
) {
    val name: String?
        get() = fullName?.takeIf { it.isNotBlank() }
            ?: listOfNotNull(firstName, lastName).joinToString(" ").trim().ifBlank { null }
}

/** A page of messages and where the next one starts (null: the end). */
data class MessagePage(val messages: List<MailMessage>, val cursor: String?)

data class MessageStats(val unread: Int, val inboxUnread: Int, val drafts: Int)

/** A file to attach, once uploaded to storage. */
@Serializable
data class UploadedAttachment(
    val filename: String,
    val contentType: String,
    val size: Long,
    val fileKey: String,
)

/** What a send carries; also what the outbox keeps for a send made offline. */
@Serializable
data class SendPayload(
    val to: List<String>,
    val cc: List<String>? = null,
    val bcc: List<String>? = null,
    val subject: String,
    val body: String? = null,
    val htmlBody: String? = null,
    val attachments: List<UploadedAttachment> = emptyList(),
    val idempotencyKey: String? = null,
    val inReplyTo: String? = null,
    val references: List<String>? = null,
)

/** What a scheduled send carries. */
data class SchedulePayload(
    val accountId: String,
    val to: List<String>,
    val cc: List<String>?,
    val bcc: List<String>?,
    val subject: String?,
    val body: String?,
    val htmlBody: String?,
    val scheduledFor: String,
    val inReplyTo: String?,
    val references: List<String>?,
)

/** Whether a free address can be taken. */
data class Availability(val available: Boolean, val reason: String?)
