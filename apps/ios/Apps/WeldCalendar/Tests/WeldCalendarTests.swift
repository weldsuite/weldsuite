import XCTest
@testable import WeldCalendar

final class CalendarLogicTests: XCTestCase {
    private let amsterdam = CalendarDates.calendar(TimeZone(identifier: "Europe/Amsterdam")!)

    private func date(_ iso: String) -> Date {
        ISO8601DateFormatter().date(from: iso)!
    }

    private func event(
        _ id: String,
        _ start: String,
        end: String? = nil,
        type: EventType = .meeting,
        color: String? = nil,
        calendarID: String = "cal_1"
    ) -> CalendarEvent {
        CalendarEvent(
            id: id, calendarID: calendarID, title: id, description: nil, type: type,
            start: date(start), end: end.map(date), allDay: false, timezone: nil, location: nil,
            isVirtual: false, meetingURL: nil, status: .confirmed, priority: nil, color: color,
            recurrenceRule: nil, guests: [], sourceType: nil, autoScheduled: false, notes: nil
        )
    }

    private func calendarInfo(_ id: String, own: Bool = true, permission: CalendarPermission = .manage) -> CalendarInfo {
        CalendarInfo(id: id, name: id, description: nil, color: nil, isDefault: false, isOwn: own, permission: permission)
    }

    func testTheAppHasAName() {
        XCTAssertFalse(CalendarStrings.appName.isEmpty)
    }

    func testTheMonthGridIsSixMondayFirstWeeks() {
        let weeks = CalendarDates.monthMatrix(YearMonth(year: 2026, month: 11), amsterdam)
        XCTAssertEqual(weeks.count, 6)
        XCTAssertTrue(weeks.allSatisfy { $0.count == 7 })
        // 1 November 2026 is a Sunday: the grid starts on Monday 26 October.
        XCTAssertEqual(weeks.first?.first, Day(year: 2026, month: 10, day: 26))
        XCTAssertEqual(weeks.last?.last, Day(year: 2026, month: 12, day: 6))
    }

    func testTheMonthWindowCoversTheGridWithADayOfSlack() {
        let window = CalendarDates.monthWindow(YearMonth(year: 2026, month: 11), amsterdam)
        XCTAssertEqual(window.start, date("2026-10-24T22:00:00Z"))
        XCTAssertEqual(Day(window.end, calendar: amsterdam), Day(year: 2026, month: 12, day: 7))
    }

    func testTheAgendaRunsFromMidnightForTwoWeeks() {
        let window = CalendarDates.agendaWindow(today: Day(year: 2026, month: 11, day: 27), amsterdam)
        XCTAssertEqual(window.start, date("2026-11-26T23:00:00Z"))
        XCTAssertEqual(window.end.timeIntervalSince1970, date("2026-12-11T23:00:00Z").timeIntervalSince1970 - 0.001, accuracy: 0.0001)
    }

    func testMonthsAddAcrossYears() {
        XCTAssertEqual(YearMonth(year: 2026, month: 12).adding(months: 1), YearMonth(year: 2027, month: 1))
        XCTAssertEqual(YearMonth(year: 2026, month: 1).adding(months: -1), YearMonth(year: 2025, month: 12))
    }

    func testEventsAreGroupedByTheirLocalStartDay() {
        let sections = EventLists.groupByDay([
            event("late", "2026-11-27T22:30:00Z"),
            event("b", "2026-11-27T10:00:00Z"),
            event("a", "2026-11-27T08:00:00Z"),
        ], amsterdam)
        XCTAssertEqual(sections.map(\.day), [Day(year: 2026, month: 11, day: 27)])
        XCTAssertEqual(sections.first?.events.map(\.id), ["a", "b", "late"])
        let next = EventLists.groupByDay([event("x", "2026-11-27T23:30:00Z")], amsterdam)
        XCTAssertEqual(next.first?.day, Day(year: 2026, month: 11, day: 28))
    }

    func testADayShowsThreeDotsAndCountsTheRest() {
        let dots = EventLists.dots([
            event("1", "2026-11-27T08:00:00Z", type: .call),
            event("2", "2026-11-27T09:00:00Z", color: "#123456"),
            event("3", "2026-11-27T10:00:00Z", type: .reminder, color: "nope"),
            event("4", "2026-11-27T11:00:00Z"),
        ], amsterdam)[Day(year: 2026, month: 11, day: 27)]
        XCTAssertEqual(dots?.colors, ["#22C55E", "#123456", "#EF4444"])
        XCTAssertEqual(dots?.overflow, 1)
    }

    func testTheAgendaCountsTodayAndTheNextSevenDays() {
        let counts = EventLists.counts([
            event("today", "2026-11-27T09:00:00Z"),
            event("day6", "2026-12-03T20:00:00Z"),
            event("day7", "2026-12-04T09:00:00Z"),
        ], today: Day(year: 2026, month: 11, day: 27), amsterdam)
        XCTAssertEqual(counts, AgendaCounts(today: 1, nextSevenDays: 2))
    }

    func testPastAndOngoingFollowTheEndOrAnHour() {
        let now = date("2026-11-27T10:30:00Z")
        XCTAssertTrue(EventLists.isPast(event("p", "2026-11-27T08:00:00Z", end: "2026-11-27T09:00:00Z"), now: now))
        XCTAssertTrue(EventLists.isOngoing(event("o", "2026-11-27T10:00:00Z", end: "2026-11-27T11:00:00Z"), now: now))
        XCTAssertTrue(EventLists.isOngoing(event("open", "2026-11-27T09:45:00Z"), now: now))
        XCTAssertFalse(EventLists.isOngoing(event("old", "2026-11-27T09:00:00Z"), now: now))
    }

    func testDurationsAreHoursAndMinutes() {
        let start = date("2026-11-27T09:00:00Z")
        XCTAssertEqual(CalendarDates.duration(start: start, end: date("2026-11-27T10:30:00Z"))?.hours, 1)
        XCTAssertEqual(CalendarDates.duration(start: start, end: date("2026-11-27T10:30:00Z"))?.minutes, 30)
        XCTAssertNil(CalendarDates.duration(start: start, end: start))
        XCTAssertNil(CalendarDates.duration(start: start, end: nil))
    }

    func testANewEventStartsAtNineOrTheNextWholeHour() {
        let morning = date("2026-11-27T07:20:00Z") // 08:20 in Amsterdam
        let afternoon = date("2026-11-27T15:05:00Z") // 16:05
        let today = Day(year: 2026, month: 11, day: 27)
        XCTAssertEqual(CalendarDates.startFor(day: nil, now: morning, amsterdam), date("2026-11-27T08:00:00Z"))
        XCTAssertEqual(CalendarDates.startFor(day: today, now: morning, amsterdam), date("2026-11-27T08:00:00Z"))
        XCTAssertEqual(CalendarDates.startFor(day: today, now: afternoon, amsterdam), date("2026-11-27T16:00:00Z"))
        XCTAssertEqual(CalendarDates.startFor(day: Day(year: 2026, month: 12, day: 19), now: afternoon, amsterdam), date("2026-12-19T08:00:00Z"))
    }

    func testAllDaySnapsToTheDayAndBack() {
        let start = date("2026-11-27T13:00:00Z")
        let allDay = CalendarDates.allDayRange(allDay: true, start: start, end: start.addingTimeInterval(3600), amsterdam)
        XCTAssertEqual(allDay.start, date("2026-11-26T23:00:00Z"))
        XCTAssertEqual(allDay.end.timeIntervalSince1970, date("2026-11-27T23:00:00Z").timeIntervalSince1970 - 0.001, accuracy: 0.0001)
        let timed = CalendarDates.allDayRange(allDay: false, start: allDay.start, end: allDay.end, amsterdam)
        XCTAssertEqual(timed.start, date("2026-11-27T08:00:00Z"))
        XCTAssertEqual(timed.end, date("2026-11-27T09:00:00Z"))
    }

    func testDaysAreReadFromLinks() {
        XCTAssertEqual(CalendarDates.parseDay("2026-12-19"), Day(year: 2026, month: 12, day: 19))
        XCTAssertNil(CalendarDates.parseDay("2026-02-31"))
        XCTAssertNil(CalendarDates.parseDay("tomorrow"))
    }

    func testRelativeDaysNameTodayTomorrowAndYesterday() {
        let today = Day(year: 2026, month: 11, day: 27)
        XCTAssertEqual(relativeDay(today, today: today, amsterdam), .today)
        XCTAssertEqual(relativeDay(Day(year: 2026, month: 11, day: 28), today: today, amsterdam), .tomorrow)
        XCTAssertEqual(relativeDay(Day(year: 2026, month: 11, day: 26), today: today, amsterdam), .yesterday)
        XCTAssertEqual(relativeDay(Day(year: 2027, month: 1, day: 4), today: today, amsterdam), .otherYear)
    }

    func testHiddenCalendarsNarrowTheRequest() {
        let all = [calendarInfo("a"), calendarInfo("b")]
        XCTAssertNil(Visibility.calendarIDsParam(all, hidden: []))
        XCTAssertEqual(Visibility.calendarIDsParam(all, hidden: ["a"]), "b")
        XCTAssertEqual(Visibility.calendarIDsParam(all, hidden: ["a", "b"]), Visibility.none)
    }

    func testOnlyOwnersAndEditorsWrite() {
        let own = calendarInfo("own")
        let edit = calendarInfo("edit", own: false, permission: .edit)
        let view = calendarInfo("view", own: false, permission: .view)
        XCTAssertEqual(CalendarAccess.writable([own, edit, view]), [own, edit])
        XCTAssertTrue(CalendarAccess.canEdit(event("e", "2026-11-27T09:00:00Z", calendarID: "edit"), [own, edit, view]))
        XCTAssertFalse(CalendarAccess.canEdit(event("v", "2026-11-27T09:00:00Z", calendarID: "view"), [own, edit, view]))
        XCTAssertFalse(CalendarAccess.canEdit(event("x", "2026-11-27T09:00:00Z", calendarID: "gone"), [own]))
        XCTAssertEqual(CalendarPermission.of("owner"), .view)
        XCTAssertEqual(EventType.of("task"), .other)
        XCTAssertNil(EventStatus.of("busy"))
    }

    func testColorsFallBackToTheType() {
        XCTAssertEqual(eventColor(nil, .meeting), "#3B82F6")
        XCTAssertEqual(eventColor("#abc", .meeting), "#abc")
        XCTAssertEqual(eventColor("blue", .other), "#6B7280")
        XCTAssertEqual(parseHex("#abc"), 0xAABBCC)
        XCTAssertNil(parseHex("#12345"))
    }

    func testAPushOpensItsEvent() {
        XCTAssertEqual(eventIDFromPush(["eventId": "evt_1"]), "evt_1")
        XCTAssertEqual(eventIDFromPush(["entityType": "calendar_event", "entityId": "evt_2"]), "evt_2")
        XCTAssertNil(eventIDFromPush(["entityType": "task", "entityId": "tsk_1"]))
        XCTAssertEqual(eventIDFromPush(["actionUrl": "/weldcalendar?view=week&event=evt_3#x"]), "evt_3")
        XCTAssertNil(eventIDFromPush(["eventId": "../../etc"]))
        XCTAssertNil(eventIDFromPush([:]))
    }

    func testLinksOpenWhatTheExpoAppsRouterOpened() {
        XCTAssertEqual(parseCalendarLink("weldcalendar://event/evt_1"), .event("evt_1"))
        XCTAssertEqual(parseCalendarLink("weldcalendar://event/edit/evt_1"), .editEvent("evt_1"))
        XCTAssertEqual(parseCalendarLink("weldcalendar://event/new?date=2026-12-19"), .newEvent(Day(year: 2026, month: 12, day: 19)))
        XCTAssertEqual(parseCalendarLink("weldcalendar://event/new?date=tomorrow"), .newEvent(nil))
        XCTAssertEqual(parseCalendarLink("weldcalendar://month"), .tab(.month))
        XCTAssertEqual(parseCalendarLink("weldcalendar://settings/privacy"), .tab(.more))
        XCTAssertNil(parseCalendarLink("weldcalendar://sso-callback?code=x"))
        XCTAssertNil(parseCalendarLink("https://example.com/event/evt_1"))
        XCTAssertNil(parseCalendarLink("weldcalendar://event/evt%2F1"))
    }

    func testOnlyIanaZonesAreSent() {
        XCTAssertEqual(ianaZone("Europe/Amsterdam"), "Europe/Amsterdam")
        XCTAssertEqual(ianaZone("America/Argentina/Buenos_Aires"), "America/Argentina/Buenos_Aires")
        XCTAssertEqual(ianaZone("UTC"), "UTC")
        XCTAssertNil(ianaZone("GMT+01:00"))
        XCTAssertNil(ianaZone(""))
    }

    func testEmailsAndLinksAreChecked() {
        XCTAssertTrue(isValidEmail(" ann@example.com "))
        XCTAssertFalse(isValidEmail("ann@example"))
        XCTAssertTrue(isHTTPURL("https://meet.example.com/abc"))
        XCTAssertFalse(isHTTPURL("meet.example.com"))
        XCTAssertFalse(isHTTPURL("https://"))
    }

    func testGuestAnswersAreCounted() {
        let guests = [
            Guest(email: "a@x.test", name: nil, status: "accepted", role: nil),
            Guest(email: "b@x.test", name: nil, status: "needsAction", role: nil),
            Guest(email: "c@x.test", name: nil, status: "declined", role: nil),
            Guest(email: "d@x.test", name: nil, status: "tentative", role: nil),
            Guest(email: "e@x.test", name: nil, status: nil, role: nil),
        ]
        XCTAssertEqual(guestAnswers(guests), GuestAnswers(accepted: 1, declined: 1, tentative: 1, pending: 2))
    }
}
