package com.weldsuite.weldcalendar

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import org.weldsuite.api.weldcalendar.apis.DefaultApi
import org.weldsuite.api.weldcalendar.models.AttendeeInput
import org.weldsuite.api.weldcalendar.models.CalendarInput
import org.weldsuite.api.weldcalendar.models.EventInput
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.LoadState
import org.weldsuite.core.WeldDate
import org.weldsuite.core.api.apiCall
import org.weldsuite.core.api.apiCallNoContent
import org.weldsuite.core.storage.PreferencesStore
import java.time.Instant
import java.time.ZoneId
import org.weldsuite.api.weldcalendar.models.Calendar as ApiCalendar
import org.weldsuite.api.weldcalendar.models.CalendarEvent as ApiEvent

/**
 * Calendars and events of the active workspace. The generated API types are
 * mapped to the app's own models here and nowhere else, so a generator
 * rename stays in this file.
 */
class CalendarRepository(private val env: AppEnvironment, context: Context) {
    private val api: DefaultApi get() = env.api.create()
    private val store = PreferencesStore(context, "weldcalendar.ui")

    private val calendarsState = MutableStateFlow(LoadState<List<CalendarInfo>>())
    private val changesState = MutableStateFlow(0)
    private val hiddenState = MutableStateFlow(readHidden())
    private var workspace: String? = null
    /** Whether the default calendar was asked for in this workspace: once, so a failure doesn't loop. */
    private var ensuredFor: String? = null

    /** The calendars the person can see: their own (default first), then the ones shared with them. */
    val calendars: StateFlow<LoadState<List<CalendarInfo>>> = calendarsState.asStateFlow()

    /** Goes up after every change made here, so open lists reload. */
    val changes: StateFlow<Int> = changesState.asStateFlow()

    /**
     * Calendars hidden from the agenda and the grid, kept on the phone. A
     * hidden set rather than a shown one: a calendar shared later shows up
     * without a hunt for its switch.
     */
    val hidden: StateFlow<Set<String>> = hiddenState.asStateFlow()

    /** Forget another workspace's calendars the moment the workspace changes. */
    fun useWorkspace(id: String) {
        if (workspace == id) return
        workspace = id
        calendarsState.value = LoadState()
    }

    suspend fun refreshCalendars() {
        val forWorkspace = workspace
        calendarsState.update { it.copy(loading = true, error = null) }
        val result = runCatching { apiCall { api.listCalendars() }.data.map(::calendarOf) }
        if (workspace != forWorkspace) return
        calendarsState.value = result.fold(
            onSuccess = { LoadState(it) },
            onFailure = { LoadState(calendarsState.value.data, error = it) },
        )
    }

    /**
     * A member who never opened WeldCalendar on the web owns no calendar, so
     * the form would have nowhere to write: provision the default one (once
     * per workspace) instead of an empty state they can't act on.
     */
    suspend fun ensureDefaultIfNeeded(): Result<Unit> {
        val list = calendarsState.value.data ?: return Result.success(Unit)
        val current = workspace
        if (list.any { it.isOwn } || ensuredFor == current) return Result.success(Unit)
        ensuredFor = current
        return runCatching {
            apiCall { api.ensureDefaultCalendar() }
            refreshCalendars()
        }
    }

    suspend fun createCalendar(name: String, description: String, color: String) {
        apiCall {
            api.createCalendar(
                CalendarInput(name = name.trim(), description = description.trim().ifEmpty { null }, color = color),
            )
        }
        refreshCalendars()
        changesState.update { it + 1 }
    }

    fun toggleHidden(calendarId: String) {
        val next = hiddenState.value.let { if (calendarId in it) it - calendarId else it + calendarId }
        hiddenState.value = next
        store.set(HIDDEN_KEY, next.sorted().joinToString(","))
    }

    /** Events overlapping the window, earliest first. */
    suspend fun events(start: Instant, end: Instant, calendarIds: String?): List<CalendarEvent> =
        apiCall {
            api.listEventsInRange(WeldDate.timestampString(start), WeldDate.timestampString(end), calendarIds)
        }.data.mapNotNull(::eventOf).sortedBy { it.start }

    suspend fun event(id: String): CalendarEvent =
        eventOf(apiCall { api.getEvent(id) }.data) ?: throw IllegalStateException("Unreadable event")

    /** Add an event; its id. Guests are mailed an invitation by the server. */
    suspend fun create(draft: EventDraft, zone: ZoneId = ZoneId.systemDefault()): String {
        val id = apiCall { api.createEvent(createInput(draft, zone)) }.data.id
        changesState.update { it + 1 }
        return id
    }

    /** Change an event: the fields that differ from [original], guests mailed when the draft says so. */
    suspend fun update(original: CalendarEvent, draft: EventDraft, zone: ZoneId = ZoneId.systemDefault()) {
        apiCall { api.updateEvent(original.id, updateInput(original, draft, zone), draft.notifyGuests.takeIf { it }) }
        changesState.update { it + 1 }
    }

    suspend fun delete(id: String, notifyGuests: Boolean) {
        apiCallNoContent { api.deleteEvent(id, notifyGuests.takeIf { it }) }
        changesState.update { it + 1 }
    }

    /** Signed out or switched: nothing of this workspace stays in memory. */
    fun clear() {
        workspace = null
        ensuredFor = null
        calendarsState.value = LoadState()
    }

    private fun readHidden(): Set<String> =
        store.get(HIDDEN_KEY)?.split(',')?.filter { it.isNotBlank() }?.toSet().orEmpty()

    companion object {
        private const val HIDDEN_KEY = "hiddenCalendars"

        fun calendarOf(calendar: ApiCalendar): CalendarInfo = CalendarInfo(
            id = calendar.id,
            name = calendar.name,
            description = calendar.description?.takeIf { it.isNotBlank() },
            color = calendar.color?.takeIf { parseHex(it) != null },
            isDefault = calendar.isDefault == true,
            // Absent only outside the list; the list always says.
            isOwn = calendar.isOwn ?: false,
            permission = if (calendar.isOwn == true) CalendarPermission.MANAGE else CalendarPermission.of(calendar.permission),
        )

        /** Null for a row whose start can't be read: one bad row mustn't empty the agenda. */
        fun eventOf(event: ApiEvent): CalendarEvent? {
            val start = WeldDate.parse(event.startTime) ?: return null
            return CalendarEvent(
                id = event.id,
                calendarId = event.calendarId,
                title = event.title,
                description = event.description?.takeIf { it.isNotBlank() },
                type = EventType.of(event.type),
                start = start,
                end = WeldDate.parse(event.endTime),
                allDay = event.allDay == true,
                timezone = event.timezone?.takeIf { it.isNotBlank() },
                location = event.location?.takeIf { it.isNotBlank() },
                isVirtual = event.isVirtual == true,
                meetingUrl = event.meetingUrl?.takeIf { it.isNotBlank() },
                status = EventStatus.of(event.status),
                priority = EventPriority.of(event.priority),
                color = event.color?.takeIf { it.isNotBlank() },
                recurrenceRule = event.recurrenceRule?.takeIf { it.isNotBlank() },
                guests = event.attendees.orEmpty().mapNotNull { attendee ->
                    val email = attendee.email?.trim()?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
                    Guest(email = email, name = attendee.name?.takeIf { it.isNotBlank() }, status = attendee.status, role = attendee.role)
                },
                sourceType = event.sourceType,
                autoScheduled = event.autoScheduled == true,
                notes = event.notes?.takeIf { it.isNotBlank() },
                createdAt = WeldDate.parse(event.createdAt),
            )
        }

        /** A wall-clock time in [zone], as the server takes an instant. */
        private fun instant(time: java.time.LocalDateTime, zone: ZoneId): String =
            WeldDate.timestampString(time.atZone(zone).toInstant())

        private fun guestInput(guest: Guest) = AttendeeInput(
            email = guest.email,
            name = guest.name?.takeIf { it.isNotBlank() },
            status = guest.status?.takeIf { it.isNotBlank() },
            role = guest.role?.takeIf { it.isNotBlank() },
        )

        /** A new event: empty fields stay out; the phone's zone goes along when it's an IANA name. */
        fun createInput(draft: EventDraft, zone: ZoneId): EventInput {
            val meetingUrl = draft.meetingUrl.trim()
            return EventInput(
                calendarId = draft.calendarId,
                title = draft.title.trim(),
                description = draft.description.trim().ifEmpty { null },
                type = inputType(draft.type),
                startTime = instant(draft.start, zone),
                endTime = instant(draft.end, zone),
                allDay = draft.allDay,
                timezone = ianaZone(zone.id),
                location = draft.location.trim().ifEmpty { null },
                isVirtual = meetingUrl.isNotEmpty(),
                meetingUrl = meetingUrl.ifEmpty { null },
                status = inputStatus(draft.status),
                priority = inputPriority(draft.priority),
                recurrenceRule = draft.recurrenceRule.trim().ifEmpty { null },
                attendees = draft.guests.takeIf { it.isNotEmpty() }?.map(::guestInput),
            )
        }

        /**
         * A change: the form's fields, an empty string clearing a text field.
         * The calendar, the rule and the guests only when they changed, so an
         * edit of the title doesn't rewrite the guest list.
         */
        fun updateInput(original: CalendarEvent, draft: EventDraft, zone: ZoneId): EventInput {
            val meetingUrl = draft.meetingUrl.trim()
            val rule = draft.recurrenceRule.trim()
            return EventInput(
                calendarId = draft.calendarId.takeIf { it != original.calendarId },
                title = draft.title.trim(),
                description = draft.description.trim(),
                type = inputType(draft.type),
                startTime = instant(draft.start, zone),
                endTime = instant(draft.end, zone),
                allDay = draft.allDay,
                timezone = ianaZone(zone.id),
                location = draft.location.trim(),
                isVirtual = meetingUrl.isNotEmpty(),
                meetingUrl = meetingUrl,
                status = inputStatus(draft.status),
                priority = inputPriority(draft.priority),
                recurrenceRule = rule.takeIf { it != original.recurrenceRule.orEmpty() },
                attendees = draft.guests.takeIf { it != original.guests }?.map(::guestInput),
            )
        }

        private fun inputType(type: EventType): EventInput.Type = when (type) {
            EventType.MEETING -> EventInput.Type.MEETING
            EventType.CALL -> EventInput.Type.CALL
            EventType.APPOINTMENT -> EventInput.Type.APPOINTMENT
            EventType.EVENT -> EventInput.Type.EVENT
            EventType.REMINDER -> EventInput.Type.REMINDER
            EventType.OTHER -> EventInput.Type.OTHER
        }

        private fun inputStatus(status: EventStatus): EventInput.Status = when (status) {
            EventStatus.CONFIRMED -> EventInput.Status.CONFIRMED
            EventStatus.TENTATIVE -> EventInput.Status.TENTATIVE
            EventStatus.CANCELLED -> EventInput.Status.CANCELLED
        }

        private fun inputPriority(priority: EventPriority): EventInput.Priority = when (priority) {
            EventPriority.LOW -> EventInput.Priority.LOW
            EventPriority.NORMAL -> EventInput.Priority.NORMAL
            EventPriority.HIGH -> EventInput.Priority.HIGH
            EventPriority.URGENT -> EventInput.Priority.URGENT
        }
    }
}
