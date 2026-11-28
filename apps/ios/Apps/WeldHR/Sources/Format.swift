import SwiftUI
import WeldCore
import WeldUI

/// Dates, times and amounts as the screens show them, in the phone's language.
enum Fmt {
    static let range = " - "

    private static func format(_ date: Date, _ template: String) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale.current
        formatter.setLocalizedDateFormatFromTemplate(template)
        return formatter.string(from: date)
    }

    private static func thisYear(_ date: Date) -> Bool {
        Calendar.current.isDate(date, equalTo: Date(), toGranularity: .year)
    }

    /// "Mon 3 Mar"; the year only when it is not this year.
    static func day(_ iso: String?) -> String {
        guard let date = HRDays.parse(iso) else { return iso ?? "" }
        return format(date, thisYear(date) ? "EEEdMMM" : "EEEdMMMyyyy")
    }

    /// "3 Mar 2026", for a day or a timestamp.
    static func date(_ text: String?) -> String {
        guard let date = HRDays.parse(text) ?? WeldDate.parse(text) else { return text ?? "" }
        return date.formatted(date: .abbreviated, time: .omitted)
    }

    /// "25 Oct".
    static func shortDate(_ iso: String) -> String {
        guard let date = HRDays.parse(iso) else { return iso }
        return format(date, "dMMM").replacingOccurrences(of: ".", with: "")
    }

    /// "19 Oct - 25 Oct", or one day when both ends match.
    static func span(_ start: String, _ end: String) -> String {
        start == end ? shortDate(start) : "\(shortDate(start))\(range)\(shortDate(end))"
    }

    /// "3 - 7 Mar", "28 Feb - 3 Mar", or one day.
    static func dateRange(_ start: String, _ end: String) -> String {
        if start == end { return day(start) }
        guard let from = HRDays.parse(start), let to = HRDays.parse(end) else { return "\(start)\(range)\(end)" }
        let calendar = Calendar.current
        let sameYear = calendar.isDate(from, equalTo: to, toGranularity: .year)
        let withYear = !thisYear(to) || !sameYear
        let right = format(to, withYear ? "dMMMyyyy" : "dMMM")
        let left: String
        if calendar.isDate(from, equalTo: to, toGranularity: .month) {
            left = String(calendar.component(.day, from: from))
        } else {
            left = format(from, sameYear ? "dMMM" : "dMMMyyyy")
        }
        return "\(left)\(range)\(right)"
    }

    /// "Sunday 25 October", capitalised; the year only when it is not this year.
    static func longDay(_ iso: String) -> String {
        guard let date = HRDays.parse(iso) else { return iso }
        let text = format(date, thisYear(date) ? "EEEEdMMMM" : "EEEEdMMMMyyyy").replacingOccurrences(of: ",", with: "")
        return text.prefix(1).uppercased() + text.dropFirst()
    }

    /// "Ma", the weekday at the head of a day in a grouped list.
    static func weekdayShort(_ iso: String) -> String {
        guard let date = HRDays.parse(iso) else { return "" }
        let text = String(format(date, "EEE").prefix(2))
        return text.prefix(1).uppercased() + text.dropFirst()
    }

    /// "09:05" from a timestamp, in the phone's time zone.
    static func time(_ timestamp: String?) -> String {
        guard let date = WeldDate.parse(timestamp) else { return "" }
        return date.formatted(date: .omitted, time: .shortened)
    }

    /// "09:00 - 16:30"; "09:00 - …" while still running.
    static func timeRange(_ start: String?, _ end: String?) -> String {
        "\(time(start))\(range)\(end.map(time) ?? "…")"
    }

    static func money(_ amount: Double, _ currency: String?) -> String { Money.format(amount, currency: currency) }

    static func money(_ decimal: String, _ currency: String?) -> String {
        guard let amount = Money.parse(decimal) else { return decimal }
        return Money.format(amount, currency: currency)
    }

    /// Leave days: whole numbers bare, halves with one decimal.
    static func days(_ value: Double) -> String { value.formatted(.number.precision(.fractionLength(0 ... 1))) }

    static func isWhole(_ value: Double) -> Bool { value == value.rounded(.down) }

    /// "7h 30m" in the app's language.
    static func hm(_ minutes: Double) -> String {
        let (hours, rest) = ShiftMath.hoursAndMinutes(minutes)
        return HRStrings.commonHm(h: String(hours), m: String(rest))
    }

    /// "3 days", "1 day", or "1.5 days".
    static func daysText(_ days: Double) -> String {
        isWhole(days) ? HRStrings.balanceDays(Int(days)) : HRStrings.balanceDaysFraction(days: Fmt.days(days))
    }

    /// "0:24 | € 7,40": what hours earn, € 0,00 without a rate.
    static func earnings(_ pairs: [(String, Double)]) -> String {
        pairs.map { money($0.1, $0.0) }.joined(separator: " · ")
    }
}

enum Labels {
    /// A sick report's badge, as the platform's: Sick while it runs, Recovered after.
    static func absenceStatus(_ status: String) -> String {
        status == "ongoing" ? HRStrings.absenceSick : HRStrings.absenceRecovered
    }

    static func leaveStatus(_ status: String) -> String {
        switch status {
        case "pending": HRStrings.leaveStatusPending
        case "approved": HRStrings.leaveStatusApproved
        case "rejected": HRStrings.leaveStatusRejected
        case "cancelled": HRStrings.leaveStatusCancelled
        default: status
        }
    }

    static func declarationStatus(_ status: String) -> String {
        switch status {
        case "pending": HRStrings.declarationStatusPending
        case "approved": HRStrings.declarationStatusApproved
        case "rejected": HRStrings.declarationStatusRejected
        case "paid": HRStrings.declarationStatusPaid
        case "cancelled": HRStrings.declarationStatusCancelled
        default: status
        }
    }

    static func category(_ category: String) -> String {
        switch category {
        case "travel": HRStrings.declarationCategoryTravel
        case "meals": HRStrings.declarationCategoryMeals
        case "accommodation": HRStrings.declarationCategoryAccommodation
        case "equipment": HRStrings.declarationCategoryEquipment
        case "training": HRStrings.declarationCategoryTraining
        case "other": HRStrings.declarationCategoryOther
        default: category
        }
    }

    static func employeeStatus(_ status: String) -> String {
        switch status {
        case "onboarding": HRStrings.employeeStatusOnboarding
        case "active": HRStrings.employeeStatusActive
        case "on_leave": HRStrings.employeeStatusOnLeave
        case "offboarding": HRStrings.employeeStatusOffboarding
        case "terminated": HRStrings.employeeStatusTerminated
        default: status
        }
    }

    static func attendanceStatus(_ status: String) -> String {
        switch status {
        case "present": HRStrings.attendanceStatusPresent
        case "late": HRStrings.attendanceStatusLate
        case "absent": HRStrings.attendanceStatusAbsent
        case "excused": HRStrings.attendanceStatusExcused
        case "remote": HRStrings.attendanceStatusRemote
        case "half_day": HRStrings.attendanceStatusHalfDay
        default: status
        }
    }

    static func shiftRequestStatus(_ status: String) -> String {
        switch status {
        case "pending": HRStrings.shiftRequestStatusPending
        case "approved": HRStrings.shiftRequestStatusApproved
        case "rejected": HRStrings.shiftRequestStatusRejected
        case "cancelled": HRStrings.shiftRequestStatusCancelled
        default: status
        }
    }

    static func source(_ source: String) -> String {
        switch source {
        case "portal": HRStrings.shiftSourcePortal
        case "manual": HRStrings.shiftSourceManual
        case "import": HRStrings.shiftSourceImport
        case "api": HRStrings.shiftSourceApi
        default: source
        }
    }

    static func role(_ role: String) -> String {
        switch role {
        case "hr": HRStrings.tasksRolesHr
        case "manager": HRStrings.tasksRolesManager
        case "it": HRStrings.tasksRolesIt
        case "employee": HRStrings.tasksRolesEmployee
        default: HRStrings.tasksRolesOther
        }
    }

    static func coachingCategory(_ category: String) -> String {
        switch category {
        case "performance": HRStrings.coachingCategoryPerformance
        case "quality": HRStrings.coachingCategoryQuality
        case "behavior": HRStrings.coachingCategoryBehavior
        case "attendance": HRStrings.coachingCategoryAttendance
        case "development": HRStrings.coachingCategoryDevelopment
        case "recognition": HRStrings.coachingCategoryRecognition
        default: category
        }
    }

    static func standing(_ standing: Standing) -> String {
        switch standing {
        case .open: HRStrings.openShiftsSignUp
        case .waiting: HRStrings.openShiftsWaiting
        case .declined: HRStrings.openShiftsDeclined
        case .full: HRStrings.openShiftsFull
        }
    }

    /// "11m", "3h", "Yesterday", "4d", or the date once it is a week old.
    static func age(_ publishedAt: String) -> String {
        switch AnnouncementRules.ageOf(publishedAt) {
        case .now: HRStrings.announcementsJustNow
        case let .minutes(count): HRStrings.announcementsMinutesAgo(count: count)
        case let .hours(count): HRStrings.announcementsHoursAgo(count: count)
        case .yesterday: HRStrings.announcementsYesterday
        case let .days(count): HRStrings.announcementsDaysAgo(count: count)
        case .date: Fmt.date(publishedAt)
        }
    }
}

/// Your sign-up as the platform's badge: waiting outlined, declined destructive;
/// none while you can still sign up or once it is full (the spots say so).
func standingTag(_ standing: Standing) -> HRTag? {
    switch standing {
    case .waiting: HRTag(text: Labels.standing(standing), tone: .outline)
    case .declined: HRTag(text: Labels.standing(standing), tone: .destructive)
    case .open, .full: nil
    }
}

/// "2 spots left", or "Full", as the platform's Spots column.
func spotsText(_ spotsLeft: Int) -> String {
    spotsLeft == 0 ? HRStrings.openShiftsFull : HRStrings.openShiftsSpotsLeft(spotsLeft)
}

/// Clocked hours' approval, as the platform's Hours groups: Approved, or Not approved yet (outlined).
func approvalTag(_ approved: Bool) -> HRTag {
    approved ? HRTag(text: HRStrings.timesheetApproved, tone: .primary) : HRTag(text: HRStrings.timesheetPendingApproval, tone: .outline)
}
