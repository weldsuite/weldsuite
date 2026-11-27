package org.weldsuite.core

import androidx.annotation.StringRes
import org.weldsuite.core.api.ApiException
import java.math.BigDecimal
import java.math.RoundingMode
import java.text.NumberFormat
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.time.temporal.ChronoUnit
import java.util.Currency
import java.util.Locale

/**
 * Dates as the server sends them, and as the apps show them.
 *
 * The server writes timestamps as ISO 8601 in UTC, with or without
 * milliseconds (`2026-11-27T09:30:00.000Z`), and calendar days as
 * `yyyy-MM-dd` (an invoice date, a leave day), which are days on the phone's
 * own calendar, never instants.
 */
object WeldDate {
    /** A timestamp, or a day as its start on the phone's calendar. Null for null, empty or anything else. */
    fun parse(text: String?, zone: ZoneId = ZoneId.systemDefault()): Instant? {
        val value = text?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        runCatching { return OffsetDateTime.parse(value).toInstant() }
        runCatching { return Instant.parse(value) }
        runCatching { return LocalDateTime.parse(value.replace(' ', 'T')).toInstant(ZoneOffset.UTC) }
        return day(value)?.atStartOfDay(zone)?.toInstant()
    }

    /** `2026-11-27` (or the day part of a timestamp) as a day. */
    fun day(text: String?): LocalDate? {
        val value = text?.trim()?.takeIf { it.length >= 10 } ?: return null
        return runCatching { LocalDate.parse(value.take(10)) }.getOrNull()
    }

    /** A day as the server takes it: `2026-11-27`. */
    fun dayString(day: LocalDate): String = day.toString()

    /** A timestamp as the server takes it: `2026-11-27T09:30:00Z`. */
    fun timestampString(instant: Instant): String = instant.truncatedTo(ChronoUnit.MILLIS).toString()

    /** For a list row: the time today, the weekday this week, else the date. */
    fun short(instant: Instant, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String {
        val date = instant.atZone(zone)
        val today = now.atZone(zone).toLocalDate()
        val days = ChronoUnit.DAYS.between(date.toLocalDate(), today)
        return when {
            days == 0L -> date.format(DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(locale))
            days in 1..6 -> date.format(DateTimeFormatter.ofPattern("EEE", locale))
            date.year == today.year -> date.format(DateTimeFormatter.ofPattern("d MMM", locale))
            else -> date.format(DateTimeFormatter.ofLocalizedDate(FormatStyle.SHORT).withLocale(locale))
        }
    }

    /** The date and time, in the phone's style. */
    fun dateTime(instant: Instant, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String =
        instant.atZone(zone).format(DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT).withLocale(locale))

    /** A day, in the phone's style (`27 Nov 2026`). */
    fun date(day: LocalDate, locale: Locale = Locale.getDefault()): String =
        day.format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withLocale(locale))
}

/** Amounts of money. The server sends them as numbers or as decimal strings (`"1250.50"`), with an ISO currency code. */
object Money {
    /** `"1250.50"` → 1250.50; null for anything else. */
    fun parse(text: String?): BigDecimal? = text?.trim()?.takeIf { it.isNotEmpty() }?.toBigDecimalOrNull()

    /** `€ 1.250,50` in the phone's locale. Without a currency, just the number with two decimals. */
    fun format(amount: BigDecimal, currency: String?, locale: Locale = Locale.getDefault()): String {
        val code = currency?.trim()?.uppercase()?.takeIf { it.isNotEmpty() }
        val known = code?.let { runCatching { Currency.getInstance(it) }.getOrNull() }
        val format = if (known != null) {
            NumberFormat.getCurrencyInstance(locale).apply { this.currency = known }
        } else {
            NumberFormat.getNumberInstance(locale).apply {
                minimumFractionDigits = 2
                maximumFractionDigits = 2
            }
        }
        val text = format.format(amount)
        return if (known == null && code != null) "$code $text" else text
    }

    fun format(amount: Double, currency: String?, locale: Locale = Locale.getDefault()): String =
        format(BigDecimal.valueOf(amount), currency, locale)

    /** A decimal string as the server takes it: `1250.50`. */
    fun apiString(amount: BigDecimal): String = amount.setScale(2, RoundingMode.HALF_UP).toPlainString()
}

/** What a failed API call means to the person: a string resource of `:core`. */
@StringRes
fun apiErrorMessage(error: Throwable?): Int {
    val api = error as? ApiException
    return when {
        api == null -> R.string.core_errors_generic
        api.isNetwork -> R.string.core_errors_offline
        api.status == 403 -> R.string.core_errors_forbidden
        api.status == 404 -> R.string.core_errors_not_found
        else -> R.string.core_errors_generic
    }
}

/** A list as a screen shows it: what was last loaded, and how loading went. A failed reload keeps the last data. */
data class LoadState<T>(
    val data: T? = null,
    val loading: Boolean = false,
    val error: Throwable? = null,
) {
    /** Nothing loaded yet and nothing failed: show a spinner. */
    val isFirstLoad: Boolean get() = data == null && error == null
}
