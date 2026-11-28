package com.weldsuite.weldmail

import org.weldsuite.core.WeldDate
import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.temporal.TemporalAdjusters

/**
 * The search screen's filters. The folder, attachments and read state go to
 * the server with the query; "from me", "to me" and the date are applied to
 * the results on the phone.
 */
data class SearchFilters(
    val label: String? = null,
    val fromMe: Boolean? = null,
    val toMe: Boolean? = null,
    val attachment: Boolean? = null,
    val date: SearchLogic.DateRange? = null,
    val unread: Boolean? = null,
) {
    val isActive: Boolean get() = listOf(label, fromMe, toMe, attachment, date, unread).any { it != null }
}

object SearchLogic {
    enum class DateRange { TODAY, YESTERDAY, THIS_WEEK, THIS_MONTH, THIS_YEAR }

    /** The folders the Label filter offers, as the Expo app lists them. */
    val LABELS = listOf(
        SystemLabel.STARRED, SystemLabel.SCHEDULED, SystemLabel.IMPORTANT, SystemLabel.SENT, SystemLabel.SNOOZED,
        SystemLabel.DRAFTS, SystemLabel.ALL, SystemLabel.ARCHIVE, SystemLabel.TRASH,
    )

    /** The phone-side filters applied to a page of results. */
    fun apply(
        messages: List<MailMessage>,
        filters: SearchFilters,
        own: List<String>,
        now: Instant = Instant.now(),
        zone: ZoneId = ZoneId.systemDefault(),
    ): List<MailMessage> {
        val mine = own.map { it.lowercase() }.toSet()
        return messages.filter { message ->
            val fromMe = message.from?.email?.lowercase() in mine
            val toMe = message.to.any { it.email.lowercase() in mine } || message.cc.any { it.email.lowercase() in mine }
            (filters.fromMe == null || filters.fromMe == fromMe) &&
                (filters.toMe == null || filters.toMe == toMe) &&
                (filters.attachment == null || filters.attachment == message.hasAttachments) &&
                (filters.unread == null || filters.unread == !message.isRead) &&
                (filters.date == null || inRange(message.listDate, filters.date, now, zone))
        }
    }

    /** Whether a message's date falls in a range of days on the phone's calendar. */
    fun inRange(date: String, range: DateRange, now: Instant, zone: ZoneId): Boolean {
        val day = WeldDate.parse(date)?.atZone(zone)?.toLocalDate() ?: return false
        val today = now.atZone(zone).toLocalDate()
        val start: LocalDate = when (range) {
            DateRange.TODAY -> today
            DateRange.YESTERDAY -> today.minusDays(1)
            DateRange.THIS_WEEK -> today.with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY))
            DateRange.THIS_MONTH -> today.withDayOfMonth(1)
            DateRange.THIS_YEAR -> today.withDayOfYear(1)
        }
        val end = if (range == DateRange.YESTERDAY) start else today
        return !day.isBefore(start) && !day.isAfter(end)
    }

    /** Where the query occurs in the text, case ignored, without overlaps. */
    fun matches(text: String, query: String): List<IntRange> {
        val needle = query.trim()
        if (needle.isEmpty() || text.isEmpty()) return emptyList()
        val ranges = mutableListOf<IntRange>()
        var from = 0
        while (true) {
            val at = text.indexOf(needle, from, ignoreCase = true)
            if (at < 0) break
            ranges += at until at + needle.length
            from = at + needle.length
        }
        return ranges
    }
}
