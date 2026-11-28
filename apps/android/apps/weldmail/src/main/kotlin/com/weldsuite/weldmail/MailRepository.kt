package com.weldsuite.weldmail

import com.weldsuite.weldmail.offline.FlagPatch
import org.weldsuite.api.weldmail.apis.DefaultApi
import org.weldsuite.api.weldmail.models.CreateDraftInput
import org.weldsuite.api.weldmail.models.CreateLabelInput
import org.weldsuite.api.weldmail.models.CreateMailAccountInput
import org.weldsuite.api.weldmail.models.CreatePersonInput
import org.weldsuite.api.weldmail.models.ErrorResponse
import org.weldsuite.api.weldmail.models.LabelsInput
import org.weldsuite.api.weldmail.models.ReserveWeldmailInput
import org.weldsuite.api.weldmail.models.ScanSubscriptionsInput
import org.weldsuite.api.weldmail.models.ScheduleMessageInput
import org.weldsuite.api.weldmail.models.SendAttachment
import org.weldsuite.api.weldmail.models.SendMessageInput
import org.weldsuite.api.weldmail.models.SnoozeInput
import org.weldsuite.api.weldmail.models.UpdateMessageInput
import org.weldsuite.api.weldmail.models.UpdatePersonInput
import org.weldsuite.api.weldmail.models.WeldmailAddressInput
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.WeldJson
import org.weldsuite.core.api.ApiException
import org.weldsuite.core.api.apiCall
import org.weldsuite.core.api.apiCallNoContent
import java.io.IOException
import org.weldsuite.api.weldmail.models.MailAccount as ApiAccount
import org.weldsuite.api.weldmail.models.MailAddress as ApiAddress
import org.weldsuite.api.weldmail.models.MailMessage as ApiMessage
import org.weldsuite.api.weldmail.models.MailSubscription as ApiSubscription
import org.weldsuite.api.weldmail.models.Person as ApiPerson

/**
 * A send the server refused, with what it said about why: the composer turns
 * it into words with [SendErrors]. `status` null: the server wasn't reached.
 */
class SendFailure(val status: Int?, val code: String?, message: String?, val details: SendErrorDetails, cause: Throwable? = null) :
    Exception(message ?: "Send failed (${status ?: "network"})", cause) {
    val isNetwork: Boolean get() = status == null
}

/**
 * The WeldMail API for the active workspace. The generated types are mapped
 * to the app's own ([MailModels.kt]) here and nowhere else.
 */
class MailRepository(private val env: AppEnvironment) {
    private val api: DefaultApi get() = env.api.create()

    // ---------------------------------------------------------------- mailboxes

    /** The workspace's mailboxes the person may open. */
    suspend fun accounts(): List<MailAccount> =
        apiCall { api.listMailAccounts(limit = 100) }.data.map(::account)

    /** Mailboxes in the person's other workspaces, for the mailbox menu; empty when that fails. */
    suspend fun otherWorkspaceAccounts(activeWorkspace: String): List<MailAccount> =
        runCatching { apiCall { api.listMailboxes() }.data }.getOrDefault(emptyList())
            .filter { it.workspaceId != activeWorkspace }
            .flatMap { group ->
                group.accounts.map {
                    MailAccount(
                        id = it.id,
                        email = it.email,
                        displayName = it.displayName,
                        isDefault = it.isDefault == true,
                        isActive = it.status == "active",
                        workspaceId = group.workspaceId,
                        workspaceName = group.workspaceName,
                    )
                }
            }

    suspend fun labels(accountId: String?): List<LabelRow> = apiCall { api.listLabels(accountId) }.data.map {
        LabelRow(it.id, it.name, it.slug, it.color, it.isSystem == true, it.messageCount)
    }

    suspend fun createLabel(accountId: String, name: String, color: String?) {
        apiCall { api.createLabel(CreateLabelInput(accountId = accountId, name = name, color = color, aiEnabled = false)) }
    }

    // ---------------------------------------------------------------- messages

    suspend fun messages(
        accountId: String?,
        label: String?,
        search: String? = null,
        unreadOnly: Boolean? = null,
        withAttachments: Boolean? = null,
        limit: Int = PAGE_SIZE,
        cursor: String? = null,
    ): MessagePage {
        val list = apiCall {
            api.listMessages(
                accountId = accountId,
                label = label,
                search = search?.trim()?.ifEmpty { null },
                isRead = unreadOnly?.let { (!it).toString() },
                hasAttachments = withAttachments?.toString(),
                limit = limit,
                cursor = cursor,
            )
        }
        val next = list.pagination.cursor.takeIf { list.pagination.hasMore }
        return MessagePage(list.data.map(::message), next)
    }

    suspend fun stats(accountId: String?): MessageStats = apiCall { api.messageStats(accountId) }.data.let {
        MessageStats(it.unread, it.inboxUnread, it.drafts)
    }

    suspend fun message(id: String): MailMessage = message(apiCall { api.getMessage(id) }.data)

    /** The conversation, oldest first. */
    suspend fun thread(id: String): List<MailMessage> = apiCall { api.getThread(id) }.data.messages.map(::message)

    suspend fun update(id: String, patch: FlagPatch) {
        apiCall {
            api.updateMessage(
                id,
                UpdateMessageInput(isRead = patch.isRead, isStarred = patch.isStarred, isSpam = patch.isSpam, isImportant = patch.isImportant),
            )
        }
    }

    suspend fun delete(id: String) = apiCallNoContent { api.deleteMessage(id) }

    /** Out of the inbox into the archive. */
    suspend fun archive(id: String) {
        apiCall { api.addMessageLabels(id, LabelsInput(listOf(SystemLabel.ARCHIVE.slug))) }
        apiCall { api.removeMessageLabels(id, LabelsInput(listOf(SystemLabel.INBOX.slug))) }
    }

    /** Adds and removes labels; the message's labels after. */
    suspend fun changeLabels(id: String, add: List<String>, remove: List<String>, current: List<String>): List<String> {
        var labels = current
        if (add.isNotEmpty()) labels = apiCall { api.addMessageLabels(id, LabelsInput(add)) }.data.labels
        if (remove.isNotEmpty()) labels = apiCall { api.removeMessageLabels(id, LabelsInput(remove)) }.data.labels
        return labels
    }

    suspend fun snooze(accountId: String, id: String, until: String) {
        apiCall { api.snoozeMessage(accountId, id, SnoozeInput(until)) }
    }

    suspend fun unsnooze(accountId: String, id: String) {
        apiCall { api.unsnoozeMessage(accountId, id) }
    }

    // ---------------------------------------------------------------- composing

    suspend fun createDraft(
        accountId: String,
        to: List<String>,
        cc: List<String>,
        bcc: List<String>,
        subject: String,
        body: String,
        html: Boolean,
    ): String = apiCall {
        api.createDraft(
            CreateDraftInput(
                accountId = accountId,
                to = to.ifEmpty { null },
                cc = cc.ifEmpty { null },
                bcc = bcc.ifEmpty { null },
                subject = subject.ifEmpty { null },
                body = if (html) null else body.ifEmpty { null },
                htmlBody = if (html) body.ifEmpty { null } else null,
            ),
        )
    }.data.id

    suspend fun deleteDraft(id: String) = apiCallNoContent { api.deleteDraft(id) }

    /**
     * Sends now. A refusal is a [SendFailure] with the server's code and
     * details (the core's error only keeps the code); offline too, with a
     * null status, so the composer can queue it.
     */
    suspend fun send(accountId: String, payload: SendPayload) {
        val body = SendMessageInput(
            to = payload.to,
            cc = payload.cc,
            bcc = payload.bcc,
            subject = payload.subject,
            body = payload.body,
            htmlBody = payload.htmlBody,
            inReplyTo = payload.inReplyTo,
            references = payload.references,
            attachments = payload.attachments.ifEmpty { null }?.map {
                SendAttachment(filename = it.filename, propertySize = it.size.toInt(), fileKey = it.fileKey, contentType = it.contentType)
            },
            idempotencyKey = payload.idempotencyKey,
        )
        val response = try {
            api.sendMessage(accountId, body)
        } catch (error: IOException) {
            throw SendFailure(null, null, error.message, SendErrorDetails(), error)
        }
        if (response.isSuccessful) return
        val error = response.errorBody()?.string()?.let {
            runCatching { WeldJson.decodeFromString(ErrorResponse.serializer(), it).error }.getOrNull()
        }
        val details = error?.details
        throw SendFailure(
            status = response.code(),
            code = error?.code,
            message = error?.message,
            details = SendErrorDetails(
                limit = details?.limit,
                window = details?.window,
                retryAfter = details?.retryAfter,
                suggestWeldReach = details?.suggestWeldReach == true,
                reason = details?.reason,
                sent = details?.sent.orEmpty(),
                failed = details?.failed.orEmpty(),
                recipients = details?.recipients.orEmpty(),
                invalid = details?.invalidFormat.orEmpty() + details?.unreachableDomains.orEmpty(),
            ),
        )
    }

    suspend fun schedule(payload: SchedulePayload) {
        apiCall {
            api.scheduleMessage(
                ScheduleMessageInput(
                    accountId = payload.accountId,
                    to = payload.to,
                    scheduledFor = payload.scheduledFor,
                    cc = payload.cc,
                    bcc = payload.bcc,
                    subject = payload.subject,
                    body = payload.body,
                    htmlBody = payload.htmlBody,
                    inReplyTo = payload.inReplyTo,
                    references = payload.references,
                ),
            )
        }
    }

    // ---------------------------------------------------------------- subscriptions

    suspend fun subscriptions(accountId: String): List<MailSubscription> =
        apiCall { api.listSubscriptions(accountId) }.data.map(::subscription)

    /** Found and looked through. */
    suspend fun scan(accountId: String): Pair<Int, Int> =
        apiCall { api.scanSubscriptions(ScanSubscriptionsInput(accountId)) }.data.let { it.subscriptions to it.scanned }

    suspend fun unsubscribe(id: String): UnsubscribeResult = apiCall { api.unsubscribe(id) }.data.let {
        val method = when (it.method) {
            "one_click" -> UnsubscribeMethod.ONE_CLICK
            "mailto" -> UnsubscribeMethod.MAILTO
            else -> UnsubscribeMethod.LINK
        }
        UnsubscribeResult(method, it.url)
    }

    // ---------------------------------------------------------------- new mailboxes

    suspend fun weldmailDomain(): String = apiCall { api.weldmailDomain() }.data.domain

    suspend fun checkAddress(address: String): Availability =
        apiCall { api.checkWeldmailAddress(WeldmailAddressInput(address)) }.data.let { Availability(it.available, it.reason) }

    /** The new address. */
    suspend fun reserveAddress(address: String, displayName: String): String =
        apiCall {
            api.reserveWeldmailAddress(
                ReserveWeldmailInput(address = address, name = displayName.ifBlank { address }, displayName = displayName.ifBlank { address }),
            )
        }.data.email

    suspend fun mailDomains(): List<String> =
        apiCall { api.listMailDomains() }.data.filter { it.isActive != false }.map { it.domainName }.filter { it.isNotBlank() }

    suspend fun createAccount(name: String, email: String, displayName: String): String =
        apiCall { api.createMailAccount(CreateMailAccountInput(name = name, email = email, displayName = displayName)) }.data.email

    // ---------------------------------------------------------------- contacts

    suspend fun people(search: String?, limit: Int = 10): List<Person> =
        apiCall { api.listPeople(search = search?.trim()?.ifEmpty { null }, limit = limit) }.data.map(::person)

    suspend fun person(id: String): Person = person(apiCall { api.getPerson(id) }.data)

    suspend fun createPerson(email: String) {
        apiCall { api.createPerson(CreatePersonInput(email)) }
    }

    /** Changes the fields given (null: unchanged). */
    suspend fun updatePerson(
        id: String,
        firstName: String? = null,
        lastName: String? = null,
        email: String? = null,
        phone: String? = null,
        notes: String? = null,
        department: String? = null,
        linkedinUrl: String? = null,
    ): Person = person(
        apiCall {
            api.updatePerson(
                id,
                UpdatePersonInput(
                    firstName = firstName,
                    lastName = lastName,
                    email = email,
                    directPhone = phone,
                    notes = notes,
                    department = department,
                    linkedinUrl = linkedinUrl,
                ),
            )
        }.data,
    )

    // ---------------------------------------------------------------- mapping

    private fun account(it: ApiAccount) = MailAccount(
        id = it.id,
        email = it.email,
        displayName = it.displayName?.takeIf { name -> name.isNotBlank() } ?: it.name.ifBlank { it.email },
        isDefault = it.isDefault == true,
        isActive = it.status == "active",
    )

    private fun address(it: ApiAddress?): MailAddress? {
        val email = it?.email?.trim().orEmpty()
        if (it == null || (email.isEmpty() && it.name.isNullOrBlank())) return null
        return MailAddress(email = email, name = it.name?.takeIf { name -> name.isNotBlank() }, avatarUrl = it.avatarUrl)
    }

    private fun message(it: ApiMessage) = MailMessage(
        id = it.id,
        accountId = it.accountId,
        smtpMessageId = it.messageId,
        threadId = it.threadId,
        from = address(it.from),
        to = it.to.orEmpty().mapNotNull(::address),
        cc = it.cc.orEmpty().mapNotNull(::address),
        subject = it.subject,
        preview = it.preview,
        textBody = it.textBody,
        htmlBody = it.htmlBody,
        sentDate = it.sentDate,
        receivedDate = it.receivedDate,
        createdAt = it.createdAt,
        isRead = it.isRead,
        isStarred = it.isStarred == true,
        isImportant = it.isImportant == true,
        isDraft = it.isDraft == true,
        hasAttachments = it.hasAttachments,
        labels = it.labels.orEmpty(),
        references = it.references.orEmpty(),
        attachments = it.attachments.orEmpty().map { a ->
            MailAttachment(id = a.id, fileName = a.fileName, contentType = a.contentType, size = a.propertySize.toLong())
        },
    )

    private fun subscription(it: ApiSubscription) = MailSubscription(
        id = it.id,
        accountId = it.accountId,
        senderEmail = it.senderEmail,
        senderName = it.senderName,
        lastSubject = it.lastSubject,
        messageCount = it.messageCount,
        lastReceivedAt = it.lastReceivedAt,
        active = it.status != "unsubscribed",
        unsubscribedAt = it.unsubscribedAt,
        unsubscribeUrl = it.unsubscribeUrl,
        unsubscribeMailto = it.unsubscribeMailto,
        oneClick = it.oneClick,
    )

    private fun person(it: ApiPerson) = Person(
        id = it.id,
        email = it.email,
        firstName = it.firstName,
        lastName = it.lastName,
        fullName = it.fullName,
        phone = it.directPhone ?: it.mobilePhone,
        department = it.department,
        notes = it.notes,
        linkedinUrl = it.linkedinUrl,
        bestTimeToContact = it.bestTimeToContact,
        avatarUrl = it.avatarUrl,
    )

    companion object {
        /** Messages per request; more load as the list nears its end. */
        const val PAGE_SIZE = 50

        /** Whether a failure means the server wasn't reached. */
        fun isNetwork(error: Throwable): Boolean =
            (error as? ApiException)?.isNetwork == true || (error as? SendFailure)?.isNetwork == true || error is IOException
    }
}
