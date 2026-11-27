package com.weldsuite.weldcalendar

import java.time.Instant

/** What kind of event it is: drives its colour and its chip. */
enum class EventType(val wire: String) {
    MEETING("meeting"),
    CALL("call"),
    APPOINTMENT("appointment"),
    EVENT("event"),
    REMINDER("reminder"),
    OTHER("other"),
    ;

    companion object {
        /** A value the form doesn't offer reads as [OTHER]. */
        fun of(wire: String?): EventType = entries.firstOrNull { it.wire == wire } ?: OTHER
    }
}

enum class EventStatus(val wire: String) {
    CONFIRMED("confirmed"),
    TENTATIVE("tentative"),
    CANCELLED("cancelled"),
    ;

    companion object {
        /** Null for a value the app doesn't know: no pill rather than a wrong one. */
        fun of(wire: String?): EventStatus? = entries.firstOrNull { it.wire == wire }
    }
}

enum class EventPriority(val wire: String) {
    LOW("low"),
    NORMAL("normal"),
    HIGH("high"),
    URGENT("urgent"),
    ;

    companion object {
        fun of(wire: String?): EventPriority? = entries.firstOrNull { it.wire == wire }
    }
}

/** view = read events · edit = create and change them · manage = edit + share + delete. */
enum class CalendarPermission(val wire: String) {
    VIEW("view"),
    EDIT("edit"),
    MANAGE("manage"),
    ;

    companion object {
        /** An unknown level is the safest one. */
        fun of(wire: String?): CalendarPermission = entries.firstOrNull { it.wire == wire } ?: VIEW
    }
}

/** A guest's answer to an invitation. */
enum class GuestResponse {
    ACCEPTED,
    DECLINED,
    TENTATIVE,
    PENDING,
    ;

    companion object {
        /** `accepted`, `declined`, `tentative`; anything else (`pending`, Google's `needsAction`) is no answer yet. */
        fun of(status: String?): GuestResponse = when (status?.trim()?.lowercase()) {
            "accepted", "yes" -> ACCEPTED
            "declined", "no" -> DECLINED
            "tentative", "maybe" -> TENTATIVE
            else -> PENDING
        }
    }
}

/** A calendar as the screens use it, mapped from the API in [CalendarRepository]. */
data class CalendarInfo(
    val id: String,
    val name: String,
    val description: String?,
    /** `#RRGGBB`, or null for the brand colour. */
    val color: String?,
    val isDefault: Boolean,
    /** False for a calendar shared with the person. */
    val isOwn: Boolean,
    val permission: CalendarPermission,
) {
    /** `view` is read-only; owners and `edit`/`manage` shares may write events. */
    val canWrite: Boolean get() = isOwn || permission == CalendarPermission.EDIT || permission == CalendarPermission.MANAGE
}

/** One guest of an event. [status] and [role] are kept as stored so an edit sends them back unchanged. */
data class Guest(
    val email: String,
    val name: String?,
    val status: String?,
    val role: String?,
) {
    val response: GuestResponse get() = GuestResponse.of(status)

    /** Name, else the address. */
    val label: String get() = name?.takeIf { it.isNotBlank() } ?: email
}

/** An event as the screens use it. Times are instants; the screens show them in the phone's zone. */
data class CalendarEvent(
    val id: String,
    val calendarId: String,
    val title: String,
    val description: String?,
    val type: EventType,
    val start: Instant,
    /** Null for an open-ended event. */
    val end: Instant?,
    val allDay: Boolean,
    /** The IANA zone it was scheduled in, if the server knows it. */
    val timezone: String?,
    val location: String?,
    val isVirtual: Boolean,
    val meetingUrl: String?,
    /** Null for a status the app doesn't know. */
    val status: EventStatus?,
    val priority: EventPriority?,
    val color: String?,
    /** An RRULE, or null when it doesn't repeat. */
    val recurrenceRule: String?,
    val guests: List<Guest>,
    /** `task` or `activity` when WeldSuite placed it. */
    val sourceType: String?,
    val autoScheduled: Boolean,
    val notes: String?,
) {
    val isTask: Boolean get() = sourceType == "task"
    val isCancelled: Boolean get() = status == EventStatus.CANCELLED
}
