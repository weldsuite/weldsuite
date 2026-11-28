import WeldCore
import XCTest
@testable import WeldHR

final class WeldHRTests: XCTestCase {
    private let utc = TimeZone(identifier: "UTC")!

    func testTheAppHasAName() {
        XCTAssertFalse(HRStrings.appName.isEmpty)
    }

    private func record(
        id: String = "r1",
        date: String = "2026-11-23",
        clockIn: String? = "2026-11-23T09:00:00Z",
        clockOut: String? = "2026-11-23T17:00:00Z",
        worked: Int? = nil,
        shiftId: String? = nil,
        rate: Double? = nil,
        currency: String? = nil
    ) -> HRClockRecord {
        HRClockRecord(
            id: id, date: date, clockIn: clockIn, clockOut: clockOut, breakMinutes: 0, workedMinutes: worked, lateMinutes: 0,
            status: "present", source: "portal", approved: false, companyName: nil, shiftId: shiftId, notes: nil,
            hourlyRate: rate, currency: currency
        )
    }

    private func shift(_ id: String = "s1", _ start: String = "2026-11-23T09:00:00Z", _ end: String = "2026-11-23T17:00:00Z", breakStart: String? = nil, breakEnd: String? = nil) -> HRShift {
        HRShift(id: id, startsAt: start, endsAt: end, workType: nil, breakStartsAt: breakStart, breakEndsAt: breakEnd, companyName: nil, notes: nil, hourlyRate: nil, currency: nil)
    }

    private func millis(_ iso: String) -> Double {
        (WeldDate.parse(iso)?.timeIntervalSince1970 ?? 0) * 1000
    }

    func testDaysAreStrictCalendarDays() {
        XCTAssertNotNil(HRDays.parse("2026-11-27", zone: utc))
        XCTAssertNil(HRDays.parse("2026-11-27T10:00:00Z", zone: utc))
        XCTAssertNil(HRDays.parse("2026-02-30", zone: utc))
        XCTAssertEqual(HRDays.add("2026-11-30", 1, zone: utc), "2026-12-01")
    }

    func testWeekdaysSkipTheWeekend() {
        XCTAssertEqual(HRDays.weekdaysBetween("2026-11-27", "2026-11-30", zone: utc), 2)
        XCTAssertEqual(HRDays.weekdaysBetween("2026-11-30", "2026-11-27", zone: utc), 0)
        XCTAssertEqual(HRDays.nextWeekday("2026-11-27", zone: utc), "2026-11-30")
        XCTAssertTrue(HRDays.isWeekend("2026-11-28", zone: utc))
    }

    func testWeeksStartOnMonday() {
        XCTAssertEqual(HRDays.startOfWeek("2026-11-29", zone: utc), "2026-11-23")
        XCTAssertEqual(HRDays.startOfWeek("2026-11-23", zone: utc), "2026-11-23")
        XCTAssertEqual(HRDays.isoWeek("2026-11-27", zone: utc), 48)
        XCTAssertEqual(HRDays.isoWeek("2026-01-01", zone: utc), 1)
    }

    func testATimestampsDayIsTheLocalOne() {
        XCTAssertEqual(HRDays.dayOf("2026-11-27T23:30:00Z", zone: utc), "2026-11-27")
        XCTAssertEqual(HRDays.dayOf("2026-11-27T23:30:00Z", zone: TimeZone(secondsFromGMT: 3600)!), "2026-11-28")
        XCTAssertEqual(HRDays.dayOf("2026-11-27", zone: utc), "2026-11-27")
    }

    func testPlannedMinutesLeaveTheBreakOut() {
        XCTAssertEqual(ShiftMath.plannedMinutes(shift()), 480)
        XCTAssertEqual(ShiftMath.plannedMinutes(shift(breakStart: "2026-11-23T12:00:00Z", breakEnd: "2026-11-23T12:30:00Z")), 450)
    }

    func testARunningRecordCountsUntilNow() {
        let now = millis("2026-11-23T10:30:00Z")
        XCTAssertEqual(ShiftMath.minutesOf(record(clockOut: nil), now: now), 90, accuracy: 0.001)
        XCTAssertEqual(ShiftMath.minutesOf(record(worked: 400), now: now), 400, accuracy: 0.001)
    }

    func testRecordsFindTheirShift() {
        let now = millis("2026-11-23T20:00:00Z")
        let shifts = [shift("s1"), shift("s2", "2026-11-23T18:00:00Z", "2026-11-23T22:00:00Z")]
        XCTAssertEqual(ShiftMath.shiftOf(record(shiftId: "s2"), shifts: shifts, now: now, zone: utc)?.id, "s2")
        XCTAssertEqual(ShiftMath.shiftOf(record(), shifts: shifts, now: now, zone: utc)?.id, "s1")
        XCTAssertNil(ShiftMath.shiftOf(record(clockIn: "2026-11-23T06:00:00Z", clockOut: "2026-11-23T07:00:00Z"), shifts: shifts, now: now, zone: utc))
    }

    func testGapsUnderAMinuteAreNoBreak() {
        let first = record(id: "a", clockIn: "2026-11-23T09:00:00Z", clockOut: "2026-11-23T12:00:00Z")
        let second = record(id: "b", clockIn: "2026-11-23T12:30:00Z", clockOut: "2026-11-23T17:00:00Z")
        let slip = record(id: "c", clockIn: "2026-11-23T17:00:20Z", clockOut: "2026-11-23T18:00:00Z")
        let gaps = ShiftMath.clockedOutGaps([second, first, slip])
        XCTAssertEqual(gaps.count, 1)
        XCTAssertEqual(gaps.first?.0, "2026-11-23T12:00:00Z")
        XCTAssertEqual(gaps.first?.1, "2026-11-23T12:30:00Z")
    }

    func testEarningsPerCurrencyAndZeroWithoutARate() {
        let none = ShiftMath.earnings([record(worked: 60)], now: 0, fallback: "EUR")
        XCTAssertEqual(none.map(\.0), ["EUR"])
        XCTAssertEqual(none.map(\.1), [0])
        let paid = ShiftMath.earnings([record(worked: 90, rate: 20, currency: "EUR"), record(id: "b", worked: 60, rate: 10, currency: "USD")], now: 0, fallback: "EUR")
        XCTAssertEqual(paid.map(\.0), ["EUR", "USD"])
        XCTAssertEqual(paid.map(\.1), [30, 10])
    }

    func testDurationsAndTimers() {
        XCTAssertEqual(ShiftMath.duration(425), "7:05")
        XCTAssertEqual(ShiftMath.timer(3_728_000), "01:02:08")
        XCTAssertEqual(ShiftMath.hoursAndMinutes(425).0, 7)
        XCTAssertEqual(ShiftMath.hoursAndMinutes(425).1, 5)
    }

    private func leave(_ id: String, _ status: String, _ start: String, _ end: String) -> HRLeaveRequest {
        HRLeaveRequest(id: id, leaveTypeId: "lt", leaveTypeName: "Holiday", leaveTypeColor: nil, startDate: start, endDate: end, days: 1, reason: nil, status: status)
    }

    func testLeaveSortsCurrentFirstThenThePast() {
        let sorted = LeaveRules.sortRequests(
            [leave("past", "approved", "2026-01-05", "2026-01-06"), leave("later", "approved", "2026-12-20", "2026-12-24"), leave("soon", "pending", "2026-12-01", "2026-12-01")],
            today: "2026-11-27"
        )
        XCTAssertEqual(sorted.map(\.id), ["soon", "later", "past"])
    }

    func testOnlyPendingOrNotYetStartedLeaveCanBeCancelled() {
        XCTAssertTrue(LeaveRules.canCancel(leave("a", "pending", "2026-11-01", "2026-11-02"), today: "2026-11-27"))
        XCTAssertTrue(LeaveRules.canCancel(leave("a", "approved", "2026-12-01", "2026-12-02"), today: "2026-11-27"))
        XCTAssertFalse(LeaveRules.canCancel(leave("a", "approved", "2026-11-27", "2026-11-28"), today: "2026-11-27"))
        XCTAssertFalse(LeaveRules.canCancel(leave("a", "rejected", "2026-12-01", "2026-12-02"), today: "2026-11-27"))
    }

    func testTheAllowanceCheckBlocksOnlyWhenTheTypeSays() {
        let balance = HRLeaveBalance(leaveTypeId: "lt", name: "Holiday", color: nil, isPaid: true, overAllowance: "block", allowance: 25, prorated: false, used: 20, pending: 2, remaining: 3)
        XCTAssertEqual(LeaveRules.checkAllowance(balance, days: 3), .ok)
        XCTAssertEqual(LeaveRules.checkAllowance(balance, days: 4), .over(remaining: 3, blocked: true))
        XCTAssertNil(LeaveRules.balanceForStart([balance], leaveTypeId: "lt", startDate: "2027-01-04", today: "2026-11-27"))
        XCTAssertEqual(LeaveRules.balanceForStart([balance], leaveTypeId: "lt", startDate: "2026-12-01", today: "2026-11-27"), balance)
    }

    private func open(_ id: String, _ start: String, _ spotsLeft: Int, _ status: String? = nil) -> HROpenShift {
        HROpenShift(
            id: id, startsAt: start, endsAt: start, workType: nil, breakStartsAt: nil, breakEndsAt: nil, notes: nil, companyName: nil,
            departmentName: nil, spots: 2, spotsLeft: spotsLeft, myRequest: status.map { HROpenShiftRequest(id: "r-\(id)", status: $0, reviewNote: nil) }
        )
    }

    func testOpenShiftsStandingAndWhatIsListed() {
        let now = millis("2026-11-27T09:00:00Z")
        XCTAssertEqual(OpenShiftRules.standingOf(open("a", "2026-11-28T09:00:00Z", 0, "pending")), .waiting)
        XCTAssertEqual(OpenShiftRules.standingOf(open("a", "2026-11-28T09:00:00Z", 1, "rejected")), .declined)
        XCTAssertEqual(OpenShiftRules.standingOf(open("a", "2026-11-28T09:00:00Z", 0, "cancelled")), .full)
        XCTAssertTrue(OpenShiftRules.canSignUp(open("a", "2026-11-28T09:00:00Z", 1, "rejected"), now: now))
        XCTAssertFalse(OpenShiftRules.canSignUp(open("a", "2026-11-28T09:00:00Z", 1, "pending"), now: now))
        let listed = OpenShiftRules.listable([
            open("later", "2026-11-30T09:00:00Z", 1),
            open("started", "2026-11-26T09:00:00Z", 1),
            open("mine", "2026-11-29T09:00:00Z", 1, "approved"),
            open("full", "2026-11-29T09:00:00Z", 0),
            open("waiting", "2026-11-28T09:00:00Z", 0, "pending"),
        ], now: now)
        XCTAssertEqual(listed.map(\.id), ["waiting", "later"])
    }

    func testAnnouncementsPinnedFirstAndTheirAge() {
        let list = [
            HRAnnouncement(id: "old", title: "", body: "", pinned: false, publishedAt: "2026-11-01T09:00:00Z", createdByName: nil, readAt: nil),
            HRAnnouncement(id: "new", title: "", body: "", pinned: false, publishedAt: "2026-11-27T09:00:00Z", createdByName: nil, readAt: nil),
            HRAnnouncement(id: "pin", title: "", body: "", pinned: true, publishedAt: "2026-10-01T09:00:00Z", createdByName: nil, readAt: nil),
        ]
        XCTAssertEqual(AnnouncementRules.sort(list).map(\.id), ["pin", "new", "old"])
        let now = WeldDate.parse("2026-11-27T12:00:00Z")!
        XCTAssertEqual(AnnouncementRules.ageOf("2026-11-27T11:59:30Z", now: now, zone: utc), .now)
        XCTAssertEqual(AnnouncementRules.ageOf("2026-11-27T11:30:00Z", now: now, zone: utc), .minutes(30))
        XCTAssertEqual(AnnouncementRules.ageOf("2026-11-27T09:00:00Z", now: now, zone: utc), .hours(3))
        XCTAssertEqual(AnnouncementRules.ageOf("2026-11-26T09:00:00Z", now: now, zone: utc), .yesterday)
        XCTAssertEqual(AnnouncementRules.ageOf("2026-11-23T09:00:00Z", now: now, zone: utc), .days(4))
        XCTAssertEqual(AnnouncementRules.ageOf("2026-11-01T09:00:00Z", now: now, zone: utc), .date)
        XCTAssertEqual(AnnouncementRules.preview("a\n\n b  c", max: 3), "a b…")
    }

    private func declaration(_ status: String, _ category: String, _ amount: Double = 12.5, _ currency: String = "EUR") -> HRDeclaration {
        HRDeclaration(id: "d", expenseDate: "2026-11-01", category: category, description: "Train", amount: amount, currency: currency, status: status, hasReceipt: false)
    }

    func testTheExpenseFilterHidesWhatIsSwitchedOff() {
        let filter = ExpenseFilter(statuses: ["paid"])
        XCTAssertTrue(filter.passes(declaration("pending", "travel")))
        XCTAssertFalse(filter.passes(declaration("paid", "travel")))
        let rows = [declaration("pending", "meals"), declaration("approved", "travel")]
        XCTAssertEqual(ExpenseFilter.statusChoices(rows, filter: filter), ["pending", "approved", "paid"])
        XCTAssertEqual(ExpenseFilter.categoryChoices(rows, filter: ExpenseFilter()), ["travel", "meals"])
    }

    func testOpenAmountsMatchTheServer() {
        let rows = [
            declaration("pending", "travel", 10.25), declaration("pending", "meals", 0.2), declaration("approved", "travel", 5),
            declaration("paid", "travel", 100), declaration("pending", "travel", 7, "USD"),
        ]
        let open = openAmounts(rows)
        XCTAssertEqual(open.map(\.currency), ["EUR", "USD"])
        XCTAssertEqual(open.first?.pending ?? 0, 10.45, accuracy: 0.0001)
        XCTAssertEqual(open.first?.approved, 5)
        XCTAssertEqual(open.last?.pending, 7)
    }

    func testSearchIgnoresCaseAndAccentsAndNeedsEveryWord() {
        XCTAssertTrue(HRSearch.matches("cafe okt", ["Café de Paris", "12 okt"]))
        XCTAssertFalse(HRSearch.matches("cafe nov", ["Café de Paris", "12 okt"]))
        XCTAssertTrue(HRSearch.matches("  ", [nil]))
    }

    func testReceiptsAreImagesOrPdfsUpTo10Mb() {
        XCTAssertNil(Receipts.problem(mimeType: "image/jpeg", size: 1000))
        XCTAssertEqual(Receipts.problem(mimeType: "image/heic", size: 1000), .type)
        XCTAssertEqual(Receipts.problem(mimeType: "application/pdf", size: Receipts.maxBytes + 1), .size)
        XCTAssertEqual(Receipts.guessType("bon.PDF"), "application/pdf")
        XCTAssertEqual(Receipts.fileName(" ", mimeType: "image/jpeg", today: "2026-11-27"), "receipt-2026-11-27.jpg")
        XCTAssertEqual(Receipts.safeFileName("a/b.pdf"), "a_b.pdf")
        XCTAssertEqual(Receipts.safeFileName("..."), "document.pdf")
    }

    func testAmountsAsPeopleTypeThem() {
        XCTAssertEqual(parseAmount("12,50"), 12.5)
        XCTAssertEqual(parseAmount("1.234,56"), 1234.56)
        XCTAssertEqual(parseAmount("1,234.56"), 1234.56)
        XCTAssertEqual(parseAmount("€ 12.5"), 12.5)
        XCTAssertNil(parseAmount("0"))
        XCTAssertNil(parseAmount("abc"))
    }

    func testTasksGroupPerChecklistOpenFirst() {
        let tasks = [
            HRTask(id: "1", title: "Laptop", description: nil, dueDate: "2026-12-01", assigneeRole: "employee", completedAt: "2026-11-20", canComplete: true, checklistName: "Onboarding"),
            HRTask(id: "2", title: "Contract", description: nil, dueDate: "2026-12-05", assigneeRole: "employee", completedAt: nil, canComplete: true, checklistName: "Onboarding"),
            HRTask(id: "3", title: "Badge", description: nil, dueDate: nil, assigneeRole: "hr", completedAt: nil, canComplete: false, checklistName: "Onboarding"),
            HRTask(id: "4", title: "Return keys", description: nil, dueDate: nil, assigneeRole: "employee", completedAt: nil, canComplete: true, checklistName: "Offboarding"),
        ]
        let groups = groupTasks(tasks)
        XCTAssertEqual(groups.map(\.0), ["Onboarding", "Offboarding"])
        XCTAssertEqual(groups.first?.1.map(\.id), ["2", "3", "1"])
    }

    func testPushesAndLinksLeadToTheirScreen() {
        XCTAssertEqual(HRRoutes.forPush(["notificationType": "hr_announcement", "announcementId": "ann_1"]), .announcement("ann_1"))
        XCTAssertEqual(HRRoutes.forPush(["notificationType": "hr_announcement"]), .announcements)
        XCTAssertEqual(HRRoutes.forPush(["route": "/leave/lr_1"]), .leave("lr_1"))
        XCTAssertNil(HRRoutes.forPush(["notificationType": "other"]))
        XCTAssertEqual(HRRoutes.forPath("weldhr://expense/d%201"), .expense("d 1"))
        XCTAssertEqual(HRRoutes.forPath("pay"), .pay)
        XCTAssertNil(HRRoutes.forPath("weldhr://sso-callback"))
    }

    func testSwatchesAreStableAndColoursParse() {
        XCTAssertEqual(Swatches.shiftColor("Client"), Swatches.shiftColor("Client"))
        XCTAssertEqual(Swatches.hex("#123"), 0x112233)
        XCTAssertEqual(Swatches.hex("#0D9488"), 0x0D9488)
        XCTAssertNil(Swatches.hex("teal"))
        XCTAssertTrue(Swatches.prefersDarkText(0xFFFFFF))
        XCTAssertFalse(Swatches.prefersDarkText(0x000000))
    }

    func testPlatformColoursForShiftsLeaveAndScores() {
        // No client: WeldCalendar's default blue; a client: one of the platform's client colours.
        XCTAssertEqual(Swatches.shiftColor(nil), Swatches.defaultShift)
        XCTAssertEqual(Swatches.shiftColor(""), Swatches.defaultShift)
        XCTAssertNotEqual(Swatches.shiftColor("Acme"), Swatches.defaultShift)
        // The platform's hash: ("a" = 97) * 31 + ("b" = 98) = 3105, mod 9973.
        XCTAssertEqual(Swatches.hash("ab"), 3105)
        XCTAssertEqual(Swatches.dot(nil), Swatches.neutralDot)
        XCTAssertEqual(Swatches.dot("#0D9488"), 0x0D9488)
        XCTAssertEqual(Swatches.scoreBand(85), 0)
        XCTAssertEqual(Swatches.scoreBand(70), 1)
        XCTAssertEqual(Swatches.scoreBand(55), 2)
        XCTAssertEqual(Swatches.scoreBand(54.9), 3)
    }

    func testStatusesTakeThePlatformsBadgeVariant() {
        XCTAssertEqual(Tone.of("approved"), .primary)
        XCTAssertEqual(Tone.of("active"), .primary)
        XCTAssertEqual(Tone.of("pending"), .outline)
        XCTAssertEqual(Tone.of("ongoing"), .outline)
        XCTAssertEqual(Tone.of("rejected"), .destructive)
        XCTAssertEqual(Tone.of("terminated"), .destructive)
        XCTAssertEqual(Tone.of("cancelled"), .secondary)
        XCTAssertEqual(Tone.of("paid"), .secondary)
        XCTAssertEqual(Tone.of("something-new"), .secondary)
    }

    func testClockFixesRoundTheAccuracy() {
        XCTAssertEqual(ClockLocator.toFix(latitude: 52.1, longitude: 4.3, accuracy: 12.6), HRGeoFix(latitude: 52.1, longitude: 4.3, accuracy: 13))
        XCTAssertEqual(ClockLocator.toFix(latitude: 52.1, longitude: 4.3, accuracy: -1), HRGeoFix(latitude: 52.1, longitude: 4.3, accuracy: nil))
        XCTAssertNil(ClockLocator.toFix(latitude: .nan, longitude: 4.3, accuracy: nil))
    }

    func testWildcardsMatchAsTheServerDoes() {
        XCTAssertTrue(HRAccess.matches("*", "weldhr:leave:read"))
        XCTAssertTrue(HRAccess.matches("leave:*", "leave:approve"))
        XCTAssertTrue(HRAccess.matches("*:read", "leave:read"))
        XCTAssertFalse(HRAccess.matches("*:read", "weldhr:leave:read"))
        XCTAssertFalse(HRAccess.matches("leave:read", "leave:approve"))
    }

    func testAccessFollowsThePermissionsAndDeniesWin() {
        let employee = HRAccess.resolve(permissions: ["weldhr:employees:self"], denies: [])
        XCTAssertTrue(employee.me)
        XCTAssertFalse(employee.approveLeave)
        let manager = HRAccess.resolve(permissions: ["employees:self", "leave:read", "leave:approve", "declarations:read"], denies: [])
        XCTAssertTrue(manager.approveLeave)
        XCTAssertFalse(manager.approveExpenses)
        let denied = HRAccess.resolve(permissions: ["*"], denies: ["leave:approve"])
        XCTAssertFalse(denied.approveLeave)
        XCTAssertTrue(denied.createAnnouncements)
    }

    func testMyHrNeedsAccessAndALinkedRecord() {
        let features = HRFeatures(selfClockIn: true, clockInRequiresLocation: false, leaveRequests: true, declarations: true)
        let profile = HRProfile(id: "e1", displayName: "Ann", email: "ann@example.com", phone: nil, avatarUrl: nil, jobTitle: nil, employeeNumber: nil, status: "active", startDate: nil, location: nil, departmentName: nil, managerName: nil)
        XCTAssertEqual(SelfState.of(me: LoadState(), access: LoadState()), .loading)
        XCTAssertEqual(SelfState.of(me: LoadState(error: APIError(status: 403, code: "FORBIDDEN")), access: LoadState()), .noAccess)
        XCTAssertEqual(SelfState.of(me: LoadState(data: HRMe(employee: nil, features: features)), access: LoadState()), .notLinked)
        XCTAssertEqual(SelfState.of(me: LoadState(data: HRMe(employee: profile, features: features)), access: LoadState()), .ready(profile, features))
    }

    func testThePlusKeepsToWhatTheTabIsAbout() {
        let all = HRFeatures(selfClockIn: true, clockInRequiresLocation: false, leaveRequests: true, declarations: true)
        let none = HRFeatures(selfClockIn: true, clockInRequiresLocation: false, leaveRequests: false, declarations: false)
        XCTAssertNil(AddMenus.forTab(.home, features: all, access: .noAccess))
        XCTAssertEqual(AddMenus.forTab(.schedule, features: all, access: .noAccess), AddMenu(main: .requestShift, entries: [], direct: true))
        XCTAssertEqual(AddMenus.forTab(.expenses, features: all, access: .noAccess), AddMenu(main: .photoReceipt, entries: [.uploadReceipt]))
        XCTAssertEqual(AddMenus.forTab(.absence, features: all, access: .noAccess), AddMenu(main: .requestLeave, entries: [.reportSick]))
        XCTAssertEqual(AddMenus.forTab(.absence, features: none, access: .noAccess), AddMenu(main: .reportSick, entries: []))
        XCTAssertEqual(AddMenus.forTab(.announcements, features: all, access: HRAccess(createAnnouncements: true)), AddMenu(main: .newAnnouncement, entries: [], direct: true))
    }

    func testShiftRequestTimesCrossMidnight() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone.current
        let from = calendar.date(bySettingHour: 22, minute: 0, second: 0, of: Date())!
        let until = calendar.date(bySettingHour: 6, minute: 0, second: 0, of: Date())!
        let span = HRShiftTimes.span(day: "2026-12-01", from: from, until: until, calendar: calendar)
        XCTAssertTrue(span.nextDay)
        XCTAssertEqual(span.minutes, 480, accuracy: 0.001)
    }
}
