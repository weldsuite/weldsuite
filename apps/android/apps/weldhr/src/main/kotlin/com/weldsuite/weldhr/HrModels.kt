package com.weldsuite.weldhr

/*
 * WeldHR's data as the screens use it. The repository maps the generated API
 * types to these (HrRepository.kt), so a rename in the generated code stays
 * there. Statuses, categories and kinds stay strings: the screens label the
 * values they know and show the rest as they come.
 */

/** What My HR lets employees do (WeldHR settings, Self-service). */
data class Features(
    val selfClockIn: Boolean,
    val clockInRequiresLocation: Boolean,
    val leaveRequests: Boolean,
    val declarations: Boolean,
)

data class Profile(
    val id: String,
    val displayName: String,
    val email: String,
    val phone: String?,
    val avatarUrl: String?,
    val jobTitle: String?,
    val employeeNumber: String?,
    val status: String,
    val startDate: String?,
    val location: String?,
    val departmentName: String?,
    val managerName: String?,
)

/** `GET /me`: the employee record (null when none is linked) and the features. */
data class Me(val employee: Profile?, val features: Features)

data class UpcomingShift(val id: String, val startsAt: String, val endsAt: String, val companyName: String?)

data class Overview(
    val clockedIn: Boolean,
    val since: String?,
    /** The shift the open clock record is on. */
    val clockShiftId: String?,
    val upcomingShifts: List<UpcomingShift>,
    val openTasks: Int,
    val toAcknowledge: Int,
    val openShifts: Int,
    val unreadAnnouncements: Int,
    /** The newest evaluation shared with the member; null without one. */
    val latestEvaluation: EvaluationSummary? = null,
    /** Milestones achieved, and still planned or in progress; null when the server does not say. */
    val milestones: MilestoneCount? = null,
)

/** An evaluation as the overview names it: its score (0-100), form and when it was submitted. */
data class EvaluationSummary(val overallScore: Double?, val formName: String?, val submittedAt: String?)

data class MilestoneCount(val achieved: Int, val open: Int)

/** Hours clocked: the caller's own, or a teammate's (with [employeeName]). */
data class ClockRecord(
    val id: String,
    val date: String,
    val clockIn: String?,
    val clockOut: String?,
    val breakMinutes: Int?,
    val workedMinutes: Int?,
    val lateMinutes: Int?,
    val status: String,
    val source: String,
    val approved: Boolean,
    val companyName: String?,
    val shiftId: String?,
    val notes: String?,
    val hourlyRate: Double?,
    val currency: String?,
    val employeeId: String? = null,
    val employeeName: String? = null,
)

/** A planned shift: the caller's own, or a teammate's (with [employeeName]). */
data class Shift(
    val id: String,
    val startsAt: String,
    val endsAt: String,
    val workType: String?,
    val breakStartsAt: String?,
    val breakEndsAt: String?,
    val companyName: String?,
    val notes: String?,
    val hourlyRate: Double?,
    val currency: String?,
    val employeeId: String? = null,
    val employeeName: String? = null,
)

/** A shift the caller asked to work, or signed up for. */
data class ShiftRequest(
    val id: String,
    val openShiftId: String?,
    val startsAt: String,
    val endsAt: String,
    val workType: String?,
    val note: String?,
    val status: String,
    val reviewedAt: String?,
    val reviewedByName: String?,
    val reviewNote: String?,
    val createdAt: String,
)

data class Attendance(val records: List<ClockRecord>, val shifts: List<Shift>, val requests: List<ShiftRequest>)

data class LeaveType(val id: String, val name: String, val color: String?, val requiresApproval: Boolean)

data class LeaveBalance(
    val leaveTypeId: String,
    val name: String,
    val color: String?,
    val isPaid: Boolean,
    /** `allow` (with a warning) or `block`. */
    val overAllowance: String,
    /** Days this year; null is no limit. */
    val allowance: Double?,
    val prorated: Boolean,
    val used: Double,
    val pending: Double,
    val remaining: Double?,
)

/** A leave request: the caller's own, or one to approve (with [employeeName]). */
data class LeaveRequest(
    val id: String,
    val leaveTypeId: String,
    val leaveTypeName: String?,
    val leaveTypeColor: String?,
    val startDate: String,
    val endDate: String,
    val days: Double,
    val reason: String?,
    val status: String,
    val reviewNote: String? = null,
    val reviewedAt: String? = null,
    val reviewedByName: String? = null,
    val createdAt: String? = null,
    val employeeId: String? = null,
    val employeeName: String? = null,
)

data class Leave(val types: List<LeaveType>, val balances: List<LeaveBalance>, val requests: List<LeaveRequest>)

data class OpenShiftRequest(val id: String, val status: String, val reviewNote: String?)

data class OpenShift(
    val id: String,
    val startsAt: String,
    val endsAt: String,
    val workType: String?,
    val breakStartsAt: String?,
    val breakEndsAt: String?,
    val notes: String?,
    val companyName: String?,
    val departmentName: String?,
    val spots: Int,
    val spotsLeft: Int,
    /** The caller's latest sign-up; null when they have not signed up. */
    val myRequest: OpenShiftRequest?,
)

data class Announcement(
    val id: String,
    val title: String,
    val body: String,
    val pinned: Boolean,
    val publishedAt: String,
    val createdByName: String?,
    /** Null while unread. */
    val readAt: String?,
)

data class Announcements(val announcements: List<Announcement>, val unread: Int)

/** A sick report: the caller's own, or a teammate's (with [employeeName]). */
data class Absence(
    val id: String,
    val startDate: String,
    val endDate: String?,
    val firstDay: String,
    val note: String?,
    /** `ongoing` or `completed`. */
    val status: String,
    val days: Double,
    val createdAt: String? = null,
    val employeeId: String? = null,
    val employeeName: String? = null,
)

data class Absences(val current: Absence?, val history: List<Absence>)

/** An expense claim: the caller's own, or one to approve (with [employeeName]). */
data class Declaration(
    val id: String,
    val expenseDate: String,
    val category: String,
    val description: String,
    val amount: Double,
    val currency: String,
    val status: String,
    val hasReceipt: Boolean,
    val receiptFileName: String? = null,
    val reviewNote: String? = null,
    val reviewedAt: String? = null,
    val paidAt: String? = null,
    val createdAt: String? = null,
    val employeeId: String? = null,
    val employeeName: String? = null,
)

data class OpenAmount(val currency: String, val pending: Double, val approved: Double)

data class Declarations(val declarations: List<Declaration>, val open: List<OpenAmount>)

data class HrTask(
    val id: String,
    val title: String,
    val description: String?,
    val dueDate: String?,
    /** hr, manager, it, employee or other. */
    val assigneeRole: String,
    val completedAt: String?,
    val canComplete: Boolean,
    val checklistName: String,
)

data class ActionItem(val id: String, val text: String, val done: Boolean)

data class CoachingLog(
    val id: String,
    val sessionDate: String,
    val category: String,
    val topic: String,
    val notes: String?,
    val actionItems: List<ActionItem>,
    val followUpDate: String?,
    val coachName: String?,
    val acknowledgedAt: String?,
    val employeeComment: String?,
)

data class Criterion(val id: String, val label: String, val maxScore: Double)

data class Score(val criterionId: String, val score: Double?)

data class Evaluation(
    val id: String,
    val formName: String?,
    val periodStart: String?,
    val periodEnd: String?,
    val criteria: List<Criterion>,
    val scores: List<Score>,
    val overallScore: Double?,
    val summary: String?,
    val evaluatorName: String?,
    val acknowledgedAt: String?,
    val employeeComment: String?,
)

data class Payslip(
    val id: String,
    val number: String?,
    val employerName: String,
    val currency: String,
    val periodStart: String,
    val periodEnd: String,
    val payDate: String,
    /** Decimal strings, two decimals. */
    val grossPay: String,
    val netPay: String,
    /** Null shows it as new. */
    val viewedAt: String?,
)

data class AnnualStatement(val year: Int, val employerId: String, val employerName: String, val kind: String)

data class Colleague(
    val id: String,
    val displayName: String,
    val email: String?,
    val avatarUrl: String?,
    val jobTitle: String?,
    val departmentName: String?,
)

data class ColleagueDetail(
    val id: String,
    val displayName: String,
    val email: String,
    val phone: String?,
    val avatarUrl: String?,
    val pronouns: String?,
    val jobTitle: String?,
    val departmentName: String?,
    val managerName: String?,
    val status: String,
    val startDate: String?,
    val location: String?,
    val directReports: List<Colleague>,
)

/** The phone's position for a clock call. */
data class GeoFix(val latitude: Double, val longitude: Double, val accuracy: Double?)
