package com.weldsuite.weldcalendar

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.YearMonth
import java.time.ZoneId

class CalendarLogicTest {
    private val amsterdam = ZoneId.of("Europe/Amsterdam")

    private fun event(
        id: String,
        start: String,
        end: String? = null,
        type: EventType = EventType.MEETING,
        color: String? = null,
        calendarId: String = "cal_1",
        status: EventStatus? = EventStatus.CONFIRMED,
    ) = CalendarEvent(
        id = id,
        calendarId = calendarId,
        title = id,
        description = null,
        type = type,
        start = Instant.parse(start),
        end = end?.let(Instant::parse),
        allDay = false,
        timezone = null,
        location = null,
        isVirtual = false,
        meetingUrl = null,
        status = status,
        priority = null,
        color = color,
        recurrenceRule = null,
        guests = emptyList(),
        sourceType = null,
        autoScheduled = false,
        notes = null,
    )

    private fun calendar(id: String, own: Boolean = true, permission: CalendarPermission = CalendarPermission.MANAGE) =
        CalendarInfo(id, id, null, null, isDefault = false, isOwn = own, permission = permission)

    @Test
    fun theAppIdMatchesTheExpoApp() {
        assertEquals("com.weldsuite.weldcalendar", BuildConfig.APPLICATION_ID.removeSuffix(".dev"))
    }

    @Test
    fun theMonthGridIsSixMondayFirstWeeks() {
        val weeks = CalendarDates.monthMatrix(YearMonth.of(2026, 11))
        assertEquals(6, weeks.size)
        assertTrue(weeks.all { it.size == 7 })
        // 1 November 2026 is a Sunday: the grid starts on Monday 26 October.
        assertEquals(LocalDate.of(2026, 10, 26), weeks.first().first())
        assertEquals(DayOfWeek.MONDAY, weeks.first().first().dayOfWeek)
        assertEquals(LocalDate.of(2026, 12, 6), weeks.last().last())
    }

    @Test
    fun theMonthWindowCoversTheGridWithADayOfSlack() {
        val (start, end) = CalendarDates.monthWindow(YearMonth.of(2026, 11), amsterdam)
        assertEquals(LocalDate.of(2026, 10, 25), CalendarDates.dayOf(start, amsterdam))
        assertEquals(LocalDate.of(2026, 12, 7), CalendarDates.dayOf(end, amsterdam))
        assertEquals(Instant.parse("2026-10-24T22:00:00Z"), start)
    }

    @Test
    fun theAgendaRunsFromMidnightForTwoWeeks() {
        val (start, end) = CalendarDates.agendaWindow(LocalDate.of(2026, 11, 27), amsterdam)
        assertEquals(Instant.parse("2026-11-26T23:00:00Z"), start)
        assertEquals(Instant.parse("2026-12-11T22:59:59.999Z"), end)
    }

    @Test
    fun eventsAreGroupedByTheirLocalStartDay() {
        val sections = EventLists.groupByDay(
            listOf(
                event("late", "2026-11-27T22:30:00Z"),
                event("b", "2026-11-27T10:00:00Z"),
                event("a", "2026-11-27T08:00:00Z"),
            ),
            amsterdam,
        )
        // 22:30 UTC is 23:30 in Amsterdam, still the 27th; nothing moves to the 28th.
        assertEquals(listOf(LocalDate.of(2026, 11, 27)), sections.map { it.day })
        assertEquals(listOf("a", "b", "late"), sections.single().events.map { it.id })
        val utcSections = EventLists.groupByDay(listOf(event("x", "2026-11-27T23:30:00Z")), amsterdam)
        assertEquals(LocalDate.of(2026, 11, 28), utcSections.single().day)
    }

    @Test
    fun aDayShowsThreeDotsAndCountsTheRest() {
        val day = "2026-11-27T"
        val dots = EventLists.dots(
            listOf(
                event("1", "${day}08:00:00Z", type = EventType.CALL),
                event("2", "${day}09:00:00Z", color = "#123456"),
                event("3", "${day}10:00:00Z", color = "nope", type = EventType.REMINDER),
                event("4", "${day}11:00:00Z"),
            ),
            amsterdam,
        )[LocalDate.of(2026, 11, 27)]!!
        assertEquals(listOf("#22C55E", "#123456", "#EF4444"), dots.colors)
        assertEquals(4, dots.total)
        assertEquals(1, dots.overflow)
    }

    @Test
    fun theAgendaCountsTodayAndTheNextSevenDays() {
        val counts = EventLists.counts(
            listOf(
                event("today", "2026-11-27T09:00:00Z"),
                event("day6", "2026-12-03T20:00:00Z"),
                event("day7", "2026-12-04T09:00:00Z"),
            ),
            LocalDate.of(2026, 11, 27),
            amsterdam,
        )
        assertEquals(1, counts.today)
        assertEquals(2, counts.nextSevenDays)
    }

    @Test
    fun pastAndOngoingFollowTheEndOrAnHour() {
        val now = Instant.parse("2026-11-27T10:30:00Z")
        assertTrue(EventLists.isPast(event("p", "2026-11-27T08:00:00Z", "2026-11-27T09:00:00Z"), now))
        assertTrue(EventLists.isOngoing(event("o", "2026-11-27T10:00:00Z", "2026-11-27T11:00:00Z"), now))
        assertTrue(EventLists.isOngoing(event("open", "2026-11-27T09:45:00Z"), now))
        assertFalse(EventLists.isOngoing(event("open-old", "2026-11-27T09:00:00Z"), now))
    }

    @Test
    fun durationsAreHoursAndMinutes() {
        val start = Instant.parse("2026-11-27T09:00:00Z")
        assertEquals(1L to 30L, CalendarDates.duration(start, Instant.parse("2026-11-27T10:30:00Z")))
        assertEquals(0L to 45L, CalendarDates.duration(start, Instant.parse("2026-11-27T09:45:00Z")))
        assertNull(CalendarDates.duration(start, start))
        assertNull(CalendarDates.duration(start, null))
    }

    @Test
    fun aNewEventStartsAtNineOrTheNextWholeHour() {
        val morning = LocalDateTime.of(2026, 11, 27, 8, 20)
        val afternoon = LocalDateTime.of(2026, 11, 27, 16, 5)
        assertEquals(LocalDateTime.of(2026, 11, 27, 9, 0), CalendarDates.startFor(null, morning))
        assertEquals(LocalDateTime.of(2026, 11, 27, 9, 0), CalendarDates.startFor(LocalDate.of(2026, 11, 27), morning))
        assertEquals(LocalDateTime.of(2026, 11, 27, 17, 0), CalendarDates.startFor(LocalDate.of(2026, 11, 27), afternoon))
        assertEquals(LocalDateTime.of(2026, 12, 19, 9, 0), CalendarDates.startFor(LocalDate.of(2026, 12, 19), afternoon))
    }

    @Test
    fun allDaySnapsToTheDayAndBack() {
        val start = LocalDateTime.of(2026, 11, 27, 14, 0)
        val (allDayStart, allDayEnd) = CalendarDates.allDayRange(true, start, start.plusHours(1))
        assertEquals(LocalDateTime.of(2026, 11, 27, 0, 0), allDayStart)
        assertEquals(LocalDateTime.of(2026, 11, 27, 23, 59, 59, 999_000_000), allDayEnd)
        val (timedStart, timedEnd) = CalendarDates.allDayRange(false, allDayStart, allDayEnd)
        assertEquals(LocalDateTime.of(2026, 11, 27, 9, 0), timedStart)
        assertEquals(LocalDateTime.of(2026, 11, 27, 10, 0), timedEnd)
    }

    @Test
    fun relativeDaysNameTodayTomorrowAndYesterday() {
        val today = LocalDate.of(2026, 11, 27)
        assertEquals(RelativeDay.TODAY, relativeDay(today, today))
        assertEquals(RelativeDay.TOMORROW, relativeDay(today.plusDays(1), today))
        assertEquals(RelativeDay.YESTERDAY, relativeDay(today.minusDays(1), today))
        assertEquals(RelativeDay.THIS_YEAR, relativeDay(today.plusDays(5), today))
        assertEquals(RelativeDay.OTHER_YEAR, relativeDay(LocalDate.of(2027, 1, 4), today))
    }

    @Test
    fun hiddenCalendarsNarrowTheRequest() {
        val all = listOf(calendar("a"), calendar("b"))
        assertNull(Visibility.calendarIdsParam(all, emptySet()))
        assertEquals("b", Visibility.calendarIdsParam(all, setOf("a")))
        assertEquals(Visibility.NONE, Visibility.calendarIdsParam(all, setOf("a", "b")))
    }

    @Test
    fun onlyOwnersAndEditorsWrite() {
        val own = calendar("own")
        val edit = calendar("edit", own = false, permission = CalendarPermission.EDIT)
        val view = calendar("view", own = false, permission = CalendarPermission.VIEW)
        assertEquals(listOf(own, edit), CalendarAccess.writable(listOf(own, edit, view)))
        assertTrue(CalendarAccess.canEdit(event("e", "2026-11-27T09:00:00Z", calendarId = "edit"), listOf(own, edit, view)))
        assertFalse(CalendarAccess.canEdit(event("v", "2026-11-27T09:00:00Z", calendarId = "view"), listOf(own, edit, view)))
        assertFalse(CalendarAccess.canEdit(event("x", "2026-11-27T09:00:00Z", calendarId = "gone"), listOf(own)))
        assertEquals(listOf(own) to listOf(edit, view), CalendarAccess.sections(listOf(own, edit, view)))
    }

    @Test
    fun anUnknownPermissionIsViewOnly() {
        assertEquals(CalendarPermission.VIEW, CalendarPermission.of("owner"))
        assertEquals(EventType.OTHER, EventType.of("task"))
        assertNull(EventStatus.of("busy"))
    }

    @Test
    fun colorsFallBackToTheType() {
        assertEquals("#3B82F6", eventColor(null, EventType.MEETING))
        assertEquals("#abc", eventColor("#abc", EventType.MEETING))
        assertEquals("#6B7280", eventColor("blue", EventType.OTHER))
        assertEquals(0xAABBCCL, parseHex("#abc"))
        assertNull(parseHex("#12345"))
    }

    @Test
    fun aPushOpensItsEvent() {
        assertEquals("evt_1", eventIdFromPush(mapOf("eventId" to "evt_1")))
        assertEquals("evt_2", eventIdFromPush(mapOf("entityType" to "calendar_event", "entityId" to "evt_2")))
        assertNull(eventIdFromPush(mapOf("entityType" to "task", "entityId" to "tsk_1")))
        assertEquals("evt_3", eventIdFromPush(mapOf("actionUrl" to "/weldcalendar?view=week&event=evt_3#x")))
        assertNull(eventIdFromPush(mapOf("eventId" to "../../etc")))
        assertNull(eventIdFromPush(emptyMap()))
    }

    @Test
    fun linksOpenWhatTheExpoAppsRouterOpened() {
        assertEquals(CalendarLink.Event("evt_1"), parseCalendarLink("weldcalendar://event/evt_1"))
        assertEquals(CalendarLink.EditEvent("evt_1"), parseCalendarLink("weldcalendar://event/edit/evt_1"))
        assertEquals(CalendarLink.NewEvent(LocalDate.of(2026, 12, 19)), parseCalendarLink("weldcalendar://event/new?date=2026-12-19"))
        assertEquals(CalendarLink.NewEvent(null), parseCalendarLink("weldcalendar://event/new?date=tomorrow"))
        assertEquals(CalendarLink.Tab("month"), parseCalendarLink("weldcalendar://month"))
        assertEquals(CalendarLink.Tab("more"), parseCalendarLink("weldcalendar://settings/privacy"))
        assertNull(parseCalendarLink("weldcalendar://sso-callback?code=x"))
        assertNull(parseCalendarLink("https://example.com/event/evt_1"))
        assertNull(parseCalendarLink("weldcalendar://event/evt%2F1"))
    }

    @Test
    fun onlyIanaZonesAreSent() {
        assertEquals("Europe/Amsterdam", ianaZone("Europe/Amsterdam"))
        assertEquals("America/Argentina/Buenos_Aires", ianaZone("America/Argentina/Buenos_Aires"))
        assertEquals("UTC", ianaZone("UTC"))
        assertNull(ianaZone("GMT+01:00"))
        assertNull(ianaZone("+01:00"))
        assertNull(ianaZone(""))
    }

    @Test
    fun emailsAndLinksAreChecked() {
        assertTrue(isValidEmail(" ann@example.com "))
        assertFalse(isValidEmail("ann@example"))
        assertFalse(isValidEmail("ann example.com"))
        assertTrue(isHttpUrl("https://meet.example.com/abc"))
        assertFalse(isHttpUrl("meet.example.com"))
        assertFalse(isHttpUrl("https://"))
    }

    @Test
    fun guestAnswersAreCounted() {
        val guests = listOf(
            Guest("a@x.test", null, "accepted", null),
            Guest("b@x.test", null, "needsAction", null),
            Guest("c@x.test", null, "declined", null),
            Guest("d@x.test", null, "tentative", null),
            Guest("e@x.test", null, null, null),
        )
        assertEquals(GuestAnswers(accepted = 1, declined = 1, tentative = 1, pending = 2), guestAnswers(guests))
    }
}
