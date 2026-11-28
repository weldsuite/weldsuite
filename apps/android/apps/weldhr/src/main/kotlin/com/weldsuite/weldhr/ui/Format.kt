package com.weldsuite.weldhr.ui

import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import com.weldsuite.weldhr.HrDays
import com.weldsuite.weldhr.R
import com.weldsuite.weldhr.ShiftMath
import org.weldsuite.core.Money
import org.weldsuite.core.WeldDate
import org.weldsuite.core.api.ApiException
import org.weldsuite.core.apiErrorMessage
import org.weldsuite.ui.Tokens
import java.math.BigDecimal
import java.text.NumberFormat
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale
import kotlin.math.floor

/** Dates, times and amounts as the screens show them, in the phone's language. */
object Fmt {
    private val locale: Locale get() = Locale.getDefault()
    private val zone: ZoneId get() = ZoneId.systemDefault()
    const val RANGE = " - "

    private fun pattern(text: String) = DateTimeFormatter.ofPattern(text, locale)

    /** "Mon 3 Mar"; the year only when it is not this year. */
    fun day(iso: String?): String {
        val date = HrDays.parse(iso) ?: return iso.orEmpty()
        val thisYear = date.year == LocalDate.now(zone).year
        return date.format(pattern(if (thisYear) "EEE d MMM" else "EEE d MMM yyyy"))
    }

    /** "3 Mar 2026", for a day or a timestamp. */
    fun date(text: String?): String {
        val date = HrDays.parse(text) ?: WeldDate.parse(text, zone)?.atZone(zone)?.toLocalDate() ?: return text.orEmpty()
        return date.format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).withLocale(locale))
    }

    /** "25 Oct". */
    fun shortDate(iso: String): String = HrDays.parse(iso)?.format(pattern("d MMM"))?.replace(".", "") ?: iso

    /** "19 Oct - 25 Oct", or one day when both ends match. */
    fun span(start: String, end: String): String = if (start == end) shortDate(start) else "${shortDate(start)}$RANGE${shortDate(end)}"

    /** "3 - 7 Mar", "28 Feb - 3 Mar", or one day. */
    fun dateRange(start: String, end: String): String {
        if (start == end) return day(start)
        val from = HrDays.parse(start) ?: return "$start$RANGE$end"
        val to = HrDays.parse(end) ?: return "$start$RANGE$end"
        val now = LocalDate.now(zone)
        val withYear = to.year != now.year || from.year != to.year
        val right = to.format(pattern(if (withYear) "d MMM yyyy" else "d MMM"))
        val left = when {
            from.month == to.month && from.year == to.year -> from.dayOfMonth.toString()
            from.year != to.year -> from.format(pattern("d MMM yyyy"))
            else -> from.format(pattern("d MMM"))
        }
        return "$left$RANGE$right"
    }

    /** "Sunday 25 October", capitalised; the year only when it is not this year. */
    fun longDay(iso: String): String {
        val date = HrDays.parse(iso) ?: return iso
        val thisYear = date.year == LocalDate.now(zone).year
        val text = date.format(pattern(if (thisYear) "EEEE d MMMM" else "EEEE d MMMM yyyy"))
        return text.replaceFirstChar { it.titlecase(locale) }
    }

    /** "Ma", the weekday at the head of a day in a grouped list. */
    fun weekdayShort(iso: String): String =
        HrDays.parse(iso)?.format(pattern("EEE"))?.take(2)?.replaceFirstChar { it.titlecase(locale) }.orEmpty()

    /** "09:05" from a timestamp, in the phone's time zone. */
    fun time(timestamp: String?): String {
        val instant = WeldDate.parse(timestamp, zone) ?: return ""
        return instant.atZone(zone).format(DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(locale))
    }

    /** "09:00 - 16:30"; "09:00 - …" while still running. */
    fun timeRange(start: String?, end: String?): String = "${time(start)}$RANGE${if (end != null) time(end) else "…"}"

    fun money(amount: Double, currency: String?): String = Money.format(amount, currency, locale)

    fun money(decimal: String, currency: String?): String = Money.parse(decimal)?.let { Money.format(it, currency, locale) } ?: decimal

    fun money(amount: BigDecimal, currency: String?): String = Money.format(amount, currency, locale)

    /** Leave days: whole numbers bare, halves with one decimal. */
    fun days(value: Double): String = NumberFormat.getNumberInstance(locale).apply { maximumFractionDigits = 1 }.format(value)

    fun isWhole(value: Double): Boolean = value == floor(value)
}

/** "7h 30m" in the app's language. */
@Composable
fun hm(minutes: Double?): String {
    val (hours, rest) = ShiftMath.hoursAndMinutes(minutes)
    return stringResource(R.string.weldhr_common_hm, hours.toString(), rest.toString())
}

/** "3 days", "1 day", or "1.5 days". */
@Composable
fun daysText(days: Double): String =
    if (Fmt.isWhole(days)) {
        pluralStringResource(R.plurals.weldhr_balance_days, days.toInt(), days.toInt())
    } else {
        stringResource(R.string.weldhr_balance_days_fraction, Fmt.days(days))
    }

/** What a failed call means to the person: the server's own message where it sent one. */
@Composable
fun errorText(error: Throwable?): String {
    val api = error as? ApiException
    val message = api?.message?.takeIf { api.code != null && !api.isNetwork }
    return message ?: stringResource(apiErrorMessage(error))
}

/** Status words in their colour: approved green, pending amber, declined red. */
@Composable
fun statusColor(status: String): Color = when (status) {
    "approved", "paid", "present" -> Tokens.Status.success.current()
    "pending", "late" -> Tokens.Status.warning.current()
    "rejected", "absent" -> Tokens.Status.danger.current()
    else -> androidx.compose.material3.MaterialTheme.colorScheme.onSurfaceVariant
}

@Composable
fun leaveStatusLabel(status: String): String = when (status) {
    "pending" -> stringResource(R.string.weldhr_leave_status_pending)
    "approved" -> stringResource(R.string.weldhr_leave_status_approved)
    "rejected" -> stringResource(R.string.weldhr_leave_status_rejected)
    "cancelled" -> stringResource(R.string.weldhr_leave_status_cancelled)
    else -> status
}

@Composable
fun declarationStatusLabel(status: String): String = when (status) {
    "pending" -> stringResource(R.string.weldhr_declaration_status_pending)
    "approved" -> stringResource(R.string.weldhr_declaration_status_approved)
    "rejected" -> stringResource(R.string.weldhr_declaration_status_rejected)
    "paid" -> stringResource(R.string.weldhr_declaration_status_paid)
    "cancelled" -> stringResource(R.string.weldhr_declaration_status_cancelled)
    else -> status
}

@Composable
fun categoryLabel(category: String): String = when (category) {
    "travel" -> stringResource(R.string.weldhr_declaration_category_travel)
    "meals" -> stringResource(R.string.weldhr_declaration_category_meals)
    "accommodation" -> stringResource(R.string.weldhr_declaration_category_accommodation)
    "equipment" -> stringResource(R.string.weldhr_declaration_category_equipment)
    "training" -> stringResource(R.string.weldhr_declaration_category_training)
    "other" -> stringResource(R.string.weldhr_declaration_category_other)
    else -> category
}

@Composable
fun employeeStatusLabel(status: String): String = when (status) {
    "onboarding" -> stringResource(R.string.weldhr_employee_status_onboarding)
    "active" -> stringResource(R.string.weldhr_employee_status_active)
    "on_leave" -> stringResource(R.string.weldhr_employee_status_on_leave)
    "offboarding" -> stringResource(R.string.weldhr_employee_status_offboarding)
    "terminated" -> stringResource(R.string.weldhr_employee_status_terminated)
    else -> status
}

@Composable
fun attendanceStatusLabel(status: String): String = when (status) {
    "present" -> stringResource(R.string.weldhr_attendance_status_present)
    "late" -> stringResource(R.string.weldhr_attendance_status_late)
    "absent" -> stringResource(R.string.weldhr_attendance_status_absent)
    "excused" -> stringResource(R.string.weldhr_attendance_status_excused)
    "remote" -> stringResource(R.string.weldhr_attendance_status_remote)
    "half_day" -> stringResource(R.string.weldhr_attendance_status_half_day)
    else -> status
}

@Composable
fun shiftRequestStatusLabel(status: String): String = when (status) {
    "pending" -> stringResource(R.string.weldhr_shift_request_status_pending)
    "approved" -> stringResource(R.string.weldhr_shift_request_status_approved)
    "rejected" -> stringResource(R.string.weldhr_shift_request_status_rejected)
    "cancelled" -> stringResource(R.string.weldhr_shift_request_status_cancelled)
    else -> status
}

@Composable
fun sourceLabel(source: String): String = when (source) {
    "portal" -> stringResource(R.string.weldhr_shift_source_portal)
    "manual" -> stringResource(R.string.weldhr_shift_source_manual)
    "import" -> stringResource(R.string.weldhr_shift_source_import)
    "api" -> stringResource(R.string.weldhr_shift_source_api)
    else -> source
}

@Composable
fun roleLabel(role: String): String = when (role) {
    "hr" -> stringResource(R.string.weldhr_tasks_roles_hr)
    "manager" -> stringResource(R.string.weldhr_tasks_roles_manager)
    "it" -> stringResource(R.string.weldhr_tasks_roles_it)
    "employee" -> stringResource(R.string.weldhr_tasks_roles_employee)
    else -> stringResource(R.string.weldhr_tasks_roles_other)
}

@Composable
fun coachingCategoryLabel(category: String): String = when (category) {
    "performance" -> stringResource(R.string.weldhr_coaching_category_performance)
    "quality" -> stringResource(R.string.weldhr_coaching_category_quality)
    "behavior" -> stringResource(R.string.weldhr_coaching_category_behavior)
    "attendance" -> stringResource(R.string.weldhr_coaching_category_attendance)
    "development" -> stringResource(R.string.weldhr_coaching_category_development)
    "recognition" -> stringResource(R.string.weldhr_coaching_category_recognition)
    else -> category
}
