package com.weldsuite.weldcalendar

import java.time.LocalDateTime
import java.time.ZoneId

/** The most guests an event may have (every one is mailed). */
const val MAX_GUESTS = 100

/**
 * The event form's values. Times are wall-clock times in the phone's zone:
 * the pickers show them, and they become instants only when sent.
 */
data class EventDraft(
    val calendarId: String,
    val title: String = "",
    val description: String = "",
    val type: EventType = EventType.MEETING,
    val start: LocalDateTime,
    val end: LocalDateTime,
    val allDay: Boolean = false,
    val location: String = "",
    val meetingUrl: String = "",
    val status: EventStatus = EventStatus.CONFIRMED,
    val priority: EventPriority = EventPriority.NORMAL,
    /** The stored RRULE; empty when it doesn't repeat. */
    val recurrenceRule: String = "",
    val guests: List<Guest> = emptyList(),
    /** Edit only: mail the guests about the change. */
    val notifyGuests: Boolean = false,
) {
    companion object {
        /** A new event: [start] for an hour, on the first calendar the person may write to. */
        fun new(calendars: List<CalendarInfo>, start: LocalDateTime): EventDraft =
            EventDraft(calendarId = calendars.firstOrNull()?.id.orEmpty(), start = start, end = start.plusHours(1))

        /**
         * The form for an existing event. An open-ended one gets an hour, so
         * the picker has something to show; the form always writes a pair.
         */
        fun of(event: CalendarEvent, zone: ZoneId): EventDraft {
            val start = LocalDateTime.ofInstant(event.start, zone)
            val end = event.end?.let { LocalDateTime.ofInstant(it, zone) } ?: start.plusHours(1)
            return EventDraft(
                calendarId = event.calendarId,
                title = event.title,
                description = event.description.orEmpty(),
                type = event.type,
                start = start,
                end = end,
                allDay = event.allDay,
                location = event.location.orEmpty(),
                meetingUrl = event.meetingUrl.orEmpty(),
                status = event.status ?: EventStatus.CONFIRMED,
                priority = event.priority ?: EventPriority.NORMAL,
                recurrenceRule = event.recurrenceRule.orEmpty(),
                guests = event.guests,
            )
        }
    }
}

/** What's wrong with a draft; all null when it can be sent. */
data class DraftProblems(
    val titleMissing: Boolean = false,
    val endBeforeStart: Boolean = false,
    val badMeetingUrl: Boolean = false,
    val noCalendar: Boolean = false,
) {
    val isEmpty: Boolean get() = !titleMissing && !endBeforeStart && !badMeetingUrl && !noCalendar
}

fun problemsOf(draft: EventDraft): DraftProblems = DraftProblems(
    titleMissing = draft.title.isBlank(),
    endBeforeStart = !draft.end.isAfter(draft.start),
    badMeetingUrl = draft.meetingUrl.isNotBlank() && !isHttpUrl(draft.meetingUrl),
    noCalendar = draft.calendarId.isBlank(),
)

/** Why a typed guest can't be added, or null when it can. */
enum class GuestProblem { INVALID, DUPLICATE, LIMIT }

fun guestProblem(email: String, guests: List<Guest>): GuestProblem? = when {
    !isValidEmail(email) -> GuestProblem.INVALID
    guests.any { it.email.equals(email.trim(), ignoreCase = true) } -> GuestProblem.DUPLICATE
    guests.size >= MAX_GUESTS -> GuestProblem.LIMIT
    else -> null
}

/** The draft with a picked date or time applied, the end following a moved start. */
object DraftTimes {
    fun startDate(draft: EventDraft, date: java.time.LocalDate): EventDraft {
        val moved = CalendarDates.shiftStart(draft.start.with(date), draft.start, draft.end)
        return draft.copy(start = moved.first, end = moved.second)
    }

    fun startTime(draft: EventDraft, time: java.time.LocalTime): EventDraft {
        val moved = CalendarDates.shiftStart(draft.start.with(time.withSecond(0).withNano(0)), draft.start, draft.end)
        return draft.copy(start = moved.first, end = moved.second)
    }

    fun endDate(draft: EventDraft, date: java.time.LocalDate): EventDraft = draft.copy(end = draft.end.with(date))

    fun endTime(draft: EventDraft, time: java.time.LocalTime): EventDraft =
        draft.copy(end = draft.end.with(time.withSecond(0).withNano(0)))

    fun allDay(draft: EventDraft, allDay: Boolean): EventDraft {
        val range = CalendarDates.allDayRange(allDay, draft.start, draft.end)
        return draft.copy(allDay = allDay, start = range.first, end = range.second)
    }
}
