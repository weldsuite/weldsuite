package com.weldsuite.weldmail

import org.weldsuite.core.WeldDate
import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.temporal.ChronoUnit
import java.time.temporal.TemporalAdjusters
import kotlin.math.abs
import kotlin.math.ln
import kotlin.math.pow

/** A system folder: its slug as the server labels messages. */
enum class SystemLabel(val slug: String) {
    INBOX("INBOX"),
    PROMOTIONS("PROMOTIONS"),
    STARRED("STARRED"),
    SENT("SENT"),
    DRAFTS("DRAFTS"),
    SCHEDULED("SCHEDULED"),
    SNOOZED("SNOOZED"),
    IMPORTANT("IMPORTANT"),
    ALL("ALL"),
    ARCHIVE("ARCHIVE"),
    SPAM("SPAM"),
    TRASH("TRASH"),
    ;

    companion object {
        /** Shown first in the mailbox menu. */
        val MAIN = listOf(INBOX, PROMOTIONS, STARRED, SENT, DRAFTS)

        /** Behind "More". */
        val SECONDARY = listOf(SCHEDULED, SNOOZED, IMPORTANT, ALL, ARCHIVE, SPAM, TRASH)

        fun of(slug: String): SystemLabel? = entries.firstOrNull { it.slug == slug.uppercase() }
    }
}

/** The inbox's quick filters. */
enum class InboxFilter { ALL, UNREAD, STARRED, ATTACHMENTS }

/** Where a message falls in the inbox. */
enum class DateSection { PINNED, TODAY, YESTERDAY, THIS_WEEK, OLDER }

data class MessageSection(val section: DateSection, val messages: List<MailMessage>)

/** Reply, reply all or forward. */
enum class ComposeMode { NEW, REPLY, REPLY_ALL, FORWARD }

/** What the composer opens with: a reply's recipients and quote, a forward's. */
data class ComposePrefill(
    val mode: ComposeMode = ComposeMode.NEW,
    val to: List<String> = emptyList(),
    val cc: List<String> = emptyList(),
    val subject: String = "",
    val quotedFrom: String = "",
    val quotedDate: String = "",
    val quotedSubject: String = "",
    val quotedBody: String = "",
    val accountId: String? = null,
    val inReplyTo: String? = null,
    val references: List<String> = emptyList(),
)

/** The ids a push carries, checked before they are used. */
data class NotificationTarget(
    val emailId: String?,
    val accountId: String?,
    val fromName: String?,
    val fromEmail: String?,
    val subject: String?,
    val preview: String?,
)

/** What kind of file an attachment is, for its icon and colour. */
enum class AttachmentKind { IMAGE, PDF, DOC, SHEET, SLIDES, ARCHIVE, VIDEO, AUDIO, FILE }

/** Mail rules that don't depend on Android: sorting, grouping, composing, scheduling. */
object MailLogic {
    /** generateId()'s shape: ids from a push or a link are checked against it. */
    private val ID = Regex("^[A-Za-z0-9_-]{1,40}$")

    // ---------------------------------------------------------------- labels

    private val SYSTEM_SLUGS = setOf(
        "INBOX", "STARRED", "SENT", "DRAFTS", "TRASH", "SPAM", "ARCHIVE", "SCHEDULED", "SNOOZED",
        "IMPORTANT", "ALL", "MUTED", "UNREAD", "PROMOTIONS", "DRAFT", "PINNED",
    )

    fun isSystemLabel(slug: String): Boolean = slug.uppercase() in SYSTEM_SLUGS

    /** The labels a row shows: the mailbox's own (system labels are upper case). */
    fun displayLabels(labels: List<String>): List<String> = labels.filter { it != it.uppercase() }

    /**
     * Folds label rows (of one mailbox, or of every mailbox in the unified
     * inbox) into the system folders' counts and the custom labels, merging
     * custom labels of the same name.
     */
    fun processLabels(rows: List<LabelRow>): LabelState {
        val counts = mutableMapOf<String, Int>()
        val custom = mutableListOf<CustomLabel>()
        for (row in rows) {
            val slug = row.slug?.takeIf { it.isNotBlank() } ?: row.name
            if (row.isSystem || isSystemLabel(slug)) {
                val system = SystemLabel.of(slug) ?: continue
                counts[system.slug] = (counts[system.slug] ?: 0) + row.count
            } else {
                val index = custom.indexOfFirst { it.name.equals(row.name, ignoreCase = true) }
                if (index >= 0) {
                    custom[index] = custom[index].copy(count = custom[index].count + row.count)
                } else {
                    custom += CustomLabel(row.id, row.name, row.slug ?: row.name, row.color, row.count)
                }
            }
        }
        return LabelState(counts, custom)
    }

    private val LABEL_COLORS = listOf(
        0xEF4444, 0xF97316, 0xF59E0B, 0xEAB308, 0x84CC16, 0x22C55E, 0x10B981, 0x14B8A6, 0x06B6D4,
        0x0EA5E9, 0x3B82F6, 0x6366F1, 0x8B5CF6, 0xA855F7, 0xD946EF, 0xEC4899, 0xF43F5E,
    )

    private val AVATAR_COLORS = listOf(
        0x3B82F6, 0x10B981, 0xF59E0B, 0x8B5CF6, 0xEF4444, 0x06B6D4, 0xEC4899, 0xF97316, 0x14B8A6, 0x6366F1,
    )

    /** The colours a new label can have. */
    val LABEL_CHOICES: List<Pair<String, Int>> = listOf(
        "red" to 0xEF4444, "orange" to 0xF97316, "yellow" to 0xEAB308, "green" to 0x22C55E,
        "teal" to 0x14B8A6, "blue" to 0x3B82F6, "purple" to 0x8B5CF6, "pink" to 0xEC4899,
    )

    /** JavaScript's `hash = codePoint + ((hash << 5) - hash)`, as the Expo app and the web compute it. */
    fun hash(text: String): Int {
        var hash = 0
        var index = 0
        while (index < text.length) {
            val codePoint = text.codePointAt(index)
            hash = codePoint + ((hash shl 5) - hash)
            index += Character.charCount(codePoint)
        }
        return if (hash == Int.MIN_VALUE) 0 else abs(hash)
    }

    /** A label's colour: its own (`#RRGGBB`), else one picked by its name. */
    fun labelColor(name: String, own: String?): Int =
        parseHex(own) ?: LABEL_COLORS[hash(name) % LABEL_COLORS.size]

    /** The tile colour behind a sender's initial. */
    fun avatarColor(name: String): Int = AVATAR_COLORS[hash(name) % AVATAR_COLORS.size]

    fun parseHex(value: String?): Int? {
        val text = value?.trim()?.removePrefix("#") ?: return null
        if (text.length != 6) return null
        return text.toIntOrNull(16)
    }

    // ---------------------------------------------------------------- the list

    /** The day a message falls on, as the inbox groups it. */
    fun dateSection(date: String, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): DateSection {
        val instant = WeldDate.parse(date) ?: return DateSection.OLDER
        val days = ChronoUnit.DAYS.between(instant.atZone(zone).toLocalDate(), now.atZone(zone).toLocalDate())
        return when {
            days <= 0 -> DateSection.TODAY
            days == 1L -> DateSection.YESTERDAY
            days <= 7 -> DateSection.THIS_WEEK
            else -> DateSection.OLDER
        }
    }

    /** Pinned first, then by day; empty sections left out. */
    fun sections(
        messages: List<MailMessage>,
        pinned: Set<String>,
        now: Instant = Instant.now(),
        zone: ZoneId = ZoneId.systemDefault(),
    ): List<MessageSection> {
        val (top, rest) = messages.partition { it.id in pinned }
        val byDay = rest.groupBy { dateSection(it.listDate, now, zone) }
        val ordered = listOf(DateSection.TODAY, DateSection.YESTERDAY, DateSection.THIS_WEEK, DateSection.OLDER)
            .mapNotNull { section -> byDay[section]?.let { MessageSection(section, it) } }
        return if (top.isEmpty()) ordered else listOf(MessageSection(DateSection.PINNED, top)) + ordered
    }

    fun filter(messages: List<MailMessage>, filter: InboxFilter): List<MailMessage> = when (filter) {
        InboxFilter.ALL -> messages
        InboxFilter.UNREAD -> messages.filter { !it.isRead }
        InboxFilter.STARRED -> messages.filter { it.isStarred || "STARRED" in it.labels }
        InboxFilter.ATTACHMENTS -> messages.filter { it.hasAttachments }
    }

    /** How many loaded messages share each message's thread. */
    fun withThreadCounts(list: List<MailMessage>): List<MailMessage> {
        val counts = list.mapNotNull { it.threadId }.groupingBy { it }.eachCount()
        return list.map { it.copy(threadCount = it.threadId?.let { id -> counts[id] } ?: 1) }
    }

    /** Whether `a` comes after `b` in the server's newest-first order. */
    fun isOlderThan(a: MailMessage, b: MailMessage): Boolean {
        val ta = WeldDate.parse(a.sentDate)?.toEpochMilli() ?: 0
        val tb = WeldDate.parse(b.sentDate)?.toEpochMilli() ?: 0
        return ta < tb || (ta == tb && a.id < b.id)
    }

    /**
     * A freshly loaded first page folded onto the list on screen: the rows
     * already scrolled to that are older than the page stay, with the cursor
     * past them. `previousCursor == null && !previousKnown` means the list
     * came from the offline cache, whose place is unknown: the page replaces it.
     */
    fun mergeFirstPage(
        previous: List<MailMessage>,
        firstPage: List<MailMessage>,
        firstPageCursor: String?,
        previousCursor: String?,
        previousKnown: Boolean,
    ): Pair<List<MailMessage>, String?> {
        if (!previousKnown || firstPageCursor == null || firstPage.isEmpty()) return firstPage to firstPageCursor
        val boundary = firstPage.last()
        val ids = firstPage.map { it.id }.toSet()
        val tail = previous.filter { it.id !in ids && isOlderThan(it, boundary) }
        if (tail.isEmpty()) return firstPage to firstPageCursor
        return (firstPage + tail) to previousCursor
    }

    /** A page appended, without rows already listed. */
    fun appendPage(previous: List<MailMessage>, page: List<MailMessage>): List<MailMessage> {
        val seen = previous.map { it.id }.toSet()
        val fresh = page.filter { it.id !in seen }
        return if (fresh.isEmpty()) previous else previous + fresh
    }

    /** The id after `current` in `ids`, for "archive and open the next". */
    fun nextId(ids: List<String>, current: String): String? {
        val index = ids.indexOf(current)
        return if (index < 0) null else ids.getOrNull(index + 1)
    }

    // ---------------------------------------------------------------- composing

    private val SEPARATOR = Regex("[,;]\\s*")

    /** "a@b.com, c@d.com; e@f.com" as addresses. */
    fun splitAddresses(raw: String): List<String> = raw.trim().split(SEPARATOR).map { it.trim() }.filter { it.isNotEmpty() }

    /** What was typed into a field ends in `,` or `;`: the address before it. */
    fun committedAddress(text: String): String? {
        if (!text.endsWith(",") && !text.endsWith(";")) return null
        return text.dropLast(1).trim().ifEmpty { null }
    }

    /** The chips and whatever was typed but not committed: typing an address and tapping Send counts. */
    fun withPending(chips: List<String>, typed: String): List<String> = chips + splitAddresses(typed)

    private val ADDRESS_TOKEN = Regex("[\\s<>,;\"']+")

    /** Bare addresses from a recipient value: a name like "Doe, Jane" is never split into two. */
    fun addresses(recipients: List<MailAddress>): List<String> =
        recipients.flatMap { recipient -> recipient.email.split(ADDRESS_TOKEN).filter(::isAddressToken) }

    private fun isAddressToken(token: String): Boolean {
        val at = token.indexOf('@', 1)
        return at != -1 && at < token.length - 1
    }

    private fun unique(list: List<String>, exclude: Set<String>): List<String> {
        val seen = exclude.toMutableSet()
        return list.filter { seen.add(it.lowercase()) }
    }

    private fun prefixed(subject: String?, reply: Boolean): String {
        val base = subject.orEmpty()
        val already = if (reply) Regex("^re:", RegexOption.IGNORE_CASE) else Regex("^(fwd?|fw):", RegexOption.IGNORE_CASE)
        return if (already.containsMatchIn(base.trim())) base else "${if (reply) "Re" else "Fwd"}: $base"
    }

    /**
     * The composer's prefill for a reply, reply-all or forward: the user's own
     * addresses are left out of reply-all, and a reply to one's own mail goes
     * to its recipients.
     */
    fun prefill(message: MailMessage, mode: ComposeMode, selfAddresses: List<String>, unknownSender: String): ComposePrefill {
        val self = selfAddresses.map { it.lowercase() }.toSet()
        val sender = message.from?.let { addresses(listOf(it)) }.orEmpty()
        val to = addresses(message.to)
        val cc = addresses(message.cc)
        val fromSelf = sender.any { it.lowercase() in self }
        var replyTo = emptyList<String>()
        var replyCc = emptyList<String>()
        when (mode) {
            ComposeMode.REPLY -> replyTo = if (fromSelf) unique(to, self) else sender.take(1)
            ComposeMode.REPLY_ALL -> {
                replyTo = unique(if (fromSelf) to else sender + to, self)
                replyCc = unique(cc, self + replyTo.map { it.lowercase() })
            }
            else -> {}
        }
        val isReply = mode == ComposeMode.REPLY || mode == ComposeMode.REPLY_ALL
        val smtp = message.smtpMessageId?.takeIf { it.isNotBlank() }
        val references = if (isReply && smtp != null) message.references.filter { it != smtp } + smtp else emptyList()
        val senderName = message.senderName ?: unknownSender
        return ComposePrefill(
            mode = mode,
            to = replyTo,
            cc = replyCc,
            subject = prefixed(message.subject, isReply),
            quotedFrom = "$senderName (${message.from?.email.orEmpty()})",
            quotedDate = message.sentDate,
            quotedSubject = message.subject.orEmpty(),
            quotedBody = message.textBody ?: message.preview.orEmpty(),
            accountId = message.accountId,
            inReplyTo = if (isReply) smtp else null,
            references = references,
        )
    }

    /** The quoted original under a reply or forward, as plain text. */
    fun quotedSuffix(prefill: ComposePrefill, label: String, from: String, subject: String): String {
        if (prefill.mode == ComposeMode.NEW || prefill.quotedBody.isBlank()) return ""
        return "\n\n---------- $label ---------\n$from\n$subject\n\n${prefill.quotedBody}"
    }

    fun escapeHtml(text: String): String =
        text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;")

    /** The plain quote as HTML for an HTML body (so `Bob <bob@x.com>` isn't read as a tag). */
    fun quotedSuffixHtml(suffix: String): String =
        if (suffix.isEmpty()) "" else "<div>${escapeHtml(suffix).replace(Regex("\r?\n"), "<br>")}</div>"

    /** Nothing to read: no text, no quote, no attachment. */
    fun hasNoBody(text: String, quotedSuffix: String, attachmentCount: Int): Boolean =
        attachmentCount == 0 && text.isBlank() && quotedSuffix.isBlank()

    /**
     * The send payload: HTML in `htmlBody` when the rich editor was used (with
     * the quote as HTML), else plain text in `body`. "(No subject)" when empty.
     */
    fun sendPayload(
        to: List<String>,
        cc: List<String>,
        bcc: List<String>,
        subject: String,
        text: String,
        html: String,
        quotedSuffix: String,
        attachments: List<UploadedAttachment>,
        idempotencyKey: String?,
        inReplyTo: String?,
        references: List<String>,
        noSubject: String,
    ): SendPayload {
        val useHtml = html.isNotBlank()
        val body = if (useHtml) html + quotedSuffixHtml(quotedSuffix) else text + quotedSuffix
        return SendPayload(
            to = to,
            cc = cc.ifEmpty { null },
            bcc = bcc.ifEmpty { null },
            subject = subject.trim().ifEmpty { noSubject },
            body = if (useHtml) null else body.ifEmpty { null },
            htmlBody = if (useHtml) body else null,
            attachments = attachments,
            idempotencyKey = idempotencyKey,
            inReplyTo = inReplyTo,
            references = if (inReplyTo != null) references.ifEmpty { null } else null,
        )
    }

    // ---------------------------------------------------------------- times

    /** app-api's window: strictly in the future, at most a year out. */
    const val MAX_SCHEDULE_DAYS = 365L

    fun isWithinScheduleWindow(at: Instant, now: Instant): Boolean =
        at.isAfter(now) && !at.isAfter(now.plus(MAX_SCHEDULE_DAYS, ChronoUnit.DAYS))

    enum class SendLaterPreset { IN_ONE_HOUR, IN_TWO_HOURS, TOMORROW_MORNING, TOMORROW_AFTERNOON }

    /** The quick "send later" choices, those outside the window left out. */
    fun sendLaterPresets(now: ZonedDateTime): List<Pair<SendLaterPreset, ZonedDateTime>> {
        val tomorrow = now.toLocalDate().plusDays(1)
        return listOf(
            SendLaterPreset.IN_ONE_HOUR to now.plusHours(1),
            SendLaterPreset.IN_TWO_HOURS to now.plusHours(2),
            SendLaterPreset.TOMORROW_MORNING to ZonedDateTime.of(tomorrow, LocalTime.of(9, 0), now.zone),
            SendLaterPreset.TOMORROW_AFTERNOON to ZonedDateTime.of(tomorrow, LocalTime.of(14, 0), now.zone),
        ).filter { isWithinScheduleWindow(it.second.toInstant(), now.toInstant()) }
    }

    enum class SnoozePreset { IN_ONE_HOUR, IN_FOUR_HOURS, TOMORROW_MORNING, NEXT_MONDAY }

    /** Snooze choices: in an hour, four hours, tomorrow at 8, next Monday at 8. */
    fun snoozePresets(now: ZonedDateTime): List<Pair<SnoozePreset, ZonedDateTime>> {
        val tomorrow = ZonedDateTime.of(now.toLocalDate().plusDays(1), LocalTime.of(8, 0), now.zone)
        val monday = ZonedDateTime.of(
            now.toLocalDate().with(TemporalAdjusters.next(DayOfWeek.MONDAY)),
            LocalTime.of(8, 0),
            now.zone,
        )
        return listOf(
            SnoozePreset.IN_ONE_HOUR to now.plusHours(1),
            SnoozePreset.IN_FOUR_HOURS to now.plusHours(4),
            SnoozePreset.TOMORROW_MORNING to tomorrow,
            SnoozePreset.NEXT_MONDAY to monday,
        )
    }

    /** A day and a time of day as one moment, seconds dropped. */
    fun combine(day: LocalDate, time: LocalTime, zone: ZoneId): ZonedDateTime =
        ZonedDateTime.of(day, time.withSecond(0).withNano(0), zone)

    // ---------------------------------------------------------------- subscriptions

    fun canUnsubscribe(subscription: MailSubscription): Boolean =
        subscription.unsubscribeUrl != null || subscription.unsubscribeMailto != null

    /** Only the sender's own page: it has to be opened to finish. */
    fun isLinkOnly(subscription: MailSubscription): Boolean =
        subscription.unsubscribeUrl != null && !subscription.oneClick && subscription.unsubscribeMailto == null

    /** This sender's subscription in a mailbox's list. */
    fun subscriptionFor(subscriptions: List<MailSubscription>, senderEmail: String?): MailSubscription? {
        val email = senderEmail?.trim()?.lowercase()?.takeIf { it.isNotEmpty() } ?: return null
        return subscriptions.firstOrNull { it.senderEmail.lowercase() == email }
    }

    /** Unsubscribed, yet mail from the sender arrived after. */
    fun stillSending(subscription: MailSubscription): Boolean {
        if (subscription.active) return false
        val unsubscribed = WeldDate.parse(subscription.unsubscribedAt) ?: return false
        val last = WeldDate.parse(subscription.lastReceivedAt) ?: return false
        return last.isAfter(unsubscribed)
    }

    fun matchesSubscription(subscription: MailSubscription, query: String): Boolean {
        val q = query.trim().lowercase()
        return q.isEmpty() || subscription.senderEmail.lowercase().contains(q) ||
            subscription.senderName.orEmpty().lowercase().contains(q) ||
            subscription.lastSubject.orEmpty().lowercase().contains(q)
    }

    // ---------------------------------------------------------------- pushes

    private fun clip(value: String?, max: Int): String? {
        val text = value?.replace(Regex("[\\u0000-\\u001F\\u007F]"), " ")?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        return text.take(max)
    }

    /** An id from a push or a link, if it has generateId()'s shape. */
    fun safeId(value: String?): String? = value?.takeIf { ID.matches(it) }

    /** A new-email push's data: null when it names no message and no mailbox. */
    fun notificationTarget(values: Map<String, String>): NotificationTarget? {
        val emailId = safeId(values["emailId"])
            ?: values["entityId"]?.takeIf { values["entityType"] == "email" }?.let(::safeId)
        val accountId = safeId(values["emailAccountId"])
        if (emailId == null && accountId == null) return null
        return NotificationTarget(
            emailId = emailId,
            accountId = accountId,
            fromName = clip(values["fromName"], 80),
            fromEmail = clip(values["fromEmail"], 120),
            subject = clip(values["subject"], 120),
            preview = clip(values["preview"], 160),
        )
    }

    // ---------------------------------------------------------------- attachments

    private val KINDS = mapOf(
        AttachmentKind.IMAGE to listOf("jpg", "jpeg", "png", "gif", "webp", "heic", "bmp", "svg", "tiff"),
        AttachmentKind.PDF to listOf("pdf"),
        AttachmentKind.DOC to listOf("doc", "docx", "rtf", "txt", "pages", "odt"),
        AttachmentKind.SHEET to listOf("xls", "xlsx", "csv", "numbers", "ods"),
        AttachmentKind.SLIDES to listOf("ppt", "pptx", "key", "odp"),
        AttachmentKind.ARCHIVE to listOf("zip", "rar", "7z", "tar", "gz"),
        AttachmentKind.VIDEO to listOf("mp4", "mov", "avi", "mkv", "webm"),
        AttachmentKind.AUDIO to listOf("mp3", "wav", "m4a", "aac", "ogg"),
    )

    fun attachmentKind(name: String): AttachmentKind {
        val ext = extension(name)
        return KINDS.entries.firstOrNull { ext in it.value }?.key ?: AttachmentKind.FILE
    }

    /** "PDF", or empty when the file has no short extension. */
    fun extensionLabel(name: String): String = extension(name).takeIf { it.length in 1..5 }?.uppercase().orEmpty()

    private fun extension(name: String): String = name.substringAfterLast('.', "").lowercase()

    fun attachmentColor(kind: AttachmentKind): Int = when (kind) {
        AttachmentKind.IMAGE -> 0x8B5CF6
        AttachmentKind.PDF -> 0xEF4444
        AttachmentKind.DOC -> 0x2563EB
        AttachmentKind.SHEET -> 0x16A34A
        AttachmentKind.SLIDES -> 0xF97316
        AttachmentKind.ARCHIVE -> 0xD97706
        AttachmentKind.VIDEO -> 0xDB2777
        AttachmentKind.AUDIO -> 0x0EA5E9
        AttachmentKind.FILE -> 0x6B7280
    }

    /** "2.5 MB". */
    fun fileSize(bytes: Long): String {
        if (bytes <= 0) return "0 Bytes"
        val units = listOf("Bytes", "KB", "MB", "GB")
        val index = (ln(bytes.toDouble()) / ln(1024.0)).toInt().coerceIn(0, units.lastIndex)
        val value = bytes / 1024.0.pow(index)
        val rounded = Math.round(value * 100) / 100.0
        val text = if (rounded == Math.floor(rounded)) rounded.toLong().toString() else rounded.toString()
        return "$text ${units[index]}"
    }

    /** A name safe to create on disk: a stranger chose it. */
    fun safeFileName(name: String): String {
        val cleaned = name.replace(Regex("[\\u0000-\\u001f\\u007f/\\\\:*?\"<>|]"), "_")
            .replace(Regex("^\\.+"), "")
            .trim()
            .take(120)
        return cleaned.ifEmpty { "attachment" }
    }

    /** A random-enough key that makes a retried send safe to replay. */
    fun idempotencyKey(nowMillis: Long, random: (Int) -> Int): String =
        "snd_${nowMillis}_" + (1..8).joinToString("") { random(36).toString(36) }
}
