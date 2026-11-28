package com.weldsuite.weldcalendar

import java.time.DayOfWeek
import java.time.LocalDate

/**
 * Repeating events, as iCalendar RRULEs (`RRULE:FREQ=WEEKLY;BYDAY=MO`).
 *
 * The rule is stored on the event and goes to Google with it; the server
 * doesn't expand occurrences (nor does the web app), so the apps show the
 * rule and let the person set one of the common ones. A rule the app didn't
 * write (an interval, an end, set days) is shown in words and kept as it is
 * unless the person picks another.
 */
enum class RepeatPreset {
    NONE,
    DAILY,
    WEEKDAYS,
    WEEKLY,
    MONTHLY,
    YEARLY,
    ;

    /** The rule this preset writes; empty for none (an update then stops the repeat). */
    val rule: String
        get() = when (this) {
            NONE -> ""
            DAILY -> "RRULE:FREQ=DAILY"
            WEEKDAYS -> "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"
            WEEKLY -> "RRULE:FREQ=WEEKLY"
            MONTHLY -> "RRULE:FREQ=MONTHLY"
            YEARLY -> "RRULE:FREQ=YEARLY"
        }

    companion object {
        /** The preset a stored rule is, or null for a rule none of them writes. */
        fun of(rule: String?): RepeatPreset? {
            val parsed = RRule.parse(rule) ?: return if (rule.isNullOrBlank()) NONE else null
            if (parsed.interval != 1 || parsed.count != null || parsed.until != null) return null
            return when (parsed.frequency) {
                RRule.Frequency.DAILY -> DAILY.takeIf { parsed.days.isEmpty() }
                RRule.Frequency.WEEKLY -> when (parsed.days) {
                    emptyList<DayOfWeek>() -> WEEKLY
                    WORKDAYS -> WEEKDAYS
                    else -> null
                }
                RRule.Frequency.MONTHLY -> MONTHLY.takeIf { parsed.days.isEmpty() }
                RRule.Frequency.YEARLY -> YEARLY.takeIf { parsed.days.isEmpty() }
            }
        }

        val WORKDAYS = listOf(DayOfWeek.MONDAY, DayOfWeek.TUESDAY, DayOfWeek.WEDNESDAY, DayOfWeek.THURSDAY, DayOfWeek.FRIDAY)
    }
}

/** The parts of an RRULE the apps put into words. */
data class RRule(
    val frequency: Frequency,
    val interval: Int,
    /** `BYDAY`, in week order; an ordinal (`1MO`) is read as the day alone. */
    val days: List<DayOfWeek>,
    val count: Int?,
    val until: LocalDate?,
) {
    enum class Frequency { DAILY, WEEKLY, MONTHLY, YEARLY }

    companion object {
        private val DAY_CODES = mapOf(
            "MO" to DayOfWeek.MONDAY,
            "TU" to DayOfWeek.TUESDAY,
            "WE" to DayOfWeek.WEDNESDAY,
            "TH" to DayOfWeek.THURSDAY,
            "FR" to DayOfWeek.FRIDAY,
            "SA" to DayOfWeek.SATURDAY,
            "SU" to DayOfWeek.SUNDAY,
        )

        /**
         * `RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;UNTIL=20301231T000000Z`,
         * with or without the prefix. Null for no rule, or a frequency the
         * apps don't name (hourly and finer).
         */
        fun parse(text: String?): RRule? {
            val body = text?.trim()?.takeIf { it.isNotEmpty() } ?: return null
            val line = body.lines().firstOrNull { it.trim().uppercase().startsWith("RRULE:") }?.trim()?.substring(6)
                ?: body.takeUnless { it.contains(':') } ?: return null
            val parts = line.split(';').mapNotNull { part ->
                val pieces = part.split('=', limit = 2)
                if (pieces.size == 2) pieces[0].trim().uppercase() to pieces[1].trim() else null
            }.toMap()
            val frequency = when (parts["FREQ"]?.uppercase()) {
                "DAILY" -> Frequency.DAILY
                "WEEKLY" -> Frequency.WEEKLY
                "MONTHLY" -> Frequency.MONTHLY
                "YEARLY" -> Frequency.YEARLY
                else -> return null
            }
            val interval = parts["INTERVAL"]?.toIntOrNull()?.takeIf { it > 0 } ?: 1
            val days = parts["BYDAY"].orEmpty().split(',')
                .mapNotNull { code -> DAY_CODES[code.trim().uppercase().takeLast(2)] }
                .distinct()
                .sorted()
            val count = parts["COUNT"]?.toIntOrNull()?.takeIf { it > 0 }
            val until = parts["UNTIL"]?.let { value ->
                val digits = value.take(8)
                if (digits.length == 8 && digits.all(Char::isDigit)) {
                    runCatching { LocalDate.of(digits.take(4).toInt(), digits.substring(4, 6).toInt(), digits.substring(6, 8).toInt()) }.getOrNull()
                } else {
                    null
                }
            }
            return RRule(frequency, interval, days, count, until)
        }
    }
}
