package com.weldsuite.weldhr

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.RequestBody.Companion.toRequestBody
import org.weldsuite.api.weldhr.apis.DefaultApi
import org.weldsuite.api.weldhr.models.AcknowledgeInput
import org.weldsuite.api.weldhr.models.AnnouncementInput
import org.weldsuite.api.weldhr.models.ClockInput
import org.weldsuite.api.weldhr.models.ClockLocation
import org.weldsuite.api.weldhr.models.DeclarationInput
import org.weldsuite.api.weldhr.models.LeaveRequestInput
import org.weldsuite.api.weldhr.models.MyAbsence
import org.weldsuite.api.weldhr.models.MyAttendanceRecord
import org.weldsuite.api.weldhr.models.MyLeaveRequest
import org.weldsuite.api.weldhr.models.MyShift
import org.weldsuite.api.weldhr.models.MyShiftRequest
import org.weldsuite.api.weldhr.models.NoteInput
import org.weldsuite.api.weldhr.models.RecoverInput
import org.weldsuite.api.weldhr.models.ReviewInput
import org.weldsuite.api.weldhr.models.ShiftRequestInput
import org.weldsuite.api.weldhr.models.SickReportInput
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.LoadState
import org.weldsuite.core.api.ApiException
import org.weldsuite.core.api.apiCall
import java.io.File
import org.weldsuite.api.weldhr.models.Profile as ApiProfile

/**
 * One query the screens show: what was last loaded and how loading went. A
 * write reloads every query that was shown (`invalidate`), as the Expo app
 * invalidates its `weldhr` key root, and a realtime `hr_*` event does too.
 */
class Query<T>(private val scope: CoroutineScope, private val fetch: suspend () -> T) {
    private val flow = MutableStateFlow(LoadState<T>())
    val state: StateFlow<LoadState<T>> = flow.asStateFlow()

    /** Shown at least once since the last reset: reloaded on invalidation. */
    var used = false
        private set

    suspend fun load() {
        used = true
        flow.value = flow.value.copy(loading = true)
        try {
            flow.value = LoadState(fetch())
        } catch (cancelled: CancellationException) {
            flow.value = flow.value.copy(loading = false)
            throw cancelled
        } catch (error: Exception) {
            flow.value = LoadState(flow.value.data, error = error)
        }
    }

    /** Load unless it already has data (a screen opening). */
    fun ensure() {
        if (flow.value.data == null && !flow.value.loading) scope.launch { load() }
        used = true
    }

    fun refresh() {
        scope.launch { load() }
    }

    fun reset() {
        used = false
        flow.value = LoadState()
    }
}

/** A query per key (a week, a day, a search). */
class KeyedQuery<K, T>(private val scope: CoroutineScope, private val fetch: suspend (K) -> T) {
    private val queries = LinkedHashMap<K, Query<T>>()

    operator fun get(key: K): Query<T> = queries.getOrPut(key) { Query(scope) { fetch(key) } }.also {
        // Only the last few keys stay around (the weeks someone paged through).
        while (queries.size > 12) queries.remove(queries.keys.first())
    }

    val all: Collection<Query<T>> get() = queries.values

    fun reset() = queries.clear()
}

/**
 * WeldHR's reads and writes for the active workspace. The generated API
 * types are mapped to the app's own (HrModels.kt) here and nowhere else.
 */
class HrRepository(private val env: AppEnvironment, val scope: CoroutineScope) {
    private val api: DefaultApi get() = env.api.create()
    private val raw: HrRawApi get() = env.api.create()
    private var workspace: String? = null

    val access = Query(scope) { loadAccess() }
    val me = Query(scope) { mapMe() }
    val overview = Query(scope) { mapOverview() }
    val leave = Query(scope) { mapLeave() }
    val absences = Query(scope) { mapAbsences() }
    val declarations = Query(scope) { mapDeclarations() }
    val announcements = Query(scope) { mapAnnouncements() }
    val openShifts = Query(scope) { apiCall { api.listMyOpenShifts() }.data.map(::openShift) }
    val tasks = Query(scope) { apiCall { api.listMyTasks() }.data.map(::task) }
    val coaching = Query(scope) { apiCall { api.listMyCoaching() }.data.map(::coachingLog) }
    val evaluations = Query(scope) { apiCall { api.listMyEvaluations() }.data.map(::evaluation) }

    /** Null while payroll is off for the workspace (the server answers 404). */
    val payslips = Query(scope) {
        try {
            apiCall { api.listMyPayslips() }.data.map(::payslip)
        } catch (missing: ApiException) {
            if (missing.status == 404) null else throw missing
        }
    }

    val statements = Query(scope) {
        try {
            apiCall { api.listMyAnnualStatements() }.data.map { AnnualStatement(it.year, it.employerId, it.employerName, it.kind) }
        } catch (missing: ApiException) {
            if (missing.status == 404) emptyList() else throw missing
        }
    }

    /** The caller's shifts and hours for a week (`from` to `to`, inclusive). */
    val attendance = KeyedQuery<Pair<String, String>, Attendance>(scope) { (from, to) -> mapAttendance(from, to) }

    val pendingLeave = Query(scope) { apiCall { api.listLeaveRequests(status = "pending") }.data.map(::teamLeave) }
    val pendingExpenses = Query(scope) { apiCall { api.listDeclarations(status = "pending") }.data.map(::teamDeclaration) }

    /** Recent sick reports, ongoing and closed, for who was out on a given day. */
    val sickReports = Query(scope) { apiCall { api.listAbsences(limit = 100) }.data.map(::teamAbsence) }

    /** Approved leave overlapping the days from `first` to `second`. */
    val teamLeave = KeyedQuery<Pair<String, String>, List<LeaveRequest>>(scope) { (from, to) ->
        apiCall { api.listLeaveRequests(status = "approved", from = from, to = to) }.data.map(::teamLeave)
    }

    val teamShifts = KeyedQuery<Pair<String, String>, List<Shift>>(scope) { (from, to) ->
        apiCall { api.listShifts(from = from, to = to) }.data.map(::teamShift)
    }

    val teamAttendance = KeyedQuery<Pair<String, String>, List<ClockRecord>>(scope) { (from, to) ->
        apiCall { api.listAttendance(from = from, to = to, limit = 200) }.data.map(::teamRecord)
    }

    /** The directory: everyone still on the books. */
    val employees = KeyedQuery<String, List<Colleague>>(scope) { search ->
        apiCall { api.listEmployees(search = search.ifBlank { null }, status = CURRENT_STATUSES, limit = 100) }.data.map {
            Colleague(it.id, it.displayName, it.email, it.avatarUrl, it.jobTitle, it.departmentName)
        }
    }

    val employee = KeyedQuery<String, ColleagueDetail>(scope) { id -> mapEmployee(id) }

    private val singles get() = listOf(
        access, me, overview, leave, absences, declarations, announcements, openShifts, tasks, coaching,
        evaluations, payslips, statements, pendingLeave, pendingExpenses, sickReports,
    )
    private val keyed get() = listOf(attendance, teamLeave, teamShifts, teamAttendance, employees, employee)

    /** Forget another workspace's data the moment the workspace changes. */
    fun useWorkspace(id: String) {
        if (workspace == id) return
        workspace = id
        singles.forEach { it.reset() }
        keyed.forEach { it.reset() }
    }

    /** Reload everything that was shown: after a write, a realtime event or a pull to refresh. */
    fun invalidate() {
        singles.filter { it.used }.forEach { it.refresh() }
        keyed.flatMap { it.all }.filter { it.used }.forEach { it.refresh() }
    }

    // Writes -----------------------------------------------------------------

    suspend fun clock(action: String, shiftId: String? = null, fix: GeoFix? = null) {
        val location = fix?.let { ClockLocation(latitude = it.latitude, longitude = it.longitude, accuracy = it.accuracy) }
        apiCall { api.clockMe(ClockInput(action = action, shiftId = shiftId, location = location)) }
        invalidate()
    }

    /** The new request's status: `approved` for a type that needs no approval. */
    suspend fun requestLeave(typeId: String, startDate: String, endDate: String, reason: String?): String {
        val row = apiCall { api.requestLeave(LeaveRequestInput(leaveTypeId = typeId, startDate = startDate, endDate = endDate, reason = reason)) }
        invalidate()
        return row.data.status
    }

    suspend fun cancelLeave(id: String) {
        apiCall { api.cancelMyLeave(id) }
        invalidate()
    }

    suspend fun requestShift(startsAt: String, endsAt: String, workType: String?, note: String?) {
        apiCall { api.requestShift(ShiftRequestInput(startsAt = startsAt, endsAt = endsAt, workType = workType, note = note)) }
        invalidate()
    }

    suspend fun cancelShiftRequest(id: String) {
        apiCall { api.cancelMyShiftRequest(id) }
        invalidate()
    }

    suspend fun signUp(openShiftId: String, note: String?) {
        apiCall { api.signUpForOpenShift(openShiftId, NoteInput(note = note)) }
        invalidate()
    }

    suspend fun markRead(id: String) {
        apiCall { api.markAnnouncementRead(id) }
        invalidate()
    }

    suspend fun reportSick(startDate: String, firstDay: String, note: String?) {
        apiCall { api.reportSick(SickReportInput(startDate = startDate, firstDay = firstDay, note = note)) }
        invalidate()
    }

    suspend fun reportRecovered(id: String, endDate: String) {
        apiCall { api.reportRecovered(id, RecoverInput(endDate = endDate)) }
        invalidate()
    }

    /**
     * File a claim, then attach the receipt. They are two calls; when only the
     * upload fails the claim still stands, so this says so (`false`) rather than throw.
     */
    suspend fun createDeclaration(
        amount: Double,
        currency: String,
        expenseDate: String,
        category: String,
        description: String,
        receipt: PickedFile?,
    ): Boolean {
        val created = apiCall {
            api.createDeclaration(
                DeclarationInput(amount = amount, currency = currency, expenseDate = expenseDate, category = category, description = description),
            )
        }.data
        var receiptSaved = true
        if (receipt != null) {
            receiptSaved = try {
                val body = receipt.bytes.toRequestBody(receipt.mimeType.toMediaTypeOrNull())
                apiCall { raw.uploadReceipt(created.id, MultipartBody.Part.createFormData("file", receipt.name, body)) }
                true
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                false
            }
        }
        invalidate()
        return receiptSaved
    }

    suspend fun cancelDeclaration(id: String) {
        apiCall { api.cancelMyDeclaration(id) }
        invalidate()
    }

    /** Whether that completed the task's checklist. */
    suspend fun completeTask(id: String, done: Boolean): Boolean {
        val result = apiCall { api.completeMyTask(id, undo = if (done) null else "true") }.data
        invalidate()
        return result.checklistCompleted
    }

    suspend fun acknowledge(coaching: Boolean, id: String, comment: String?) {
        if (coaching) {
            apiCall { api.acknowledgeCoaching(id, AcknowledgeInput(comment = comment)) }
        } else {
            apiCall { api.acknowledgeEvaluation(id, AcknowledgeInput(comment = comment)) }
        }
        invalidate()
    }

    suspend fun reviewLeave(id: String, approve: Boolean, note: String?) {
        apiCall { api.reviewLeaveRequest(id, ReviewInput(decision = if (approve) "approved" else "rejected", note = note)) }
        invalidate()
    }

    suspend fun reviewExpense(id: String, approve: Boolean, note: String?) {
        apiCall { api.reviewDeclaration(id, ReviewInput(decision = if (approve) "approved" else "rejected", note = note)) }
        invalidate()
    }

    suspend fun createAnnouncement(title: String, body: String, pinned: Boolean, notify: Boolean) {
        apiCall { api.createAnnouncement(AnnouncementInput(title = title, body = body, pinned = pinned, notify = notify)) }
        invalidate()
    }

    /**
     * Download a file the server only gives the signed-in employee (a receipt,
     * a payslip) into the app's cache, for the phone's viewer. The folder is
     * the OS's to clear.
     */
    suspend fun download(path: String, fileName: String, cacheDir: File): File {
        val response = raw.download(path)
        val body = response.body()
        if (!response.isSuccessful || body == null) {
            response.errorBody()?.close()
            throw ApiException(response.code(), null, null)
        }
        return withContext(Dispatchers.IO) {
            val folder = File(cacheDir, CACHE_FOLDER).apply { mkdirs() }
            val file = File(folder, safeFileName(fileName))
            body.use { input -> file.outputStream().use { input.byteStream().copyTo(it) } }
            file
        }
    }

    // Reads ------------------------------------------------------------------

    private suspend fun loadAccess(): HrAccess {
        val body = apiCall { raw.permissions() }.data
        return HrAccess.resolve(body.permissions, body.denies)
    }

    private suspend fun mapMe(): Me {
        val data = apiCall { api.getMe() }.data
        val features = data.features
        return Me(
            employee = data.employee?.let(::profile),
            features = Features(features.selfClockIn, features.clockInRequiresLocation, features.leaveRequests, features.declarations),
        )
    }

    private suspend fun mapOverview(): Overview {
        val data = apiCall { api.getMyOverview() }.data
        return Overview(
            clockedIn = data.clock.clockedIn,
            since = data.clock.since,
            clockShiftId = data.clock.shiftId,
            upcomingShifts = data.upcomingShifts.map { UpcomingShift(it.id, it.startsAt, it.endsAt, it.companyName) },
            openTasks = data.openTasks,
            toAcknowledge = data.toAcknowledge.coaching + data.toAcknowledge.evaluations,
            openShifts = data.openShifts,
            unreadAnnouncements = data.unreadAnnouncements,
        )
    }

    private suspend fun mapAttendance(from: String, to: String): Attendance {
        val data = apiCall { api.getMyAttendance(from = from, to = to) }.data
        return Attendance(data.records.map(::record), data.shifts.map(::shift), data.requests.map(::shiftRequest))
    }

    private suspend fun mapLeave(): Leave {
        val data = apiCall { api.getMyLeave() }.data
        return Leave(
            types = data.types.map { LeaveType(it.id, it.name, it.color, it.requiresApproval) },
            balances = data.balances.map {
                LeaveBalance(it.leaveTypeId, it.name, it.color, it.isPaid, it.overAllowance, it.allowance, it.prorated, it.used, it.pending, it.remaining)
            },
            requests = data.requests.map(::leaveRequest),
        )
    }

    private suspend fun mapAbsences(): Absences {
        val data = apiCall { api.getMyAbsences() }.data
        return Absences(data.current?.let(::absence), data.history.map(::absence))
    }

    private suspend fun mapDeclarations(): Declarations {
        val data = apiCall { api.getMyDeclarations() }.data
        return Declarations(
            declarations = data.declarations.map {
                Declaration(
                    id = it.id,
                    expenseDate = it.expenseDate,
                    category = it.category,
                    description = it.description,
                    amount = it.amount,
                    currency = it.currency,
                    status = it.status,
                    hasReceipt = it.hasReceipt,
                    receiptFileName = it.receiptFileName,
                    reviewNote = it.reviewNote,
                    reviewedAt = it.reviewedAt,
                    paidAt = it.paidAt,
                    createdAt = it.createdAt,
                )
            },
            open = data.open.map { OpenAmount(it.currency, it.pending, it.approved) },
        )
    }

    private suspend fun mapAnnouncements(): Announcements {
        val data = apiCall { api.listMyAnnouncements() }.data
        return Announcements(
            announcements = data.announcements.map { Announcement(it.id, it.title, it.body, it.pinned, it.publishedAt, it.createdByName, it.readAt) },
            unread = data.unread,
        )
    }

    private suspend fun mapEmployee(id: String): ColleagueDetail {
        val it = apiCall { api.getEmployee(id) }.data
        return ColleagueDetail(
            id = it.id,
            displayName = it.displayName,
            email = it.email,
            phone = it.phone,
            avatarUrl = it.avatarUrl,
            pronouns = it.pronouns,
            jobTitle = it.jobTitle,
            departmentName = it.departmentName,
            managerName = it.managerName,
            status = it.status,
            startDate = it.startDate,
            location = it.location,
            directReports = it.directReports.map { report -> Colleague(report.id, report.displayName, null, report.avatarUrl, report.jobTitle, null) },
        )
    }

    private fun profile(it: ApiProfile) = Profile(
        id = it.id,
        displayName = it.displayName,
        email = it.email,
        phone = it.phone,
        avatarUrl = it.avatarUrl,
        jobTitle = it.jobTitle,
        employeeNumber = it.employeeNumber,
        status = it.status,
        startDate = it.startDate,
        location = it.location,
        departmentName = it.departmentName,
        managerName = it.manager?.displayName,
    )

    private fun record(it: MyAttendanceRecord) = ClockRecord(
        id = it.id,
        date = it.date,
        clockIn = it.clockIn,
        clockOut = it.clockOut,
        breakMinutes = it.breakMinutes,
        workedMinutes = it.workedMinutes,
        lateMinutes = it.lateMinutes,
        status = it.status,
        source = it.source,
        approved = it.approved,
        companyName = it.companyName,
        shiftId = it.shiftId,
        notes = it.notes,
        hourlyRate = it.hourlyRate,
        currency = it.currency,
    )

    private fun shift(it: MyShift) = Shift(
        id = it.id,
        startsAt = it.startsAt,
        endsAt = it.endsAt,
        workType = it.workType,
        breakStartsAt = it.breakStartsAt,
        breakEndsAt = it.breakEndsAt,
        companyName = it.companyName,
        notes = it.notes,
        hourlyRate = it.hourlyRate,
        currency = it.currency,
    )

    private fun shiftRequest(it: MyShiftRequest) = ShiftRequest(
        id = it.id,
        openShiftId = it.openShiftId,
        startsAt = it.startsAt,
        endsAt = it.endsAt,
        workType = it.workType,
        note = it.note,
        status = it.status,
        reviewedAt = it.reviewedAt,
        reviewedByName = it.reviewedByName,
        reviewNote = it.reviewNote,
        createdAt = it.createdAt,
    )

    private fun leaveRequest(it: MyLeaveRequest) = LeaveRequest(
        id = it.id,
        leaveTypeId = it.leaveTypeId,
        leaveTypeName = it.leaveTypeName,
        leaveTypeColor = it.leaveTypeColor,
        startDate = it.startDate,
        endDate = it.endDate,
        days = it.days,
        reason = it.reason,
        status = it.status,
        reviewNote = it.reviewNote,
        reviewedAt = it.reviewedAt,
        reviewedByName = it.reviewedByName,
        createdAt = it.createdAt,
    )

    private fun absence(it: MyAbsence) =
        Absence(it.id, it.startDate, it.endDate, it.firstDay, it.note, it.status, it.days, it.createdAt)

    private fun openShift(it: org.weldsuite.api.weldhr.models.MyOpenShift) = OpenShift(
        id = it.id,
        startsAt = it.startsAt,
        endsAt = it.endsAt,
        workType = it.workType,
        breakStartsAt = it.breakStartsAt,
        breakEndsAt = it.breakEndsAt,
        notes = it.notes,
        companyName = it.companyName,
        departmentName = it.departmentName,
        spots = it.spots,
        spotsLeft = it.spotsLeft,
        myRequest = it.myRequest?.let { request -> OpenShiftRequest(request.id, request.status, request.reviewNote) },
    )

    private fun task(it: org.weldsuite.api.weldhr.models.MyTask) =
        HrTask(it.id, it.title, it.description, it.dueDate, it.assigneeRole, it.completedAt, it.canComplete, it.checklistName)

    private fun coachingLog(it: org.weldsuite.api.weldhr.models.MyCoachingLog) = CoachingLog(
        id = it.id,
        sessionDate = it.sessionDate,
        category = it.category,
        topic = it.topic,
        notes = it.notes,
        actionItems = it.actionItems.map { item -> ActionItem(item.id, item.text, item.done) },
        followUpDate = it.followUpDate,
        coachName = it.coachName,
        acknowledgedAt = it.acknowledgedAt,
        employeeComment = it.employeeComment,
    )

    private fun evaluation(it: org.weldsuite.api.weldhr.models.MyEvaluation) = Evaluation(
        id = it.id,
        formName = it.formName,
        periodStart = it.periodStart,
        periodEnd = it.periodEnd,
        criteria = it.criteria.map { c -> Criterion(c.id, c.label, c.maxScore) },
        scores = it.scores.map { s -> Score(s.criterionId, s.score) },
        overallScore = it.overallScore,
        summary = it.summary,
        evaluatorName = it.evaluatorName,
        acknowledgedAt = it.acknowledgedAt,
        employeeComment = it.employeeComment,
    )

    private fun payslip(it: org.weldsuite.api.weldhr.models.Payslip) = Payslip(
        id = it.id,
        number = it.number,
        employerName = it.employerName,
        currency = it.currency,
        periodStart = it.periodStart,
        periodEnd = it.periodEnd,
        payDate = it.payDate,
        grossPay = it.grossPay,
        netPay = it.netPay,
        viewedAt = it.viewedAt,
    )

    private fun teamLeave(it: org.weldsuite.api.weldhr.models.LeaveRequest) = LeaveRequest(
        id = it.id,
        leaveTypeId = it.leaveTypeId,
        leaveTypeName = it.leaveTypeName,
        leaveTypeColor = it.leaveTypeColor,
        startDate = it.startDate,
        endDate = it.endDate,
        days = it.days,
        reason = it.reason,
        status = it.status,
        employeeId = it.employeeId,
        employeeName = it.employeeName,
    )

    private fun teamDeclaration(it: org.weldsuite.api.weldhr.models.TeamDeclaration) = Declaration(
        id = it.id,
        expenseDate = it.expenseDate,
        category = it.category,
        description = it.description,
        amount = it.amount,
        currency = it.currency,
        status = it.status,
        hasReceipt = it.hasReceipt,
        employeeId = it.employeeId,
        employeeName = it.employeeName,
    )

    private fun teamAbsence(it: org.weldsuite.api.weldhr.models.TeamAbsence) = Absence(
        id = it.id,
        startDate = it.startDate,
        endDate = it.endDate,
        firstDay = it.firstDay,
        note = null,
        status = it.status,
        days = it.days,
        employeeId = it.employeeId,
        employeeName = it.employeeName,
    )

    private fun teamShift(it: org.weldsuite.api.weldhr.models.TeamShift) = Shift(
        id = it.id,
        startsAt = it.startsAt,
        endsAt = it.endsAt,
        workType = it.workType,
        breakStartsAt = it.breakStartsAt,
        breakEndsAt = it.breakEndsAt,
        companyName = it.companyName,
        notes = null,
        hourlyRate = null,
        currency = null,
        employeeId = it.employeeId,
        employeeName = it.employeeName,
    )

    private fun teamRecord(it: org.weldsuite.api.weldhr.models.TeamAttendanceRecord) = ClockRecord(
        id = it.id,
        date = it.date,
        clockIn = it.clockIn,
        clockOut = it.clockOut,
        breakMinutes = null,
        workedMinutes = it.workedMinutes,
        lateMinutes = null,
        status = it.status,
        source = "",
        approved = false,
        companyName = it.companyName,
        shiftId = it.shiftId,
        notes = null,
        hourlyRate = null,
        currency = null,
        employeeId = it.employeeId,
        employeeName = it.employeeName,
    )

    companion object {
        /** Everyone still on the books: the directory leaves out terminated employees. */
        const val CURRENT_STATUSES = "onboarding,active,on_leave,offboarding"
        private const val CACHE_FOLDER = "weldhr-documents"

        /** A file name that is safe on disk: no separators, control characters or leading dots. */
        fun safeFileName(name: String): String {
            val cleaned = name.replace(Regex("[\\u0000-\\u001f\\u007f/\\\\:*?\"<>|]"), "_").trimStart('.').trim().take(120)
            return cleaned.ifEmpty { "document.pdf" }
        }
    }
}

/** A photo or PDF picked for a receipt, read into memory (at most 10 MB). */
class PickedFile(val name: String, val mimeType: String, val bytes: ByteArray) {
    override fun equals(other: Any?): Boolean = other is PickedFile && other.name == name && other.bytes.contentEquals(bytes)

    override fun hashCode(): Int = name.hashCode()
}
