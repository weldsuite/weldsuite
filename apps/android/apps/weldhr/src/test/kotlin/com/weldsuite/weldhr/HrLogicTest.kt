package com.weldsuite.weldhr

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.ZoneOffset

class HrLogicTest {
    private val utc = ZoneOffset.UTC

    private fun record(
        id: String = "r1",
        date: String = "2026-11-23",
        clockIn: String? = "2026-11-23T09:00:00Z",
        clockOut: String? = "2026-11-23T17:00:00Z",
        worked: Int? = null,
        shiftId: String? = null,
        rate: Double? = null,
        currency: String? = null,
    ) = ClockRecord(id, date, clockIn, clockOut, 0, worked, 0, "present", "portal", false, null, shiftId, null, rate, currency)

    private fun shift(id: String = "s1", start: String = "2026-11-23T09:00:00Z", end: String = "2026-11-23T17:00:00Z", breakStart: String? = null, breakEnd: String? = null) =
        Shift(id, start, end, null, breakStart, breakEnd, null, null, null, null)

    @Test
    fun daysAreStrictCalendarDays() {
        assertEquals("2026-11-27", HrDays.parse("2026-11-27").toString())
        assertNull(HrDays.parse("2026-11-27T10:00:00Z"))
        assertNull(HrDays.parse("2026-02-30"))
        assertEquals("2026-12-01", HrDays.add("2026-11-30", 1))
    }

    @Test
    fun weekdaysSkipTheWeekend() {
        // Friday 27 Nov → Monday 30 Nov is two working days.
        assertEquals(2, HrDays.weekdaysBetween("2026-11-27", "2026-11-30"))
        assertEquals(0, HrDays.weekdaysBetween("2026-11-30", "2026-11-27"))
        assertEquals("2026-11-30", HrDays.nextWeekday("2026-11-27"))
        assertTrue(HrDays.isWeekend("2026-11-28"))
    }

    @Test
    fun weeksStartOnMonday() {
        assertEquals("2026-11-23", HrDays.startOfWeek("2026-11-29"))
        assertEquals("2026-11-23", HrDays.startOfWeek("2026-11-23"))
        assertEquals(48, HrDays.isoWeek("2026-11-27"))
        assertEquals(1, HrDays.isoWeek("2026-01-01"))
    }

    @Test
    fun aTimestampsDayIsTheLocalOne() {
        assertEquals("2026-11-27", HrDays.dayOf("2026-11-27T23:30:00Z", utc))
        assertEquals("2026-11-28", HrDays.dayOf("2026-11-27T23:30:00Z", ZoneOffset.ofHours(1)))
        assertEquals("2026-11-27", HrDays.dayOf("2026-11-27", utc))
    }

    @Test
    fun plannedMinutesLeaveTheBreakOut() {
        assertEquals(480, ShiftMath.plannedMinutes(shift()))
        assertEquals(450, ShiftMath.plannedMinutes(shift(breakStart = "2026-11-23T12:00:00Z", breakEnd = "2026-11-23T12:30:00Z")))
    }

    @Test
    fun aRunningRecordCountsUntilNow() {
        val now = Instant.parse("2026-11-23T10:30:00Z").toEpochMilli()
        assertEquals(90.0, ShiftMath.minutesOf(record(clockOut = null), now), 0.001)
        assertEquals(400.0, ShiftMath.minutesOf(record(worked = 400), now), 0.001)
    }

    @Test
    fun recordsFindTheirShift() {
        val now = Instant.parse("2026-11-23T20:00:00Z").toEpochMilli()
        val shifts = listOf(shift("s1"), shift("s2", "2026-11-23T18:00:00Z", "2026-11-23T22:00:00Z"))
        assertEquals("s2", ShiftMath.shiftOf(record(shiftId = "s2"), shifts, now, utc)?.id)
        assertEquals("s1", ShiftMath.shiftOf(record(), shifts, now, utc)?.id)
        assertNull(ShiftMath.shiftOf(record(clockIn = "2026-11-23T06:00:00Z", clockOut = "2026-11-23T07:00:00Z"), shifts, now, utc))
    }

    @Test
    fun gapsUnderAMinuteAreNoBreak() {
        val first = record("a", clockIn = "2026-11-23T09:00:00Z", clockOut = "2026-11-23T12:00:00Z")
        val second = record("b", clockIn = "2026-11-23T12:30:00Z", clockOut = "2026-11-23T17:00:00Z")
        val slip = record("c", clockIn = "2026-11-23T17:00:20Z", clockOut = "2026-11-23T18:00:00Z")
        assertEquals(listOf("2026-11-23T12:00:00Z" to "2026-11-23T12:30:00Z"), ShiftMath.clockedOutGaps(listOf(second, first, slip)))
    }

    @Test
    fun earningsPerCurrencyAndZeroWithoutARate() {
        val now = 0L
        assertEquals(listOf("EUR" to 0.0), ShiftMath.earnings(listOf(record(worked = 60)), now, "EUR"))
        val paid = ShiftMath.earnings(listOf(record(worked = 90, rate = 20.0, currency = "EUR"), record("b", worked = 60, rate = 10.0, currency = "USD")), now, "EUR")
        assertEquals(listOf("EUR" to 30.0, "USD" to 10.0), paid)
    }

    @Test
    fun durationsAndTimers() {
        assertEquals("7:05", ShiftMath.duration(425.0))
        assertEquals("01:02:08", ShiftMath.timer(3_728_000))
        assertEquals(7L to 5L, ShiftMath.hoursAndMinutes(425.0))
    }

    private fun leave(id: String, status: String, start: String, end: String, days: Double = 1.0) =
        LeaveRequest(id, "lt", "Holiday", null, start, end, days, null, status)

    @Test
    fun leaveSortsCurrentFirstThenThePast() {
        val sorted = LeaveRules.sortRequests(
            listOf(leave("past", "approved", "2026-01-05", "2026-01-06"), leave("later", "approved", "2026-12-20", "2026-12-24"), leave("soon", "pending", "2026-12-01", "2026-12-01")),
            "2026-11-27",
        )
        assertEquals(listOf("soon", "later", "past"), sorted.map { it.id })
    }

    @Test
    fun onlyPendingOrNotYetStartedLeaveCanBeCancelled() {
        assertTrue(LeaveRules.canCancel(leave("a", "pending", "2026-11-01", "2026-11-02"), "2026-11-27"))
        assertTrue(LeaveRules.canCancel(leave("a", "approved", "2026-12-01", "2026-12-02"), "2026-11-27"))
        assertFalse(LeaveRules.canCancel(leave("a", "approved", "2026-11-27", "2026-11-28"), "2026-11-27"))
        assertFalse(LeaveRules.canCancel(leave("a", "rejected", "2026-12-01", "2026-12-02"), "2026-11-27"))
    }

    @Test
    fun theAllowanceCheckBlocksOnlyWhenTheTypeSays() {
        val balance = LeaveBalance("lt", "Holiday", null, true, "block", 25.0, false, 20.0, 2.0, 3.0)
        assertEquals(LeaveRules.Allowance.Ok, LeaveRules.checkAllowance(balance, 3))
        assertEquals(LeaveRules.Allowance.Over(3.0, true), LeaveRules.checkAllowance(balance, 4))
        assertEquals(LeaveRules.Allowance.Over(3.0, false), LeaveRules.checkAllowance(balance.copy(overAllowance = "allow"), 4))
        assertEquals(LeaveRules.Allowance.Ok, LeaveRules.checkAllowance(balance.copy(remaining = null), 40))
        assertNull(LeaveRules.balanceForStart(listOf(balance), "lt", "2027-01-04", "2026-11-27"))
        assertEquals(balance, LeaveRules.balanceForStart(listOf(balance), "lt", "2026-12-01", "2026-11-27"))
    }

    private fun open(id: String, start: String, spotsLeft: Int, status: String? = null) =
        OpenShift(id, start, start, null, null, null, null, null, null, 2, spotsLeft, status?.let { OpenShiftRequest("r-$id", it, null) })

    @Test
    fun openShiftsStandingAndWhatIsListed() {
        val now = Instant.parse("2026-11-27T09:00:00Z").toEpochMilli()
        assertEquals(Standing.WAITING, OpenShiftRules.standingOf(open("a", "2026-11-28T09:00:00Z", 0, "pending")))
        assertEquals(Standing.DECLINED, OpenShiftRules.standingOf(open("a", "2026-11-28T09:00:00Z", 1, "rejected")))
        assertEquals(Standing.FULL, OpenShiftRules.standingOf(open("a", "2026-11-28T09:00:00Z", 0, "cancelled")))
        assertTrue(OpenShiftRules.canSignUp(open("a", "2026-11-28T09:00:00Z", 1, "rejected"), now))
        assertFalse(OpenShiftRules.canSignUp(open("a", "2026-11-28T09:00:00Z", 1, "pending"), now))
        val listed = OpenShiftRules.listable(
            listOf(
                open("later", "2026-11-30T09:00:00Z", 1),
                open("started", "2026-11-26T09:00:00Z", 1),
                open("mine", "2026-11-29T09:00:00Z", 1, "approved"),
                open("full", "2026-11-29T09:00:00Z", 0),
                open("waiting", "2026-11-28T09:00:00Z", 0, "pending"),
            ),
            now,
        )
        assertEquals(listOf("waiting", "later"), listed.map { it.id })
    }

    @Test
    fun announcementsPinnedFirstAndTheirAge() {
        val list = listOf(
            Announcement("old", "", "", false, "2026-11-01T09:00:00Z", null, null),
            Announcement("new", "", "", false, "2026-11-27T09:00:00Z", null, null),
            Announcement("pin", "", "", true, "2026-10-01T09:00:00Z", null, null),
        )
        assertEquals(listOf("pin", "new", "old"), AnnouncementRules.sort(list).map { it.id })
        val now = Instant.parse("2026-11-27T12:00:00Z")
        assertEquals(Age.Now, AnnouncementRules.ageOf("2026-11-27T11:59:30Z", now, utc))
        assertEquals(Age.Minutes(30), AnnouncementRules.ageOf("2026-11-27T11:30:00Z", now, utc))
        assertEquals(Age.Hours(3), AnnouncementRules.ageOf("2026-11-27T09:00:00Z", now, utc))
        assertEquals(Age.Yesterday, AnnouncementRules.ageOf("2026-11-26T09:00:00Z", now, utc))
        assertEquals(Age.Days(4), AnnouncementRules.ageOf("2026-11-23T09:00:00Z", now, utc))
        assertEquals(Age.Date, AnnouncementRules.ageOf("2026-11-01T09:00:00Z", now, utc))
        assertEquals("a b…", AnnouncementRules.preview("a\n\n b  c", 3))
    }

    private fun declaration(status: String, category: String) = Declaration("d", "2026-11-01", category, "Train", 12.5, "EUR", status, false)

    @Test
    fun theExpenseFilterHidesWhatIsSwitchedOff() {
        val filter = ExpenseFilter(statuses = setOf("paid"))
        assertTrue(filter.passes(declaration("pending", "travel")))
        assertFalse(filter.passes(declaration("paid", "travel")))
        val rows = listOf(declaration("pending", "meals"), declaration("approved", "travel"))
        assertEquals(listOf("pending", "approved", "paid"), ExpenseFilter.statusChoices(rows, filter))
        assertEquals(listOf("travel", "meals"), ExpenseFilter.categoryChoices(rows, ExpenseFilter()))
    }

    @Test
    fun searchIgnoresCaseAndAccentsAndNeedsEveryWord() {
        assertTrue(Search.matches("cafe okt", listOf("Café de Paris", "12 okt")))
        assertFalse(Search.matches("cafe nov", listOf("Café de Paris", "12 okt")))
        assertTrue(Search.matches("  ", listOf(null)))
    }

    @Test
    fun receiptsAreImagesOrPdfsUpTo10Mb() {
        assertNull(Receipts.problem("image/jpeg", 1_000))
        assertEquals(Receipts.Problem.TYPE, Receipts.problem("image/heic", 1_000))
        assertEquals(Receipts.Problem.SIZE, Receipts.problem("application/pdf", Receipts.MAX_BYTES + 1))
        assertEquals("application/pdf", Receipts.guessType("bon.PDF"))
        assertEquals("receipt-2026-11-27.jpg", Receipts.fileName(" ", "image/jpeg", "2026-11-27"))
        assertEquals("bon.png", Receipts.fileName("bon.png", "image/png", "2026-11-27"))
    }

    @Test
    fun amountsAsPeopleTypeThem() {
        assertEquals(12.5, parseAmount("12,50")!!, 0.0)
        assertEquals(1234.56, parseAmount("1.234,56")!!, 0.0)
        assertEquals(1234.56, parseAmount("1,234.56")!!, 0.0)
        assertEquals(12.5, parseAmount("€ 12.5")!!, 0.0)
        assertNull(parseAmount("0"))
        assertNull(parseAmount("abc"))
    }

    @Test
    fun tasksGroupPerChecklistOpenFirst() {
        val tasks = listOf(
            HrTask("1", "Laptop", null, "2026-12-01", "employee", "2026-11-20", true, "Onboarding"),
            HrTask("2", "Contract", null, "2026-12-05", "employee", null, true, "Onboarding"),
            HrTask("3", "Badge", null, null, "hr", null, false, "Onboarding"),
            HrTask("4", "Return keys", null, null, "employee", null, true, "Offboarding"),
        )
        val groups = groupTasks(tasks)
        assertEquals(listOf("Onboarding", "Offboarding"), groups.map { it.first })
        assertEquals(listOf("2", "3", "1"), groups.first().second.map { it.id })
    }

    @Test
    fun pushesAndLinksLeadToTheirScreen() {
        assertEquals(HrTarget.Announcement("ann_1"), HrRoutes.forPush(mapOf("notificationType" to "hr_announcement", "announcementId" to "ann_1")))
        assertEquals(HrTarget.Announcements, HrRoutes.forPush(mapOf("notificationType" to "hr_announcement")))
        assertEquals(HrTarget.Leave("lr_1"), HrRoutes.forPush(mapOf("route" to "/leave/lr_1")))
        assertNull(HrRoutes.forPush(mapOf("notificationType" to "other")))
        assertEquals(HrTarget.Expense("d 1"), HrRoutes.forPath("weldhr://expense/d%201"))
        assertEquals(HrTarget.Pay, HrRoutes.forPath("pay"))
        assertNull(HrRoutes.forPath("weldhr://sso-callback"))
    }

    @Test
    fun swatchesAreStableAndColoursParse() {
        assertEquals(Swatches.shift("Client"), Swatches.shift("Client"))
        assertEquals(0xFF112233, Swatches.hex("#123"))
        assertEquals(0xFF0D9488, Swatches.hex("#0D9488"))
        assertNull(Swatches.hex("teal"))
        assertTrue(Swatches.prefersDarkText(0xFFFFFFFF))
        assertFalse(Swatches.prefersDarkText(0xFF000000))
    }

    @Test
    fun clockFixesRoundTheAccuracy() {
        assertEquals(GeoFix(52.1, 4.3, 13.0), ClockLocator.toFix(52.1, 4.3, 12.6))
        assertEquals(GeoFix(52.1, 4.3, null), ClockLocator.toFix(52.1, 4.3, -1.0))
        assertNull(ClockLocator.toFix(Double.NaN, 4.3, null))
    }

    @Test
    fun safeFileNames() {
        assertEquals("a_b.pdf", HrRepository.safeFileName("a/b.pdf"))
        assertEquals("document.pdf", HrRepository.safeFileName("..."))
    }
}
