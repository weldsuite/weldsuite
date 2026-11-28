package com.weldsuite.weldcalendar

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.weldsuite.api.weldcalendar.models.Attendee
import org.weldsuite.api.weldcalendar.models.EventInput
import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneId
import org.weldsuite.api.weldcalendar.models.Calendar as ApiCalendar
import org.weldsuite.api.weldcalendar.models.CalendarEvent as ApiEvent

class EventFormTest {
    private val amsterdam = ZoneId.of("Europe/Amsterdam")
    private val start = LocalDateTime.of(2026, 11, 27, 9, 0)

    private fun apiEvent(
        startTime: String = "2026-11-27T08:00:00.000Z",
        attendees: List<Attendee>? = null,
        rule: String? = null,
    ) = ApiEvent(
        id = "evt_1",
        calendarId = "cal_1",
        title = "Review",
        description = "",
        type = "meeting",
        startTime = startTime,
        endTime = "2026-11-27T09:30:00.000Z",
        allDay = null,
        timezone = "Europe/Amsterdam",
        location = null,
        isVirtual = true,
        meetingUrl = "https://meet.example.test/x",
        status = "tentative",
        priority = null,
        color = null,
        recurrenceRule = rule,
        recurrenceId = null,
        organizerId = "user_1",
        attendees = attendees,
        sourceType = "task",
        sourceId = "tsk_1",
        autoScheduled = null,
        notes = "  ",
        createdAt = "2026-11-01T00:00:00.000Z",
        updatedAt = "2026-11-01T00:00:00.000Z",
    )

    @Test
    fun presetsWriteRulesAndReadThemBack() {
        RepeatPreset.entries.forEach { preset -> assertEquals(preset, RepeatPreset.of(preset.rule)) }
        assertEquals(RepeatPreset.WEEKLY, RepeatPreset.of("FREQ=WEEKLY"))
        assertEquals(RepeatPreset.NONE, RepeatPreset.of(null))
        assertNull(RepeatPreset.of("RRULE:FREQ=WEEKLY;INTERVAL=2"))
        assertNull(RepeatPreset.of("RRULE:FREQ=DAILY;COUNT=5"))
        assertNull(RepeatPreset.of("RRULE:FREQ=WEEKLY;BYDAY=MO"))
    }

    @Test
    fun rulesAreReadWithOrWithoutTheirPrefix() {
        val rule = RRule.parse("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=WE,MO;UNTIL=20301231T000000Z")!!
        assertEquals(RRule.Frequency.WEEKLY, rule.frequency)
        assertEquals(2, rule.interval)
        assertEquals(listOf(DayOfWeek.MONDAY, DayOfWeek.WEDNESDAY), rule.days)
        assertEquals(LocalDate.of(2030, 12, 31), rule.until)
        assertNull(rule.count)
        val monthly = RRule.parse("freq=monthly;byday=1MO;count=3")!!
        assertEquals(RRule.Frequency.MONTHLY, monthly.frequency)
        assertEquals(listOf(DayOfWeek.MONDAY), monthly.days)
        assertEquals(3, monthly.count)
        assertNull(RRule.parse("RRULE:FREQ=HOURLY"))
        assertNull(RRule.parse(""))
        assertNull(RRule.parse("DTSTART:20300101T090000Z"))
    }

    @Test
    fun aDraftNeedsATitleAnEndAfterItsStartAndAWebLink() {
        val draft = EventDraft.new(listOf(CalendarInfo("cal_1", "Mine", null, null, true, true, CalendarPermission.MANAGE)), start)
        assertEquals("cal_1", draft.calendarId)
        assertEquals(start.plusHours(1), draft.end)
        val problems = problemsOf(draft.copy(end = start, meetingUrl = "zoom.us/j/1"))
        assertTrue(problems.titleMissing)
        assertTrue(problems.endBeforeStart)
        assertTrue(problems.badMeetingUrl)
        assertTrue(problemsOf(draft.copy(title = "Review")).isEmpty)
        assertTrue(problemsOf(draft.copy(title = "Review", meetingUrl = "http://meet.example.com/abc")).isEmpty)
        assertTrue(problemsOf(draft.copy(title = "Review", meetingUrl = "mailto:ann@example.com")).badMeetingUrl)
        assertTrue(problemsOf(EventDraft.new(emptyList(), start).copy(title = "x")).noCalendar)
    }

    @Test
    fun movingTheStartCarriesTheEnd() {
        val draft = EventDraft(calendarId = "c", start = start, end = start.plusMinutes(90))
        val later = DraftTimes.startTime(draft, LocalTime.of(14, 30))
        assertEquals(LocalDateTime.of(2026, 11, 27, 14, 30), later.start)
        assertEquals(LocalDateTime.of(2026, 11, 27, 16, 0), later.end)
        val nextDay = DraftTimes.startDate(draft, LocalDate.of(2026, 11, 28))
        assertEquals(LocalDateTime.of(2026, 11, 28, 10, 30), nextDay.end)
        val endOnly = DraftTimes.endTime(draft, LocalTime.of(11, 15))
        assertEquals(start, endOnly.start)
        assertEquals(LocalDateTime.of(2026, 11, 27, 11, 15), endOnly.end)
        val allDay = DraftTimes.allDay(draft, true)
        assertTrue(allDay.allDay)
        assertEquals(LocalDateTime.of(2026, 11, 27, 0, 0), allDay.start)
    }

    @Test
    fun guestsAreCheckedBeforeTheyreAdded() {
        val guests = listOf(Guest("ann@example.test", null, null, null))
        assertEquals(GuestProblem.INVALID, guestProblem("ann", guests))
        assertEquals(GuestProblem.DUPLICATE, guestProblem("ANN@example.test", guests))
        assertEquals(GuestProblem.LIMIT, guestProblem("z@example.test", List(MAX_GUESTS) { Guest("g$it@x.test", null, null, null) }))
        assertNull(guestProblem("bob@example.test", guests))
    }

    @Test
    fun aCalendarRowMapsToTheAppsCalendar() {
        val own = CalendarRepository.calendarOf(
            ApiCalendar("cal_1", "Mine", "", "#3b82f6", "user_1", true, null, "t", "t", isOwn = true, permission = "manage"),
        )
        assertTrue(own.isOwn)
        assertTrue(own.isDefault)
        assertNull(own.description)
        assertEquals(CalendarPermission.MANAGE, own.permission)
        val shared = CalendarRepository.calendarOf(
            ApiCalendar("cal_2", "Team", "Ops", "red", "user_2", null, null, "t", "t", isOwn = false, permission = "edit"),
        )
        assertFalse(shared.isOwn)
        assertTrue(shared.canWrite)
        assertNull(shared.color)
        val outsideList = CalendarRepository.calendarOf(ApiCalendar("cal_3", "X", null, null, "u", false, true, "t", "t"))
        assertFalse(outsideList.canWrite)
    }

    @Test
    fun anEventRowMapsToTheAppsEvent() {
        val event = CalendarRepository.eventOf(
            apiEvent(
                attendees = listOf(
                    Attendee(email = "ann@example.test", name = "Ann", status = "accepted"),
                    Attendee(email = " ", name = "Nobody"),
                    Attendee(email = "bob@example.test", status = "needsAction", role = "optional"),
                ),
                rule = "RRULE:FREQ=WEEKLY",
            ),
        )!!
        assertEquals(Instant.parse("2026-11-27T08:00:00Z"), event.start)
        assertEquals(EventType.MEETING, event.type)
        assertEquals(EventStatus.TENTATIVE, event.status)
        assertNull(event.priority)
        assertFalse(event.allDay)
        assertNull(event.description)
        assertNull(event.notes)
        assertTrue(event.isTask)
        assertEquals(listOf("ann@example.test", "bob@example.test"), event.guests.map { it.email })
        assertEquals(GuestResponse.PENDING, event.guests[1].response)
        assertEquals("RRULE:FREQ=WEEKLY", event.recurrenceRule)
        assertNull(CalendarRepository.eventOf(apiEvent(startTime = "not a date")))
    }

    @Test
    fun aNewEventSendsInstantsAndLeavesEmptyFieldsOut() {
        val draft = EventDraft(
            calendarId = "cal_1",
            title = "  Review ",
            type = EventType.CALL,
            start = start,
            end = start.plusHours(1),
            meetingUrl = " https://meet.example.test/x ",
            recurrenceRule = RepeatPreset.WEEKLY.rule,
            guests = listOf(Guest("ann@example.test", "Ann", null, null)),
        )
        val input = CalendarRepository.createInput(draft, amsterdam)
        assertEquals("Review", input.title)
        assertEquals("2026-11-27T08:00:00Z", input.startTime)
        assertEquals("2026-11-27T09:00:00Z", input.endTime)
        assertEquals("Europe/Amsterdam", input.timezone)
        assertEquals(EventInput.Type.CALL, input.type)
        assertEquals(true, input.isVirtual)
        assertEquals("https://meet.example.test/x", input.meetingUrl)
        assertNull(input.description)
        assertNull(input.location)
        assertEquals("RRULE:FREQ=WEEKLY", input.recurrenceRule)
        assertEquals("Ann", input.attendees?.single()?.name)
        assertNull(CalendarRepository.createInput(draft.copy(guests = emptyList(), recurrenceRule = ""), amsterdam).attendees)
    }

    @Test
    fun anAllDayEventRunsFromLocalMidnightToTheDaysLastMillisecond() {
        val draft = DraftTimes.allDay(EventDraft(calendarId = "c", title = "Off", start = start, end = start.plusHours(1)), true)
        val input = CalendarRepository.createInput(draft, amsterdam)
        assertEquals(true, input.allDay)
        assertEquals("2026-11-26T23:00:00Z", input.startTime)
        assertEquals("2026-11-27T22:59:59.999Z", input.endTime)
    }

    @Test
    fun anEditClearsTextAndSendsOnlyWhatChangedOfTheRest() {
        val original = CalendarRepository.eventOf(
            apiEvent(attendees = listOf(Attendee(email = "ann@example.test", status = "accepted")), rule = "RRULE:FREQ=WEEKLY"),
        )!!
        val draft = EventDraft.of(original, amsterdam).copy(title = "Moved", meetingUrl = "")
        val unchanged = CalendarRepository.updateInput(original, draft, amsterdam)
        assertNull(unchanged.calendarId)
        assertNull(unchanged.attendees)
        assertNull(unchanged.recurrenceRule)
        assertEquals("", unchanged.description)
        assertEquals("", unchanged.meetingUrl)
        assertEquals(false, unchanged.isVirtual)
        assertEquals("", unchanged.location)

        val changed = CalendarRepository.updateInput(
            original,
            draft.copy(
                calendarId = "cal_2",
                recurrenceRule = "",
                guests = draft.guests + Guest("bob@example.test", null, null, null),
            ),
            amsterdam,
        )
        assertEquals("cal_2", changed.calendarId)
        assertEquals("", changed.recurrenceRule)
        // The guest who answered keeps the answer.
        assertEquals(listOf("accepted", null), changed.attendees?.map { it.status })
    }

    @Test
    fun theFormForAnOpenEndedEventGetsAnHour() {
        val original = CalendarRepository.eventOf(apiEvent())!!.copy(end = null)
        val draft = EventDraft.of(original, amsterdam)
        assertEquals(LocalDateTime.of(2026, 11, 27, 9, 0), draft.start)
        assertEquals(LocalDateTime.of(2026, 11, 27, 10, 0), draft.end)
        assertEquals(EventStatus.TENTATIVE, draft.status)
        assertEquals(EventPriority.NORMAL, draft.priority)
    }
}
