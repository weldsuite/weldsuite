package com.weldsuite.weldhr

import org.weldsuite.core.WeldDate
import java.text.Normalizer
import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.temporal.ChronoUnit
import java.time.temporal.IsoFields
import java.util.Locale
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.roundToInt
import kotlin.math.roundToLong

/*
 * The rules the screens apply before asking the server, the same as the Expo
 * app's lib/: calendar days, shifts and the hours clocked on them, leave,
 * open shifts, announcements, the expense filter and search, receipts, and
 * where a push leads. Pure, so they are unit tested.
 */

/** Calendar days as WeldHR sends them: `yyyy-MM-dd` in the workspace's calendar, never instants. */
object HrDays {
    private val ISO_DAY = Regex("^\\d{4}-\\d{2}-\\d{2}$")

    /** A `yyyy-MM-dd` day; null for anything else. */
    fun parse(iso: String?): LocalDate? =
        if (iso == null || !ISO_DAY.matches(iso)) null else runCatching { LocalDate.parse(iso) }.getOrNull()

    fun today(zone: ZoneId = ZoneId.systemDefault()): String = LocalDate.now(zone).toString()

    fun add(iso: String, days: Long): String = parse(iso)?.plusDays(days)?.toString() ?: iso

    fun isWeekend(iso: String): Boolean {
        val day = parse(iso)?.dayOfWeek ?: return false
        return day == DayOfWeek.SATURDAY || day == DayOfWeek.SUNDAY
    }

    /** The first Monday to Friday after [iso]. */
    fun nextWeekday(iso: String): String {
        var day = add(iso, 1)
        while (isWeekend(day)) day = add(day, 1)
        return day
    }

    /** Monday to Friday days from [start] to [end], inclusive: the estimate shown while filling in a request. */
    fun weekdaysBetween(start: String, end: String): Int {
        val from = parse(start) ?: return 0
        val to = parse(end) ?: return 0
        if (to < from) return 0
        var count = 0
        var day = from
        while (day <= to) {
            if (day.dayOfWeek != DayOfWeek.SATURDAY && day.dayOfWeek != DayOfWeek.SUNDAY) count += 1
            day = day.plusDays(1)
        }
        return count
    }

    /** The Monday of the week [iso] falls in. */
    fun startOfWeek(iso: String): String {
        val day = parse(iso) ?: return iso
        return day.minusDays((day.dayOfWeek.value - 1).toLong()).toString()
    }

    /** The ISO 8601 week number ("Week 43"). */
    fun isoWeek(iso: String): Int = parse(iso)?.get(IsoFields.WEEK_OF_WEEK_BASED_YEAR) ?: 0

    /** The local calendar day of a timestamp (a shift's start), or its date part when it does not parse. */
    fun dayOf(timestamp: String, zone: ZoneId = ZoneId.systemDefault()): String {
        if (parse(timestamp) != null) return timestamp
        val instant = WeldDate.parse(timestamp, zone) ?: return timestamp.take(10)
        return instant.atZone(zone).toLocalDate().toString()
    }

    /** Whole calendar days from [earlier] to [later]. */
    fun between(earlier: String, later: String): Long {
        val from = parse(earlier) ?: return 0
        val to = parse(later) ?: return 0
        return ChronoUnit.DAYS.between(from, to)
    }
}

/** Shifts and the hours clocked on them (the Expo app's lib/shifts.ts). */
object ShiftMath {
    /** The currency for "€ 0,00" when nothing carries one. */
    const val DEFAULT_CURRENCY = "EUR"

    private fun millis(iso: String?): Long? = WeldDate.parse(iso)?.toEpochMilli()

    fun isOpen(record: ClockRecord): Boolean = record.clockIn != null && record.clockOut == null

    fun byClockIn(records: List<ClockRecord>): List<ClockRecord> = records.sortedBy { it.clockIn.orEmpty() }

    /** Whole minutes between two timestamps. */
    fun minutesBetween(start: String?, end: String?): Int {
        val from = millis(start) ?: return 0
        val to = millis(end) ?: return 0
        return max(0, ((to - from) / 60_000.0).roundToInt())
    }

    /** A record's minutes: what it worked, or so far for one still running. */
    fun minutesOf(record: ClockRecord, now: Long): Double {
        record.workedMinutes?.let { return it.toDouble() }
        val start = millis(record.clockIn)
        if (start != null && record.clockOut == null) return max(0.0, (now - start) / 60_000.0)
        return 0.0
    }

    fun plannedBreak(shift: Shift): Pair<String, String>? {
        val start = shift.breakStartsAt ?: return null
        val end = shift.breakEndsAt ?: return null
        return start to end
    }

    /** A shift's planned minutes, its break left out (breaks are unpaid). */
    fun plannedMinutes(startsAt: String, endsAt: String, breakStartsAt: String?, breakEndsAt: String?): Int {
        val pause = if (breakStartsAt != null && breakEndsAt != null) minutesBetween(breakStartsAt, breakEndsAt) else 0
        return max(0, minutesBetween(startsAt, endsAt) - pause)
    }

    fun plannedMinutes(shift: Shift): Int = plannedMinutes(shift.startsAt, shift.endsAt, shift.breakStartsAt, shift.breakEndsAt)

    /**
     * The shift a record was clocked on: the one it is linked to, or else one
     * that day its hours overlap. [shifts] are the same person's.
     */
    fun shiftOf(record: ClockRecord, shifts: List<Shift>, now: Long, zone: ZoneId = ZoneId.systemDefault()): Shift? {
        record.shiftId?.let { id -> return shifts.firstOrNull { it.id == id } }
        val start = millis(record.clockIn) ?: return null
        val end = millis(record.clockOut) ?: now
        return shifts.firstOrNull { shift ->
            val shiftStart = millis(shift.startsAt) ?: return@firstOrNull false
            val shiftEnd = millis(shift.endsAt) ?: return@firstOrNull false
            HrDays.dayOf(shift.startsAt, zone) == record.date && shiftStart < end && shiftEnd > start
        }
    }

    /** The gaps between one clocked stretch and the next; under a minute is a slip of the finger. */
    fun clockedOutGaps(records: List<ClockRecord>): List<Pair<String, String>> {
        val stretches = byClockIn(records.filter { it.clockIn != null })
        val gaps = mutableListOf<Pair<String, String>>()
        for (i in 1 until stretches.size) {
            val before = stretches[i - 1].clockOut
            val after = stretches[i].clockIn
            if (before != null && after != null && minutesBetween(before, after) >= 1) gaps += before to after
        }
        return gaps
    }

    /** What [records] earn at their own hourly rates, per currency; nothing set up is 0 in [fallback]. */
    fun earnings(records: List<ClockRecord>, now: Long, fallback: String): List<Pair<String, Double>> {
        val sums = linkedMapOf<String, Double>()
        for (record in records) {
            val rate = record.hourlyRate ?: continue
            val currency = record.currency ?: continue
            sums[currency] = (sums[currency] ?: 0.0) + minutesOf(record, now) / 60.0 * rate
        }
        if (sums.isEmpty()) sums[fallback] = 0.0
        return sums.toList()
    }

    /** "7:45" for worked minutes. */
    fun duration(minutes: Double?): String {
        if (minutes == null || minutes.isNaN()) return ""
        val total = max(0L, minutes.roundToLong())
        return "${total / 60}:${(total % 60).toString().padStart(2, '0')}"
    }

    /** The hours and minutes of [minutes], for "7h 5m". */
    fun hoursAndMinutes(minutes: Double?): Pair<Long, Long> {
        val total = max(0L, (minutes ?: 0.0).roundToLong())
        return total / 60 to total % 60
    }

    /** A running clock, "01:02:08". */
    fun timer(millis: Long): String {
        val seconds = max(0L, millis / 1000)
        fun pad(value: Long) = value.toString().padStart(2, '0')
        return "${pad(seconds / 3600)}:${pad(seconds / 60 % 60)}:${pad(seconds % 60)}"
    }
}

/** Leave rules, mirroring hr-api so a button only shows when the action can work. */
object LeaveRules {
    /** Upcoming and pending first (soonest at the top), then the past, newest first. */
    fun sortRequests(requests: List<LeaveRequest>, today: String): List<LeaveRequest> {
        val current = requests.filter { it.status == "pending" || it.endDate >= today }.sortedBy { it.startDate }
        val past = requests.filterNot { it.status == "pending" || it.endDate >= today }.sortedByDescending { it.startDate }
        return current + past
    }

    /** A pending request, or approved leave that has not started yet. */
    fun canCancel(request: LeaveRequest, today: String): Boolean =
        request.status == "pending" || (request.status == "approved" && request.startDate > today)

    /** The balance for leave starting on [startDate]: this year's balances only cover this year. */
    fun balanceForStart(balances: List<LeaveBalance>, leaveTypeId: String?, startDate: String, today: String): LeaveBalance? {
        if (startDate.take(4) != today.take(4)) return null
        return balances.firstOrNull { it.leaveTypeId == leaveTypeId }
    }

    sealed interface Allowance {
        data object Ok : Allowance
        data class Over(val remaining: Double, val blocked: Boolean) : Allowance
    }

    fun checkAllowance(balance: LeaveBalance?, days: Int): Allowance {
        val remaining = balance?.remaining ?: return Allowance.Ok
        if (days <= remaining) return Allowance.Ok
        return Allowance.Over(max(0.0, remaining), balance.overAllowance == "block")
    }

    /** The day's planned minutes the leave takes off: all of them, or a share for a half day. */
    fun minutesOff(request: LeaveRequest, planned: Int): Double =
        if (request.startDate == request.endDate && request.days < 1) planned * request.days else planned.toDouble()
}

/** Where an open shift stands for the caller. */
enum class Standing { OPEN, WAITING, DECLINED, FULL }

object OpenShiftRules {
    fun standingOf(shift: OpenShift): Standing = when (shift.myRequest?.status) {
        "pending" -> Standing.WAITING
        "rejected" -> Standing.DECLINED
        else -> if (shift.spotsLeft > 0) Standing.OPEN else Standing.FULL
    }

    private fun startMillis(shift: OpenShift): Long = WeldDate.parse(shift.startsAt)?.toEpochMilli() ?: 0

    /** A spot left, not started, and no sign-up waiting (a declined or withdrawn one may be tried again). */
    fun canSignUp(shift: OpenShift, now: Long): Boolean =
        startMillis(shift) > now && shift.spotsLeft > 0 && shift.myRequest?.status != "pending"

    /** Not started, soonest first; a full one only while the caller's sign-up waits or was declined. */
    fun listable(shifts: List<OpenShift>, now: Long): List<OpenShift> = shifts
        .filter { startMillis(it) > now }
        .filter { it.myRequest?.status != "approved" }
        .filter { it.spotsLeft > 0 || standingOf(it) == Standing.WAITING || standingOf(it) == Standing.DECLINED }
        .sortedBy { it.startsAt }
}

/** How long ago an announcement was published; the words come from the strings. */
sealed interface Age {
    data object Now : Age
    data class Minutes(val count: Int) : Age
    data class Hours(val count: Int) : Age
    data object Yesterday : Age
    data class Days(val count: Int) : Age
    /** A week or more: show the date. */
    data object Date : Age
}

object AnnouncementRules {
    /** Pinned first, then the newest. */
    fun sort(list: List<Announcement>): List<Announcement> =
        list.sortedWith(compareByDescending<Announcement> { it.pinned }.thenByDescending { WeldDate.parse(it.publishedAt) ?: Instant.EPOCH })

    /** The body on one line for a list row. */
    fun preview(body: String, max: Int = 140): String {
        val flat = body.replace(Regex("\\s+"), " ").trim()
        return if (flat.length > max) flat.take(max).trimEnd() + "…" else flat
    }

    fun ageOf(publishedAt: String, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): Age {
        val published = WeldDate.parse(publishedAt) ?: return Age.Now
        val minutes = floor((now.toEpochMilli() - published.toEpochMilli()) / 60_000.0).toLong()
        if (minutes < 1) return Age.Now
        if (minutes < 60) return Age.Minutes(minutes.toInt())
        val days = ChronoUnit.DAYS.between(published.atZone(zone).toLocalDate(), now.atZone(zone).toLocalDate())
        return when {
            days < 1 -> Age.Hours((minutes / 60).toInt())
            days == 1L -> Age.Yesterday
            days < 7 -> Age.Days(days.toInt())
            else -> Age.Date
        }
    }
}

/** A switch per status (own claims) or category (claims to approve); what is switched off is hidden. */
data class ExpenseFilter(val statuses: Set<String> = emptySet(), val categories: Set<String> = emptySet()) {
    val isActive: Boolean get() = statuses.isNotEmpty() || categories.isNotEmpty()

    fun passes(row: Declaration): Boolean = row.status !in statuses && row.category !in categories

    companion object {
        val STATUSES = listOf("pending", "approved", "paid", "rejected", "cancelled")
        val CATEGORIES = listOf("travel", "meals", "accommodation", "equipment", "training", "other")

        /** The statuses to offer: the ones the list has, plus the ones switched off. */
        fun statusChoices(rows: List<Declaration>, filter: ExpenseFilter): List<String> =
            STATUSES.filter { it in filter.statuses || rows.any { row -> row.status == it } }

        fun categoryChoices(rows: List<Declaration>, filter: ExpenseFilter): List<String> =
            CATEGORIES.filter { it in filter.categories || rows.any { row -> row.category == it } }
    }
}

/** Search as you type: case and accents do not matter, and every word has to appear in one of the fields. */
object Search {
    fun normalize(text: String): String =
        Normalizer.normalize(text, Normalizer.Form.NFD).replace(Regex("\\p{Mn}+"), "").lowercase(Locale.ROOT).trim()

    fun matches(query: String, fields: List<String?>): Boolean {
        val words = normalize(query).split(Regex("\\s+")).filter { it.isNotEmpty() }
        if (words.isEmpty()) return true
        val haystack = fields.filterNotNull().joinToString("\n") { normalize(it) }
        return words.all { haystack.contains(it) }
    }
}

/** Receipts: one image or PDF per claim, at most 10 MB. */
object Receipts {
    const val MAX_BYTES = 10L * 1024 * 1024
    val TYPES = listOf("image/jpeg", "image/png", "image/webp", "application/pdf")

    enum class Problem { TYPE, SIZE }

    fun guessType(name: String): String? = when (Regex("\\.([a-z0-9]+)(?:\\?.*)?$", RegexOption.IGNORE_CASE).find(name)?.groupValues?.get(1)?.lowercase()) {
        "jpg", "jpeg" -> "image/jpeg"
        "png" -> "image/png"
        "webp" -> "image/webp"
        "pdf" -> "application/pdf"
        else -> null
    }

    fun problem(mimeType: String?, size: Long?): Problem? {
        val type = mimeType?.lowercase()
        if (type == null || type !in TYPES) return Problem.TYPE
        if (size != null && size > MAX_BYTES) return Problem.SIZE
        return null
    }

    /** `receipt-2026-11-27.jpg` when the picker gives no name. */
    fun fileName(given: String?, mimeType: String, today: String): String {
        given?.trim()?.takeIf { it.isNotEmpty() }?.let { return it }
        val extension = if (mimeType == "application/pdf") "pdf" else mimeType.substringAfter('/').replace("jpeg", "jpg")
        return "receipt-$today.$extension"
    }
}

/** What someone typed as an amount: "12,50", "12.5", "1.234,56" → 12.5 / 1234.56; null when not above zero. */
fun parseAmount(input: String): Double? {
    val cleaned = input.replace(Regex("[^\\d.,-]"), "")
    if (cleaned.isEmpty()) return null
    val decimal = if (cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')) ',' else '.'
    val thousands = if (decimal == ',') '.' else ','
    val normalized = cleaned.replace(thousands.toString(), "").replace(decimal, '.')
    val value = normalized.toDoubleOrNull() ?: return null
    if (value <= 0 || value.isNaN() || value.isInfinite()) return null
    return (value * 100).roundToLong() / 100.0
}

/** The tasks per checklist, open ones first, then by due date. */
fun groupTasks(tasks: List<HrTask>): List<Pair<String, List<HrTask>>> {
    val groups = linkedMapOf<String, MutableList<HrTask>>()
    for (task in tasks) groups.getOrPut(task.checklistName) { mutableListOf() } += task
    return groups.map { (name, list) ->
        name to list.sortedWith(compareBy<HrTask> { it.completedAt != null }.thenBy { it.dueDate ?: "9" })
    }
}

/** A screen a push or a deep link leads to. */
sealed interface HrTarget {
    data object Announcements : HrTarget
    data class Announcement(val id: String) : HrTarget
    data class Leave(val id: String) : HrTarget
    data class Expense(val id: String) : HrTarget
    data class SickReport(val id: String) : HrTarget
    data object Schedule : HrTarget
    data object Absence : HrTarget
    data object Expenses : HrTarget
    data object Pay : HrTarget
    data object Tasks : HrTarget
    data object Reviews : HrTarget
}

object HrRoutes {
    /** Where a tapped push leads: announcements by `notificationType`, else the app's own `route`. */
    fun forPush(values: Map<String, String>): HrTarget? {
        if (values["notificationType"] == "hr_announcement") {
            val id = values["announcementId"]?.takeIf { it.isNotEmpty() }
            return if (id != null) HrTarget.Announcement(id) else HrTarget.Announcements
        }
        return values["route"]?.let(::forPath)
    }

    /** `/announcement/ann_1`, `weldhr://leave/lr_1`, `/expenses`, … */
    fun forPath(path: String): HrTarget? {
        val parts = path.substringAfter("://", path).substringBefore('?').trim('/').split('/').filter { it.isNotEmpty() }
        val id = parts.getOrNull(1)?.let { java.net.URLDecoder.decode(it, "UTF-8") }
        return when (parts.firstOrNull()) {
            "announcements" -> HrTarget.Announcements
            "announcement" -> id?.let { HrTarget.Announcement(it) } ?: HrTarget.Announcements
            "leave" -> id?.let { HrTarget.Leave(it) } ?: HrTarget.Absence
            "expense" -> id?.let { HrTarget.Expense(it) } ?: HrTarget.Expenses
            "sick" -> id?.let { HrTarget.SickReport(it) } ?: HrTarget.Absence
            "schedule" -> HrTarget.Schedule
            "absence" -> HrTarget.Absence
            "expenses" -> HrTarget.Expenses
            "pay" -> HrTarget.Pay
            "tasks" -> HrTarget.Tasks
            "reviews" -> HrTarget.Reviews
            else -> null
        }
    }
}

/** Colours for the bar in front of a shift: a stable one per client, role or department name. */
object Swatches {
    private val SHIFT = listOf(0xFF10B981, 0xFF8B5CF6, 0xFFF59E0B, 0xFF3B82F6, 0xFFEC4899, 0xFF14B8A6, 0xFFF97316, 0xFF6366F1)

    /** The Expo app's string hash (`value * 31 + char`, 32-bit). */
    fun hash(key: String): Int {
        var value = 0
        for (char in key) value = value * 31 + char.code
        return abs(value)
    }

    fun shift(key: String?): Long = SHIFT[hash(key.orEmpty()) % SHIFT.size]

    val CATEGORY = mapOf(
        "travel" to 0xFF3B82F6,
        "meals" to 0xFFF97316,
        "accommodation" to 0xFF8B5CF6,
        "equipment" to 0xFF14B8A6,
        "training" to 0xFFEC4899,
        "other" to 0xFF6B7280,
    )

    /** A `#rgb` / `#rrggbb` colour as ARGB; null when it is not hex. */
    fun hex(color: String?): Long? {
        val text = color?.trim()?.removePrefix("#") ?: return null
        val full = when {
            Regex("^[0-9a-fA-F]{3}$").matches(text) -> text.map { "$it$it" }.joinToString("")
            Regex("^[0-9a-fA-F]{6}$").matches(text) -> text
            else -> return null
        }
        return 0xFF000000 or full.toLong(16)
    }

    /** Whether dark text reads better than white on [argb]. */
    fun prefersDarkText(argb: Long): Boolean {
        fun channel(shift: Int): Double {
            val s = ((argb shr shift) and 0xFF) / 255.0
            return if (s <= 0.03928) s / 12.92 else Math.pow((s + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0) > 0.45
    }
}
