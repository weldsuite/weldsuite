package com.weldsuite.weldcalendar

import java.time.DayOfWeek
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.YearMonth
import java.time.ZoneId
import java.time.temporal.ChronoUnit
import java.time.temporal.TemporalAdjusters

/**
 * Dates as the calendar screens use them. Everything works in the phone's
 * own zone, as the web app does: it builds an all-day event from local
 * midnight and reads it back with local hours, so an event lands on the same
 * square on every surface as long as nobody reaches for UTC days.
 */
object CalendarDates {
    /** The agenda covers today and the next two weeks. */
    const val AGENDA_DAYS = 14L

    /** Monday-first, as the platform grid and European calendars are. */
    val WEEK_START: DayOfWeek = DayOfWeek.MONDAY

    private val END_OF_DAY: LocalTime = LocalTime.of(23, 59, 59, 999_000_000)

    fun startOf(day: LocalDate, zone: ZoneId): Instant = day.atStartOfDay(zone).toInstant()

    fun endOf(day: LocalDate, zone: ZoneId): Instant = day.atTime(END_OF_DAY).atZone(zone).toInstant()

    fun dayOf(instant: Instant, zone: ZoneId): LocalDate = instant.atZone(zone).toLocalDate()

    /** From today's midnight to the end of the fourteenth day after it. */
    fun agendaWindow(today: LocalDate, zone: ZoneId): Pair<Instant, Instant> =
        startOf(today, zone) to endOf(today.plusDays(AGENDA_DAYS), zone)

    /**
     * Six Monday-first weeks covering [month]: always 42 days, so the grid
     * keeps its height from month to month.
     */
    fun monthMatrix(month: YearMonth): List<List<LocalDate>> {
        val first = month.atDay(1).with(TemporalAdjusters.previousOrSame(WEEK_START))
        return (0 until 6).map { week -> (0 until 7).map { day -> first.plusDays((week * 7 + day).toLong()) } }
    }

    /**
     * What the month grid asks for: the whole grid (its first and last rows
     * spill into the neighbouring months), with a day of slack on each side.
     */
    fun monthWindow(month: YearMonth, zone: ZoneId): Pair<Instant, Instant> {
        val weeks = monthMatrix(month)
        return startOf(weeks.first().first().minusDays(1), zone) to endOf(weeks.last().last().plusDays(1), zone)
    }

    /** "1h 30m" as hours and minutes; null when there is no measurable span. */
    fun duration(start: Instant, end: Instant?): Pair<Long, Long>? {
        val minutes = end?.let { Duration.between(start, it).toMinutes() } ?: return null
        if (minutes <= 0) return null
        return minutes / 60 to minutes % 60
    }

    /** 09:00 on [day], or the next whole hour when [day] is today and 09:00 has passed; no day means the next whole hour. */
    fun startFor(day: LocalDate?, now: LocalDateTime): LocalDateTime {
        val nextHour = now.truncatedTo(ChronoUnit.HOURS).plusHours(1)
        if (day == null) return nextHour
        val nine = day.atTime(9, 0)
        return if (day == now.toLocalDate() && now.hour >= 9) nextHour else nine
    }

    /**
     * All day snaps the pair to the day's bounds; turning it off again
     * restores 09:00–10:00 rather than leaving 00:00–23:59 behind.
     */
    fun allDayRange(allDay: Boolean, start: LocalDateTime, end: LocalDateTime): Pair<LocalDateTime, LocalDateTime> {
        if (allDay) {
            val endDay = if (end.isBefore(start)) start.toLocalDate() else end.toLocalDate()
            return start.toLocalDate().atStartOfDay() to endDay.atTime(END_OF_DAY)
        }
        val nine = start.toLocalDate().atTime(9, 0)
        return nine to nine.plusHours(1)
    }

    /** Moving the start carries the end along, keeping the duration. */
    fun shiftStart(newStart: LocalDateTime, start: LocalDateTime, end: LocalDateTime): Pair<LocalDateTime, LocalDateTime> {
        val length = Duration.between(start, end).let { if (it.isNegative) Duration.ZERO else it }
        return newStart to newStart.plus(length)
    }

    /** `2026-11-27` from a deep link or the month tab, or null. */
    fun parseDay(text: String?): LocalDate? {
        val value = text?.trim() ?: return null
        if (!Regex("""^\d{4}-\d{2}-\d{2}$""").matches(value)) return null
        return runCatching { LocalDate.parse(value) }.getOrNull()
    }
}

/** Today, tomorrow, yesterday, or a date: the agenda's headings. */
enum class RelativeDay { TODAY, TOMORROW, YESTERDAY, THIS_YEAR, OTHER_YEAR }

fun relativeDay(day: LocalDate, today: LocalDate): RelativeDay = when (day) {
    today -> RelativeDay.TODAY
    today.plusDays(1) -> RelativeDay.TOMORROW
    today.minusDays(1) -> RelativeDay.YESTERDAY
    else -> if (day.year == today.year) RelativeDay.THIS_YEAR else RelativeDay.OTHER_YEAR
}

/** Events under one day's heading. */
data class DaySection(val day: LocalDate, val events: List<CalendarEvent>)

/** What a day square of the month grid shows: up to three colours and how many events in all. */
data class DayDots(val colors: List<String>, val total: Int) {
    val overflow: Int get() = total - colors.size
}

/** The agenda's numbers. */
data class AgendaCounts(val today: Int, val nextSevenDays: Int)

/** Lists of events as the agenda and the month grid read them. */
object EventLists {
    const val MAX_DOTS = 3

    private val byStart = compareBy<CalendarEvent>({ it.start }, { it.title })

    /**
     * Day sections in order, each sorted by start. A multi-day event is
     * listed under its start day only: repeating a week-long event under
     * seven headings would bury everything else.
     */
    fun groupByDay(events: List<CalendarEvent>, zone: ZoneId): List<DaySection> =
        events.groupBy { CalendarDates.dayOf(it.start, zone) }
            .toSortedMap()
            .map { (day, list) -> DaySection(day, list.sortedWith(byStart)) }

    fun on(day: LocalDate, events: List<CalendarEvent>, zone: ZoneId): List<CalendarEvent> =
        events.filter { CalendarDates.dayOf(it.start, zone) == day }.sortedWith(byStart)

    fun dots(events: List<CalendarEvent>, zone: ZoneId): Map<LocalDate, DayDots> =
        events.sortedWith(byStart)
            .groupBy { CalendarDates.dayOf(it.start, zone) }
            .mapValues { (_, list) -> DayDots(list.take(MAX_DOTS).map { eventColor(it.color, it.type) }, list.size) }

    fun counts(events: List<CalendarEvent>, today: LocalDate, zone: ZoneId): AgendaCounts {
        val weekEnd = CalendarDates.endOf(today.plusDays(6), zone)
        return AgendaCounts(
            today = events.count { CalendarDates.dayOf(it.start, zone) == today },
            nextSevenDays = events.count { !it.start.isAfter(weekEnd) },
        )
    }

    /** Over: its end (or start, when open-ended) has passed. */
    fun isPast(event: CalendarEvent, now: Instant): Boolean = (event.end ?: event.start).isBefore(now)

    /** Happening now. An open-ended event counts for an hour after its start, as the web grid draws it. */
    fun isOngoing(event: CalendarEvent, now: Instant): Boolean {
        val end = event.end ?: event.start.plus(Duration.ofHours(1))
        return !event.start.isAfter(now) && !now.isAfter(end)
    }
}

/** Who may write where; the server checks the same, this keeps the app from offering a 403. */
object CalendarAccess {
    fun writable(calendars: List<CalendarInfo>): List<CalendarInfo> = calendars.filter { it.canWrite }

    /** Access follows the calendar. An event whose calendar isn't listed (yet) is read-only. */
    fun canEdit(event: CalendarEvent, calendars: List<CalendarInfo>): Boolean =
        calendars.firstOrNull { it.id == event.calendarId }?.canWrite == true

    /** Own calendars (default first, as the server sends them), then the ones shared with the person. */
    fun sections(calendars: List<CalendarInfo>): Pair<List<CalendarInfo>, List<CalendarInfo>> =
        calendars.filter { it.isOwn } to calendars.filterNot { it.isOwn }
}

/** Which calendars the agenda and the grid ask for. */
object Visibility {
    /** A value no calendar has: every calendar hidden must not read as "no filter". */
    const val NONE = "__none__"

    /**
     * `calendarIds` for the range request: null when nothing is hidden (the
     * server then reads every calendar, a newly shared one included).
     */
    fun calendarIdsParam(all: List<CalendarInfo>, hidden: Set<String>): String? {
        if (hidden.isEmpty()) return null
        val visible = all.map { it.id }.filterNot { it in hidden }
        return if (visible.isEmpty()) NONE else visible.joinToString(",")
    }
}

/** Colours, as `#RRGGBB` strings; the UI turns them into colours. */
const val BRAND_HEX = "#E5375E"

/** Type colours, the same as the web app's `EVENT_TYPE_COLORS`. */
fun typeColor(type: EventType): String = when (type) {
    EventType.MEETING -> "#3B82F6"
    EventType.CALL -> "#22C55E"
    EventType.APPOINTMENT -> "#8B5CF6"
    EventType.EVENT -> "#F59E0B"
    EventType.REMINDER -> "#EF4444"
    EventType.OTHER -> "#6B7280"
}

/** The colour of a task placed in the calendar. */
const val TASK_HEX = "#6366F1"

/** The palette offered for a new calendar, as on the web. */
val CALENDAR_COLORS = listOf(
    "#FE466C", "#EF4444", "#F59E0B", "#EAB308", "#22C55E", "#10B981",
    "#06B6D4", "#3B82F6", "#6366F1", "#8B5CF6", "#EC4899", "#6B7280",
)

/** An event's own colour when it has a valid one, else its type's. */
fun eventColor(color: String?, type: EventType): String = color?.takeIf { parseHex(it) != null } ?: typeColor(type)

/** `#RGB` or `#RRGGBB` as 0xRRGGBB; null for anything else. */
fun parseHex(text: String?): Long? {
    val value = text?.trim()?.removePrefix("#") ?: return null
    val full = when (value.length) {
        6 -> value
        3 -> value.map { "$it$it" }.joinToString("")
        else -> return null
    }
    return full.toLongOrNull(16)
}

/** Ids in links and pushes become path segments: only `[A-Za-z0-9_-]`. */
private val SAFE_ID = Regex("^[A-Za-z0-9_-]+$")

fun safeId(value: String?): String? = value?.takeIf { SAFE_ID.matches(it) }

/**
 * The event a tapped push opens: `eventId`, else `entityId` of a
 * `calendar_event`, else the `event` of its `actionUrl`
 * (`/weldcalendar?event=evt_1`).
 */
fun eventIdFromPush(values: Map<String, String>): String? {
    val explicit = values["eventId"]?.takeIf { it.isNotEmpty() }
    val entity = values["entityId"]?.takeIf { values["entityType"] == "calendar_event" && it.isNotEmpty() }
    val fromUrl = values["actionUrl"]?.let { Regex("""[?&]event=([^&#]+)""").find(it)?.groupValues?.get(1) }
    return safeId(explicit ?: entity ?: fromUrl)
}

/** Where a `weldcalendar://` link goes. */
sealed interface CalendarLink {
    data class Event(val id: String) : CalendarLink
    data class EditEvent(val id: String) : CalendarLink
    data class NewEvent(val day: LocalDate?) : CalendarLink
    data class Tab(val route: String) : CalendarLink
}

/**
 * `weldcalendar://event/<id>`, `…/event/edit/<id>`, `…/event/new?date=2026-11-27`,
 * and the tabs (`agenda`, `month`, `calendars`, `more`, `settings`), the
 * paths the Expo app's router answered.
 */
fun parseCalendarLink(url: String?): CalendarLink? {
    val text = url?.trim() ?: return null
    val rest = text.substringAfter("://", missingDelimiterValue = "").takeIf { text.startsWith("weldcalendar://") } ?: return null
    val path = rest.substringBefore('?').substringBefore('#')
    val query = rest.substringAfter('?', missingDelimiterValue = "")
    val segments = path.split('/').filter { it.isNotEmpty() }
    return when {
        segments.isEmpty() -> CalendarLink.Tab("agenda")
        segments[0] == "event" && segments.getOrNull(1) == "new" ->
            CalendarLink.NewEvent(CalendarDates.parseDay(queryValue(query, "date")))
        segments[0] == "event" && segments.getOrNull(1) == "edit" -> safeId(segments.getOrNull(2))?.let { CalendarLink.EditEvent(it) }
        segments[0] == "event" -> safeId(segments.getOrNull(1))?.let { CalendarLink.Event(it) }
        segments[0] in setOf("agenda", "month", "calendars", "more") -> CalendarLink.Tab(segments[0])
        segments[0] == "settings" -> CalendarLink.Tab("more")
        segments[0] == "sso-callback" -> null
        else -> null
    }
}

private fun queryValue(query: String, name: String): String? =
    query.split('&').map { it.split('=', limit = 2) }.firstOrNull { it[0] == name }?.getOrNull(1)

/**
 * The zone to send with an event: the phone's when it's an IANA name
 * (`Europe/Amsterdam`, `UTC`). The server refuses one it doesn't know, and
 * an offset id (`GMT+01:00`) is no IANA name, so then none is sent.
 */
fun ianaZone(id: String?): String? {
    val value = id?.trim()?.takeIf { it.isNotEmpty() && it.length <= 50 } ?: return null
    if (value == "UTC") return value
    return value.takeIf { Regex("""^[A-Za-z]+(/[A-Za-z0-9_+\-]+)+$""").matches(it) }
}

/** A plain check for an address someone typed: something@something.tld, no spaces. */
fun isValidEmail(text: String): Boolean = Regex("""^[^\s@]+@[^\s@]+\.[^\s@]+$""").matches(text.trim())

/** An http(s) link, as the server requires for a meeting link. */
fun isHttpUrl(text: String): Boolean {
    val value = text.trim()
    if (!(value.startsWith("http://", ignoreCase = true) || value.startsWith("https://", ignoreCase = true))) return false
    return value.substringAfter("://").substringBefore('/').isNotEmpty()
}

/** How many guests answered which way. */
data class GuestAnswers(val accepted: Int, val declined: Int, val tentative: Int, val pending: Int)

fun guestAnswers(guests: List<Guest>): GuestAnswers = GuestAnswers(
    accepted = guests.count { it.response == GuestResponse.ACCEPTED },
    declined = guests.count { it.response == GuestResponse.DECLINED },
    tentative = guests.count { it.response == GuestResponse.TENTATIVE },
    pending = guests.count { it.response == GuestResponse.PENDING },
)
