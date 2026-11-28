import Foundation

// WeldHR's data as the screens use it. HRStore.swift maps the generated API
// types to these, so a rename in the generated code stays there. Statuses,
// categories and kinds stay strings: the screens label the values they know
// and show the rest as they come.

/// What My HR lets employees do (WeldHR settings, Self-service).
struct HRFeatures: Equatable {
    let selfClockIn: Bool
    let clockInRequiresLocation: Bool
    let leaveRequests: Bool
    let declarations: Bool
}

struct HRProfile: Equatable {
    let id: String
    let displayName: String
    let email: String
    let phone: String?
    let avatarUrl: String?
    let jobTitle: String?
    let employeeNumber: String?
    let status: String
    let startDate: String?
    let location: String?
    let departmentName: String?
    let managerName: String?
}

/// `GET /me`: the employee record (nil when none is linked) and the features.
struct HRMe: Equatable {
    let employee: HRProfile?
    let features: HRFeatures
}

struct HRUpcomingShift: Identifiable, Equatable {
    let id: String
    let startsAt: String
    let endsAt: String
    let companyName: String?
}

struct HROverview: Equatable {
    let clockedIn: Bool
    let since: String?
    /// The shift the open clock record is on.
    let clockShiftId: String?
    let upcomingShifts: [HRUpcomingShift]
    let openTasks: Int
    let toAcknowledge: Int
    let openShifts: Int
    let unreadAnnouncements: Int
    /// The newest evaluation shared with the member; nil without one.
    var latestEvaluation: HREvaluationSummary?
    /// Milestones achieved, and still planned or in progress; nil when the server does not say.
    var milestones: HRMilestoneCount?
}

/// An evaluation as the overview names it: its score (0-100), form and when it was submitted.
struct HREvaluationSummary: Equatable {
    let overallScore: Double?
    let formName: String?
    let submittedAt: String?
}

struct HRMilestoneCount: Equatable {
    let achieved: Int
    let open: Int
}

/// Hours clocked: the caller's own, or a teammate's (with `employeeName`).
struct HRClockRecord: Identifiable, Equatable {
    let id: String
    let date: String
    let clockIn: String?
    let clockOut: String?
    let breakMinutes: Int?
    let workedMinutes: Int?
    let lateMinutes: Int?
    let status: String
    let source: String
    let approved: Bool
    let companyName: String?
    let shiftId: String?
    let notes: String?
    let hourlyRate: Double?
    let currency: String?
    var employeeId: String? = nil
    var employeeName: String? = nil
}

/// A planned shift: the caller's own, or a teammate's (with `employeeName`).
struct HRShift: Identifiable, Equatable {
    let id: String
    let startsAt: String
    let endsAt: String
    let workType: String?
    let breakStartsAt: String?
    let breakEndsAt: String?
    let companyName: String?
    let notes: String?
    let hourlyRate: Double?
    let currency: String?
    var employeeId: String? = nil
    var employeeName: String? = nil
}

/// A shift the caller asked to work, or signed up for.
struct HRShiftRequest: Identifiable, Equatable {
    let id: String
    let openShiftId: String?
    let startsAt: String
    let endsAt: String
    let workType: String?
    let note: String?
    let status: String
    let reviewedAt: String?
    let reviewedByName: String?
    let reviewNote: String?
    let createdAt: String
}

struct HRAttendance: Equatable {
    let records: [HRClockRecord]
    let shifts: [HRShift]
    let requests: [HRShiftRequest]
}

struct HRLeaveType: Identifiable, Equatable {
    let id: String
    let name: String
    let color: String?
    let requiresApproval: Bool
}

struct HRLeaveBalance: Identifiable, Equatable {
    let leaveTypeId: String
    let name: String
    let color: String?
    let isPaid: Bool
    /// `allow` (with a warning) or `block`.
    let overAllowance: String
    /// Days this year; nil is no limit.
    let allowance: Double?
    let prorated: Bool
    let used: Double
    let pending: Double
    let remaining: Double?

    var id: String { leaveTypeId }
}

/// A leave request: the caller's own, or one to approve (with `employeeName`).
struct HRLeaveRequest: Identifiable, Equatable {
    let id: String
    let leaveTypeId: String
    let leaveTypeName: String?
    let leaveTypeColor: String?
    let startDate: String
    let endDate: String
    let days: Double
    let reason: String?
    let status: String
    var reviewNote: String? = nil
    var reviewedAt: String? = nil
    var reviewedByName: String? = nil
    var createdAt: String? = nil
    var employeeId: String? = nil
    var employeeName: String? = nil
}

struct HRLeave: Equatable {
    let types: [HRLeaveType]
    let balances: [HRLeaveBalance]
    let requests: [HRLeaveRequest]
}

struct HROpenShiftRequest: Equatable {
    let id: String
    let status: String
    let reviewNote: String?
}

struct HROpenShift: Identifiable, Equatable {
    let id: String
    let startsAt: String
    let endsAt: String
    let workType: String?
    let breakStartsAt: String?
    let breakEndsAt: String?
    let notes: String?
    let companyName: String?
    let departmentName: String?
    let spots: Int
    let spotsLeft: Int
    /// The caller's latest sign-up; nil when they have not signed up.
    let myRequest: HROpenShiftRequest?
}

struct HRAnnouncement: Identifiable, Equatable {
    let id: String
    let title: String
    let body: String
    let pinned: Bool
    let publishedAt: String
    let createdByName: String?
    /// Nil while unread.
    let readAt: String?
}

struct HRAnnouncements: Equatable {
    let announcements: [HRAnnouncement]
    let unread: Int
}

/// A sick report: the caller's own, or a teammate's (with `employeeName`).
struct HRAbsence: Identifiable, Equatable {
    let id: String
    let startDate: String
    let endDate: String?
    let firstDay: String
    let note: String?
    /// `ongoing` or `completed`.
    let status: String
    let days: Double
    var createdAt: String? = nil
    var employeeId: String? = nil
    var employeeName: String? = nil
}

struct HRAbsences: Equatable {
    let current: HRAbsence?
    let history: [HRAbsence]
}

/// An expense claim: the caller's own, or one to approve (with `employeeName`).
struct HRDeclaration: Identifiable, Equatable {
    let id: String
    let expenseDate: String
    let category: String
    let description: String
    let amount: Double
    let currency: String
    let status: String
    let hasReceipt: Bool
    var receiptFileName: String? = nil
    var reviewNote: String? = nil
    var reviewedAt: String? = nil
    var paidAt: String? = nil
    var createdAt: String? = nil
    var employeeId: String? = nil
    var employeeName: String? = nil
}

struct HROpenAmount: Equatable {
    let currency: String
    let pending: Double
    let approved: Double
}

struct HRDeclarations: Equatable {
    let declarations: [HRDeclaration]
    let open: [HROpenAmount]
}

struct HRTask: Identifiable, Equatable {
    let id: String
    let title: String
    let description: String?
    let dueDate: String?
    /// hr, manager, it, employee or other.
    let assigneeRole: String
    let completedAt: String?
    let canComplete: Bool
    let checklistName: String
}

struct HRActionItem: Identifiable, Equatable {
    let id: String
    let text: String
    let done: Bool
}

struct HRCoachingLog: Identifiable, Equatable {
    let id: String
    let sessionDate: String
    let category: String
    let topic: String
    let notes: String?
    let actionItems: [HRActionItem]
    let followUpDate: String?
    let coachName: String?
    let acknowledgedAt: String?
    let employeeComment: String?
}

struct HRCriterion: Identifiable, Equatable {
    let id: String
    let label: String
    let maxScore: Double
}

struct HRScore: Equatable {
    let criterionId: String
    let score: Double?
}

struct HREvaluation: Identifiable, Equatable {
    let id: String
    let formName: String?
    let periodStart: String?
    let periodEnd: String?
    let criteria: [HRCriterion]
    let scores: [HRScore]
    let overallScore: Double?
    let summary: String?
    let evaluatorName: String?
    let acknowledgedAt: String?
    let employeeComment: String?
}

struct HRPayslip: Identifiable, Equatable {
    let id: String
    let number: String?
    let employerName: String
    let currency: String
    let periodStart: String
    let periodEnd: String
    let payDate: String
    /// Decimal strings, two decimals.
    let grossPay: String
    let netPay: String
    /// Nil shows it as new.
    let viewedAt: String?
}

struct HRAnnualStatement: Identifiable, Equatable {
    let year: Int
    let employerId: String
    let employerName: String
    let kind: String

    var id: String { "\(year)-\(employerId)" }
}

struct HRColleague: Identifiable, Equatable {
    let id: String
    let displayName: String
    let email: String?
    let avatarUrl: String?
    let jobTitle: String?
    let departmentName: String?
}

struct HRColleagueDetail: Equatable {
    let id: String
    let displayName: String
    let email: String
    let phone: String?
    let avatarUrl: String?
    let pronouns: String?
    let jobTitle: String?
    let departmentName: String?
    let managerName: String?
    let status: String
    let startDate: String?
    let location: String?
    let directReports: [HRColleague]
}

/// The phone's position for a clock call.
struct HRGeoFix: Equatable {
    let latitude: Double
    let longitude: Double
    let accuracy: Double?
}

/// A photo or PDF picked for a receipt, read into memory (at most 10 MB).
struct HRPickedFile: Equatable {
    let name: String
    let mimeType: String
    let data: Data
}
