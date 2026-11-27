import WeldCalendarAPI
import XCTest
@testable import WeldCalendar

final class EventFormTests: XCTestCase {
    private let amsterdamZone = TimeZone(identifier: "Europe/Amsterdam")!
    private var amsterdam: Calendar { CalendarDates.calendar(amsterdamZone) }

    private func date(_ iso: String) -> Date {
        ISO8601DateFormatter().date(from: iso)!
    }

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    private func encode<T: Encodable>(_ value: T) throws -> [String: Any] {
        let data = try JSONEncoder().encode(value)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func apiEvent(start: String = "2026-11-27T08:00:00.000Z", attendees: String = "null", rule: String = "null") throws -> Components.Schemas.CalendarEvent {
        try decode(Components.Schemas.CalendarEvent.self, """
        {"id":"evt_1","calendarId":"cal_1","title":"Review","description":"","type":"meeting",
         "startTime":"\(start)","endTime":"2026-11-27T09:30:00.000Z","allDay":null,
         "timezone":"Europe/Amsterdam","location":null,"isVirtual":true,"meetingUrl":"https://meet.example.test/x",
         "status":"tentative","priority":null,"color":null,"recurrenceRule":\(rule),"recurrenceId":null,
         "organizerId":"user_1","attendees":\(attendees),"sourceType":"task","sourceId":"tsk_1",
         "autoScheduled":null,"notes":"  ","createdAt":"2026-11-01T00:00:00.000Z","updatedAt":"2026-11-01T00:00:00.000Z",
         "reason":null,"customFields":null}
        """)
    }

    func testPresetsWriteRulesAndReadThemBack() {
        for preset in RepeatPreset.allCases {
            XCTAssertEqual(RepeatPreset.of(preset.rule), preset)
        }
        XCTAssertEqual(RepeatPreset.of("FREQ=WEEKLY"), .weekly)
        XCTAssertEqual(RepeatPreset.of(nil), .never)
        XCTAssertNil(RepeatPreset.of("RRULE:FREQ=WEEKLY;INTERVAL=2"))
        XCTAssertNil(RepeatPreset.of("RRULE:FREQ=DAILY;COUNT=5"))
        XCTAssertNil(RepeatPreset.of("RRULE:FREQ=WEEKLY;BYDAY=MO"))
    }

    func testRulesAreReadWithOrWithoutTheirPrefix() throws {
        let rule = try XCTUnwrap(RRule.parse("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=WE,MO;UNTIL=20301231T000000Z"))
        XCTAssertEqual(rule.frequency, .weekly)
        XCTAssertEqual(rule.interval, 2)
        XCTAssertEqual(rule.days, [.monday, .wednesday])
        XCTAssertEqual(rule.until, Day(year: 2030, month: 12, day: 31))
        let monthly = try XCTUnwrap(RRule.parse("freq=monthly;byday=1MO;count=3"))
        XCTAssertEqual(monthly.frequency, .monthly)
        XCTAssertEqual(monthly.days, [.monday])
        XCTAssertEqual(monthly.count, 3)
        XCTAssertNil(RRule.parse("RRULE:FREQ=HOURLY"))
        XCTAssertNil(RRule.parse(""))
        XCTAssertNil(RRule.parse("DTSTART:20300101T090000Z"))
    }

    func testADraftNeedsATitleAnEndAfterItsStartAndAWebLink() {
        let start = date("2026-11-27T08:00:00Z")
        let mine = CalendarInfo(id: "cal_1", name: "Mine", description: nil, color: nil, isDefault: true, isOwn: true, permission: .manage)
        var draft = EventDraft.new(calendars: [mine], start: start)
        XCTAssertEqual(draft.calendarID, "cal_1")
        XCTAssertEqual(draft.end, start.addingTimeInterval(3600))
        draft.end = start
        draft.meetingURL = "zoom.us/j/1"
        let issues = problems(of: draft)
        XCTAssertTrue(issues.titleMissing)
        XCTAssertTrue(issues.endBeforeStart)
        XCTAssertTrue(issues.badMeetingURL)
        var good = EventDraft.new(calendars: [mine], start: start)
        good.title = "Review"
        XCTAssertTrue(problems(of: good).isEmpty)
        var nowhere = EventDraft.new(calendars: [], start: start)
        nowhere.title = "x"
        XCTAssertTrue(problems(of: nowhere).noCalendar)
    }

    func testMovingTheStartCarriesTheEnd() {
        let start = date("2026-11-27T08:00:00Z")
        let draft = EventDraft(calendarID: "c", start: start, end: start.addingTimeInterval(5400))
        let later = DraftTimes.start(draft, to: date("2026-11-27T13:30:00Z"))
        XCTAssertEqual(later.end, date("2026-11-27T15:00:00Z"))
        let allDay = DraftTimes.allDay(draft, true, amsterdam)
        XCTAssertTrue(allDay.allDay)
        XCTAssertEqual(allDay.start, date("2026-11-26T23:00:00Z"))
        XCTAssertEqual(DraftTimes.wholeMinute(date("2026-11-27T08:00:42Z"), amsterdam), date("2026-11-27T08:00:00Z"))
    }

    func testGuestsAreCheckedBeforeTheyreAdded() {
        let guests = [Guest(email: "ann@example.test", name: nil, status: nil, role: nil)]
        XCTAssertEqual(guestProblem("ann", guests: guests), .invalid)
        XCTAssertEqual(guestProblem("ANN@example.test", guests: guests), .duplicate)
        let full = (0..<maxGuests).map { Guest(email: "g\($0)@x.test", name: nil, status: nil, role: nil) }
        XCTAssertEqual(guestProblem("z@example.test", guests: full), .limit)
        XCTAssertNil(guestProblem("bob@example.test", guests: guests))
    }

    func testACalendarRowMapsToTheAppsCalendar() throws {
        let own = CalendarStore.calendar(try decode(Components.Schemas.Calendar.self, """
        {"id":"cal_1","name":"Mine","description":"","color":"#3b82f6","ownerId":"u","isDefault":true,"isActive":null,
         "createdAt":"t","updatedAt":"t","deletedAt":null,"isOwn":true,"permission":"manage"}
        """))
        XCTAssertTrue(own.isOwn)
        XCTAssertTrue(own.isDefault)
        XCTAssertNil(own.description)
        XCTAssertEqual(own.permission, .manage)
        let shared = CalendarStore.calendar(try decode(Components.Schemas.Calendar.self, """
        {"id":"cal_2","name":"Team","description":"Ops","color":"red","ownerId":"u2","isDefault":null,"isActive":null,
         "createdAt":"t","updatedAt":"t","isOwn":false,"permission":"edit"}
        """))
        XCTAssertFalse(shared.isOwn)
        XCTAssertTrue(shared.canWrite)
        XCTAssertNil(shared.color)
    }

    func testAnEventRowMapsToTheAppsEvent() throws {
        let event = try XCTUnwrap(CalendarStore.event(try apiEvent(
            attendees: #"[{"email":"ann@example.test","name":"Ann","status":"accepted"},{"email":" ","name":"Nobody"},{"email":"bob@example.test","status":"needsAction","role":"optional"}]"#,
            rule: #""RRULE:FREQ=WEEKLY""#
        )))
        XCTAssertEqual(event.start, date("2026-11-27T08:00:00Z"))
        XCTAssertEqual(event.type, .meeting)
        XCTAssertEqual(event.status, .tentative)
        XCTAssertNil(event.priority)
        XCTAssertFalse(event.allDay)
        XCTAssertNil(event.description)
        XCTAssertNil(event.notes)
        XCTAssertTrue(event.isTask)
        XCTAssertEqual(event.guests.map(\.email), ["ann@example.test", "bob@example.test"])
        XCTAssertEqual(event.guests[1].response, .pending)
        XCTAssertEqual(event.recurrenceRule, "RRULE:FREQ=WEEKLY")
        XCTAssertNil(CalendarStore.event(try apiEvent(start: "not a date")))
    }

    func testANewEventSendsInstantsAndLeavesEmptyFieldsOut() throws {
        var draft = EventDraft(calendarID: "cal_1", start: date("2026-11-27T08:00:00Z"), end: date("2026-11-27T09:00:00Z"))
        draft.title = "  Review "
        draft.type = .call
        draft.meetingURL = " https://meet.example.test/x "
        draft.recurrenceRule = RepeatPreset.weekly.rule
        draft.guests = [Guest(email: "ann@example.test", name: "Ann", status: nil, role: nil)]
        let body = try encode(CalendarStore.createInput(draft, zone: amsterdamZone))
        XCTAssertEqual(body["title"] as? String, "Review")
        XCTAssertEqual(body["type"] as? String, "call")
        XCTAssertEqual(body["startTime"] as? String, "2026-11-27T08:00:00.000Z")
        XCTAssertEqual(body["endTime"] as? String, "2026-11-27T09:00:00.000Z")
        XCTAssertEqual(body["timezone"] as? String, "Europe/Amsterdam")
        XCTAssertEqual(body["isVirtual"] as? Bool, true)
        XCTAssertEqual(body["meetingUrl"] as? String, "https://meet.example.test/x")
        XCTAssertNil(body["description"])
        XCTAssertNil(body["location"])
        XCTAssertEqual(body["recurrenceRule"] as? String, "RRULE:FREQ=WEEKLY")
        XCTAssertEqual((body["attendees"] as? [[String: Any]])?.first?["name"] as? String, "Ann")
    }

    func testAnAllDayEventRunsFromLocalMidnightToTheDaysLastMillisecond() throws {
        var draft = EventDraft(calendarID: "c", start: date("2026-11-27T08:00:00Z"), end: date("2026-11-27T09:00:00Z"))
        draft.title = "Off"
        draft = DraftTimes.allDay(draft, true, amsterdam)
        let body = try encode(CalendarStore.createInput(draft, zone: amsterdamZone))
        XCTAssertEqual(body["allDay"] as? Bool, true)
        XCTAssertEqual(body["startTime"] as? String, "2026-11-26T23:00:00.000Z")
        // 23:59:59.999 local; a Date's last millisecond may print as .998.
        XCTAssertTrue((body["endTime"] as? String ?? "").hasPrefix("2026-11-27T22:59:59.99"))
    }

    func testAnEditClearsTextAndSendsOnlyWhatChangedOfTheRest() throws {
        let original = try XCTUnwrap(CalendarStore.event(try apiEvent(
            attendees: #"[{"email":"ann@example.test","status":"accepted"}]"#,
            rule: #""RRULE:FREQ=WEEKLY""#
        )))
        var draft = EventDraft.of(original)
        draft.title = "Moved"
        draft.meetingURL = ""
        let unchanged = try encode(CalendarStore.updateInput(original, draft, zone: amsterdamZone))
        XCTAssertNil(unchanged["calendarId"])
        XCTAssertNil(unchanged["attendees"])
        XCTAssertNil(unchanged["recurrenceRule"])
        XCTAssertEqual(unchanged["description"] as? String, "")
        XCTAssertEqual(unchanged["meetingUrl"] as? String, "")
        XCTAssertEqual(unchanged["isVirtual"] as? Bool, false)

        draft.calendarID = "cal_2"
        draft.recurrenceRule = ""
        draft.guests.append(Guest(email: "bob@example.test", name: nil, status: nil, role: nil))
        let changed = try encode(CalendarStore.updateInput(original, draft, zone: amsterdamZone))
        XCTAssertEqual(changed["calendarId"] as? String, "cal_2")
        XCTAssertEqual(changed["recurrenceRule"] as? String, "")
        let statuses = (changed["attendees"] as? [[String: Any]])?.map { $0["status"] as? String }
        // The guest who answered keeps the answer.
        XCTAssertEqual(statuses, ["accepted", nil])
    }

    func testTheFormForAnOpenEndedEventGetsAnHour() throws {
        var original = try XCTUnwrap(CalendarStore.event(try apiEvent()))
        original.end = nil
        let draft = EventDraft.of(original)
        XCTAssertEqual(draft.end, draft.start.addingTimeInterval(3600))
        XCTAssertEqual(draft.status, .tentative)
        XCTAssertEqual(draft.priority, .normal)
    }
}
