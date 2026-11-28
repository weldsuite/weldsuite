package com.weldsuite.weldbooks.logic

import java.math.BigDecimal
import java.math.RoundingMode
import java.time.LocalDate
import java.time.ZoneId
import java.time.temporal.ChronoUnit

/** Amounts as typed and as the server sends them. */
object Amounts {
    /** A server decimal (`"121.00"`, `121`, `null`) as a number, 0 when it isn't one. */
    fun of(text: String?): BigDecimal = text?.trim()?.toBigDecimalOrNull() ?: BigDecimal.ZERO

    fun of(value: Double?): BigDecimal = value?.takeIf { it.isFinite() }?.let { BigDecimal.valueOf(it) } ?: BigDecimal.ZERO

    /**
     * What a person typed, in European (`1.234,56`) or US (`1,234.56`) style.
     * A lone separator followed by three digits (`1,234`) is a thousands
     * separator when [decimalPoint] (US English), else a decimal comma.
     */
    fun parse(text: String, decimalPoint: Boolean = false): BigDecimal {
        val cleaned = text.filter { it.isDigit() || it == '.' || it == ',' || it == '-' }
        if (cleaned.isEmpty()) return BigDecimal.ZERO
        if (decimalPoint && Regex("^-?\\d{1,3}(,\\d{3})+$").matches(cleaned)) {
            return cleaned.replace(",", "").toBigDecimalOrNull() ?: BigDecimal.ZERO
        }
        val comma = cleaned.lastIndexOf(',')
        val point = cleaned.lastIndexOf('.')
        val normal = if (comma >= 0 && comma > point) {
            cleaned.replace(".", "").replaceFirst(',', '.').replace(",", "")
        } else {
            cleaned.replace(",", "")
        }
        return normal.toBigDecimalOrNull() ?: leadingNumber(normal)
    }

    /** `12.` or `-` while typing: the number so far. */
    private fun leadingNumber(text: String): BigDecimal =
        Regex("^-?\\d+(\\.\\d+)?").find(text)?.value?.toBigDecimalOrNull() ?: BigDecimal.ZERO

    /** Rounded to cents. */
    fun cents(amount: BigDecimal): BigDecimal = amount.setScale(2, RoundingMode.HALF_UP)

    /** A number as the server takes it, without trailing zeros: `"2"`, `"12.5"`. */
    fun plain(amount: BigDecimal): String = amount.stripTrailingZeros().toPlainString().let { if (it == "-0") "0" else it }

    /** A percentage for a label: `21`, `9.5`. */
    fun percent(amount: BigDecimal): String = plain(amount.setScale(4, RoundingMode.HALF_UP))
}

/** Accounting dates are calendar days (`2026-11-27`); the server writes them as ISO timestamps at midnight UTC. */
object Days {
    /** The calendar day of a server date or timestamp. */
    fun of(text: String?): LocalDate? {
        val value = text?.trim()?.takeIf { it.length >= 10 } ?: return null
        return runCatching { LocalDate.parse(value.take(10)) }.getOrNull()
    }

    fun today(zone: ZoneId = ZoneId.systemDefault()): LocalDate = LocalDate.now(zone)

    /** Whole days until [day]; negative once it has passed. */
    fun until(day: LocalDate?, today: LocalDate = today()): Long? = day?.let { ChronoUnit.DAYS.between(today, it) }

    /** Past due with something still open. */
    fun isOverdue(dueDate: String?, balanceDue: BigDecimal, today: LocalDate = today()): Boolean {
        if (balanceDue.signum() <= 0) return false
        val days = until(of(dueDate), today) ?: return false
        return days < 0
    }

    fun monthRange(today: LocalDate = today()): Pair<LocalDate, LocalDate> =
        today.withDayOfMonth(1) to today.withDayOfMonth(today.lengthOfMonth())

    fun yearRange(today: LocalDate = today()): Pair<LocalDate, LocalDate> =
        today.withDayOfYear(1) to today.withDayOfYear(today.lengthOfYear())
}
