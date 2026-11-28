import Foundation
import Observation
import WeldCore
import WeldHRAPI

/// A failed write: the API error, and the server's own message when it sent one.
struct HRFailure: Error, Equatable {
    let api: APIError
    let message: String?

    /// What to tell the person: the server's message for a refusal it explained, else the generic words.
    var text: String {
        if let message, !message.isEmpty, api.code != nil, !api.isNetwork { return message }
        return apiErrorMessage(api)
    }

    static func from(_ error: Error) -> HRFailure {
        if let failure = error as? HRFailure { return failure }
        return HRFailure(api: APIError.from(error), message: nil)
    }
}

/// Payslips: a list, or payroll is off for the workspace (the server's 404).
enum HRPayroll: Equatable {
    case off
    case on([HRPayslip])

    var isOn: Bool {
        if case .on = self { return true }
        return false
    }
}

/// What the store loads; a write reloads every one that was shown, as the
/// Expo app invalidates its `weldhr` key root and a realtime `hr_*` event does.
enum HRQuery: Hashable {
    case access, me, overview, leave, absences, declarations, announcements, openShifts, tasks, coaching, evaluations
    case payslips, statements, pendingLeave, pendingExpenses, sickReports
    case week(String, String)
    case teamLeave(String, String)
    case teamShifts(String, String)
    case teamAttendance(String, String)
    case employees(String)
    case employee(String)
}

/// WeldHR's reads and writes for the active workspace. The generated API types
/// are mapped to the app's own (HRModels.swift) here and nowhere else.
@MainActor
@Observable
final class HRStore {
    var access = LoadState<HRAccess>()
    var me = LoadState<HRMe>()
    var overview = LoadState<HROverview>()
    var leave = LoadState<HRLeave>()
    var absences = LoadState<HRAbsences>()
    var declarations = LoadState<HRDeclarations>()
    var announcements = LoadState<HRAnnouncements>()
    var openShifts = LoadState<[HROpenShift]>()
    var tasks = LoadState<[HRTask]>()
    var coaching = LoadState<[HRCoachingLog]>()
    var evaluations = LoadState<[HREvaluation]>()
    var payslips = LoadState<HRPayroll>()
    var statements = LoadState<[HRAnnualStatement]>()
    var pendingLeave = LoadState<[HRLeaveRequest]>()
    var pendingExpenses = LoadState<[HRDeclaration]>()
    var sickReports = LoadState<[HRAbsence]>()
    var weeks: [String: LoadState<HRAttendance>] = [:]
    var teamLeaves: [String: LoadState<[HRLeaveRequest]>] = [:]
    var teamShiftWeeks: [String: LoadState<[HRShift]>] = [:]
    var teamAttendanceWeeks: [String: LoadState<[HRClockRecord]>] = [:]
    var directories: [String: LoadState<[HRColleague]>] = [:]
    var colleagues: [String: LoadState<HRColleagueDetail>] = [:]

    @ObservationIgnored let env: AppEnvironment
    @ObservationIgnored private var workspace: String?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var used: Set<HRQuery> = []

    init(env: AppEnvironment) {
        self.env = env
    }

    private func client() throws -> Client {
        guard let api = env.api else { throw HRFailure(api: APIError(status: nil, code: nil), message: nil) }
        return Client(serverURL: api.serverURL, transport: api.transport, middlewares: api.middlewares)
    }

    private var raw: HRRaw { HRRaw(env: env) }

    static func key(_ from: String, _ to: String) -> String { "\(from)|\(to)" }

    func week(_ from: String, _ to: String) -> LoadState<HRAttendance> { weeks[Self.key(from, to)] ?? LoadState() }
    func teamLeave(_ from: String, _ to: String) -> LoadState<[HRLeaveRequest]> { teamLeaves[Self.key(from, to)] ?? LoadState() }
    func teamShifts(_ from: String, _ to: String) -> LoadState<[HRShift]> { teamShiftWeeks[Self.key(from, to)] ?? LoadState() }
    func teamAttendance(_ from: String, _ to: String) -> LoadState<[HRClockRecord]> { teamAttendanceWeeks[Self.key(from, to)] ?? LoadState() }
    func directory(_ search: String) -> LoadState<[HRColleague]> { directories[search] ?? LoadState() }
    func colleague(_ id: String) -> LoadState<HRColleagueDetail> { colleagues[id] ?? LoadState() }

    /// Forget another workspace's data the moment the workspace changes.
    func use(workspace id: String) {
        guard workspace != id else { return }
        workspace = id
        generation += 1
        used = []
        access = LoadState()
        me = LoadState()
        overview = LoadState()
        leave = LoadState()
        absences = LoadState()
        declarations = LoadState()
        announcements = LoadState()
        openShifts = LoadState()
        tasks = LoadState()
        coaching = LoadState()
        evaluations = LoadState()
        payslips = LoadState()
        statements = LoadState()
        pendingLeave = LoadState()
        pendingExpenses = LoadState()
        sickReports = LoadState()
        weeks = [:]
        teamLeaves = [:]
        teamShiftWeeks = [:]
        teamAttendanceWeeks = [:]
        directories = [:]
        colleagues = [:]
    }

    /// Load unless there is data already (a screen opening).
    func ensure(_ query: HRQuery) async {
        if hasData(query) {
            used.insert(query)
            return
        }
        await load(query)
    }

    /// Reload everything that was shown: after a write, a realtime event or a pull to refresh.
    func invalidate() async {
        await withTaskGroup(of: Void.self) { group in
            for query in used {
                group.addTask { await self.load(query) }
            }
        }
    }

    private func hasData(_ query: HRQuery) -> Bool {
        switch query {
        case .access: access.data != nil
        case .me: me.data != nil
        case .overview: overview.data != nil
        case .leave: leave.data != nil
        case .absences: absences.data != nil
        case .declarations: declarations.data != nil
        case .announcements: announcements.data != nil
        case .openShifts: openShifts.data != nil
        case .tasks: tasks.data != nil
        case .coaching: coaching.data != nil
        case .evaluations: evaluations.data != nil
        case .payslips: payslips.data != nil
        case .statements: statements.data != nil
        case .pendingLeave: pendingLeave.data != nil
        case .pendingExpenses: pendingExpenses.data != nil
        case .sickReports: sickReports.data != nil
        case let .week(from, to): week(from, to).data != nil
        case let .teamLeave(from, to): teamLeave(from, to).data != nil
        case let .teamShifts(from, to): teamShifts(from, to).data != nil
        case let .teamAttendance(from, to): teamAttendance(from, to).data != nil
        case let .employees(search): directory(search).data != nil
        case let .employee(id): colleague(id).data != nil
        }
    }

    /// Load one query, keeping the last data next to an error.
    func load(_ query: HRQuery) async {
        used.insert(query)
        let forGeneration = generation
        func run<T>(_ get: () -> LoadState<T>, _ set: (LoadState<T>) -> Void, _ fetch: () async throws -> T) async {
            var state = get()
            state.loading = true
            set(state)
            do {
                let value = try await fetch()
                guard forGeneration == generation else { return }
                set(LoadState(data: value))
            } catch {
                guard forGeneration == generation else { return }
                set(LoadState(data: get().data, error: HRFailure.from(error).api))
            }
        }
        switch query {
        case .access: await run({ access }, { access = $0 }, loadAccess)
        case .me: await run({ me }, { me = $0 }, loadMe)
        case .overview: await run({ overview }, { overview = $0 }, loadOverview)
        case .leave: await run({ leave }, { leave = $0 }, loadLeave)
        case .absences: await run({ absences }, { absences = $0 }, loadAbsences)
        case .declarations: await run({ declarations }, { declarations = $0 }, loadDeclarations)
        case .announcements: await run({ announcements }, { announcements = $0 }, loadAnnouncements)
        case .openShifts: await run({ openShifts }, { openShifts = $0 }, loadOpenShifts)
        case .tasks: await run({ tasks }, { tasks = $0 }, loadTasks)
        case .coaching: await run({ coaching }, { coaching = $0 }, loadCoaching)
        case .evaluations: await run({ evaluations }, { evaluations = $0 }, loadEvaluations)
        case .payslips: await run({ payslips }, { payslips = $0 }, loadPayslips)
        case .statements: await run({ statements }, { statements = $0 }, loadStatements)
        case .pendingLeave: await run({ pendingLeave }, { pendingLeave = $0 }) { try await self.loadTeamLeave(status: "pending", from: nil, to: nil) }
        case .pendingExpenses: await run({ pendingExpenses }, { pendingExpenses = $0 }, loadPendingExpenses)
        case .sickReports: await run({ sickReports }, { sickReports = $0 }, loadSickReports)
        case let .week(from, to):
            let key = Self.key(from, to)
            await run({ weeks[key] ?? LoadState() }, { weeks[key] = $0 }) { try await self.loadWeek(from: from, to: to) }
        case let .teamLeave(from, to):
            let key = Self.key(from, to)
            await run({ teamLeaves[key] ?? LoadState() }, { teamLeaves[key] = $0 }) { try await self.loadTeamLeave(status: "approved", from: from, to: to) }
        case let .teamShifts(from, to):
            let key = Self.key(from, to)
            await run({ teamShiftWeeks[key] ?? LoadState() }, { teamShiftWeeks[key] = $0 }) { try await self.loadTeamShifts(from: from, to: to) }
        case let .teamAttendance(from, to):
            let key = Self.key(from, to)
            await run({ teamAttendanceWeeks[key] ?? LoadState() }, { teamAttendanceWeeks[key] = $0 }) { try await self.loadTeamAttendance(from: from, to: to) }
        case let .employees(search):
            await run({ directories[search] ?? LoadState() }, { directories[search] = $0 }) { try await self.loadEmployees(search: search) }
        case let .employee(id):
            await run({ colleagues[id] ?? LoadState() }, { colleagues[id] = $0 }) { try await self.loadEmployee(id: id) }
        }
    }

    // MARK: - Writes

    /// Runs a write and reloads what was shown; a failure says why.
    private func write<T>(_ call: () async throws -> T) async throws -> T {
        do {
            let value = try await call()
            await invalidate()
            return value
        } catch {
            throw HRFailure.from(error)
        }
    }

    /// A failed call, from its status and the `{ error }` body when it decodes.
    private static func failure(_ status: Int, _ body: Components.Schemas.ErrorBody?) -> HRFailure {
        return HRFailure(api: APIError(status: status, code: body?.code), message: body?.message)
    }

    func clock(action: String, shiftId: String? = nil, fix: HRGeoFix? = nil) async throws {
        let location = fix.map { Components.Schemas.ClockLocation(latitude: $0.latitude, longitude: $0.longitude, accuracy: $0.accuracy) }
        try await write {
            switch try await client().clockMe(body: .json(.init(action: action, shiftId: shiftId, location: location))) {
            case .ok: return
            case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
            }
        }
    }

    /// The new request's status: `approved` for a type that needs no approval.
    func requestLeave(typeId: String, startDate: String, endDate: String, reason: String?) async throws -> String {
        try await write {
            switch try await client().requestLeave(body: .json(.init(leaveTypeId: typeId, startDate: startDate, endDate: endDate, reason: reason))) {
            case let .created(created): return try created.body.json.data.status
            case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
            }
        }
    }

    func cancelLeave(id: String) async throws {
        try await write {
            switch try await client().cancelMyLeave(path: .init(id: id)) {
            case .ok: return
            case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
            }
        }
    }

    func requestShift(startsAt: String, endsAt: String, workType: String?, note: String?) async throws {
        try await write {
            switch try await client().requestShift(body: .json(.init(startsAt: startsAt, endsAt: endsAt, workType: workType, note: note))) {
            case .created: return
            case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
            }
        }
    }

    func cancelShiftRequest(id: String) async throws {
        try await write {
            switch try await client().cancelMyShiftRequest(path: .init(id: id)) {
            case .ok: return
            case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
            }
        }
    }

    func signUp(openShiftId: String, note: String?) async throws {
        try await write {
            switch try await client().signUpForOpenShift(path: .init(id: openShiftId), body: .json(.init(note: note))) {
            case .created: return
            case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
            }
        }
    }

    func markRead(id: String) async throws {
        try await write {
            switch try await client().markAnnouncementRead(path: .init(id: id)) {
            case .ok: return
            case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
            }
        }
    }

    func reportSick(startDate: String, firstDay: String, note: String?) async throws {
        try await write {
            switch try await client().reportSick(body: .json(.init(startDate: startDate, firstDay: firstDay, note: note))) {
            case .created: return
            case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
            }
        }
    }

    func reportRecovered(id: String, endDate: String) async throws {
        try await write {
            switch try await client().reportRecovered(path: .init(id: id), body: .json(.init(endDate: endDate))) {
            case .ok: return
            case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
            }
        }
    }

    /// File a claim, then attach the receipt. When only the upload fails the
    /// claim still stands, so this says so (`false`) rather than throw.
    func createDeclaration(amount: Double, currency: String, expenseDate: String, category: String, description: String, receipt: HRPickedFile?) async throws -> Bool {
        try await write {
            let input = Components.Schemas.DeclarationInput(amount: amount, currency: currency, expenseDate: expenseDate, category: category, description: description)
            let id: String
            switch try await client().createDeclaration(body: .json(input)) {
            case let .created(created): id = try created.body.json.data.id
            case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
            }
            guard let receipt else { return true }
            do {
                try await raw.uploadReceipt(declarationID: id, file: receipt)
                return true
            } catch {
                return false
            }
        }
    }

    func cancelDeclaration(id: String) async throws {
        try await write {
            switch try await client().cancelMyDeclaration(path: .init(id: id)) {
            case .ok: return
            case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
            }
        }
    }

    /// Whether that completed the task's checklist.
    func completeTask(id: String, done: Bool) async throws -> Bool {
        try await write {
            switch try await client().completeMyTask(path: .init(id: id), query: .init(undo: done ? nil : "true")) {
            case let .ok(ok): return try ok.body.json.data.checklistCompleted
            case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
            }
        }
    }

    func acknowledge(coaching: Bool, id: String, comment: String?) async throws {
        try await write {
            if coaching {
                switch try await client().acknowledgeCoaching(path: .init(id: id), body: .json(.init(comment: comment))) {
                case .ok: return
                case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
                }
            } else {
                switch try await client().acknowledgeEvaluation(path: .init(id: id), body: .json(.init(comment: comment))) {
                case .ok: return
                case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
                }
            }
        }
    }

    func reviewLeave(id: String, approve: Bool, note: String?) async throws {
        try await write {
            switch try await client().reviewLeaveRequest(path: .init(id: id), body: .json(.init(decision: approve ? "approved" : "rejected", note: note))) {
            case .ok: return
            case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
            }
        }
    }

    func reviewExpense(id: String, approve: Bool, note: String?) async throws {
        try await write {
            switch try await client().reviewDeclaration(path: .init(id: id), body: .json(.init(decision: approve ? "approved" : "rejected", note: note))) {
            case .ok: return
            case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
            }
        }
    }

    func createAnnouncement(title: String, body: String, pinned: Bool, notify: Bool) async throws {
        try await write {
            switch try await client().createAnnouncement(body: .json(.init(title: title, body: body, pinned: pinned, notify: notify))) {
            case .created: return
            case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
            }
        }
    }

    /// A file the server only gives the signed-in employee (a receipt, a payslip), in the app's caches.
    func download(path: String, fileName: String) async throws -> URL {
        do {
            return try await raw.download(path: path, fileName: fileName)
        } catch {
            throw HRFailure.from(error)
        }
    }

    // MARK: - Reads

    private func loadAccess() async throws -> HRAccess {
        let body = try await raw.permissions()
        return HRAccess.resolve(permissions: body.permissions ?? [], denies: body.denies ?? [])
    }

    private func loadMe() async throws -> HRMe {
        switch try await client().getMe() {
        case let .ok(ok):
            let data = try ok.body.json.data
            let features = data.features
            return HRMe(
                employee: data.employee.map { Self.profile($0.value1) },
                features: HRFeatures(
                    selfClockIn: features.selfClockIn,
                    clockInRequiresLocation: features.clockInRequiresLocation,
                    leaveRequests: features.leaveRequests,
                    declarations: features.declarations
                )
            )
        case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
        }
    }

    private func loadOverview() async throws -> HROverview {
        switch try await client().getMyOverview() {
        case let .ok(ok):
            let data = try ok.body.json.data
            return HROverview(
                clockedIn: data.clock.clockedIn,
                since: data.clock.since,
                clockShiftId: data.clock.shiftId,
                upcomingShifts: data.upcomingShifts.map { HRUpcomingShift(id: $0.id, startsAt: $0.startsAt, endsAt: $0.endsAt, companyName: $0.companyName) },
                openTasks: data.openTasks,
                toAcknowledge: data.toAcknowledge.coaching + data.toAcknowledge.evaluations,
                openShifts: data.openShifts,
                unreadAnnouncements: data.unreadAnnouncements,
                latestEvaluation: data.latestEvaluation.map {
                    HREvaluationSummary(overallScore: $0.value1.overallScore, formName: $0.value1.formName, submittedAt: $0.value1.submittedAt)
                },
                milestones: data.milestones.map { HRMilestoneCount(achieved: $0.achieved, open: $0.open) }
            )
        case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
        }
    }

    private func loadWeek(from: String, to: String) async throws -> HRAttendance {
        switch try await client().getMyAttendance(query: .init(from: from, to: to)) {
        case let .ok(ok):
            let data = try ok.body.json.data
            return HRAttendance(
                records: data.records.map { record in
                    HRClockRecord(
                        id: record.id,
                        date: record.date,
                        clockIn: record.clockIn,
                        clockOut: record.clockOut,
                        breakMinutes: record.breakMinutes,
                        workedMinutes: record.workedMinutes,
                        lateMinutes: record.lateMinutes,
                        status: record.status,
                        source: record.source,
                        approved: record.approved,
                        companyName: record.companyName,
                        shiftId: record.shiftId,
                        notes: record.notes,
                        hourlyRate: record.hourlyRate,
                        currency: record.currency
                    )
                },
                shifts: data.shifts.map { shift in
                    HRShift(
                        id: shift.id,
                        startsAt: shift.startsAt,
                        endsAt: shift.endsAt,
                        workType: shift.workType,
                        breakStartsAt: shift.breakStartsAt,
                        breakEndsAt: shift.breakEndsAt,
                        companyName: shift.companyName,
                        notes: shift.notes,
                        hourlyRate: shift.hourlyRate,
                        currency: shift.currency
                    )
                },
                requests: data.requests.map { request in
                    HRShiftRequest(
                        id: request.id,
                        openShiftId: request.openShiftId,
                        startsAt: request.startsAt,
                        endsAt: request.endsAt,
                        workType: request.workType,
                        note: request.note,
                        status: request.status,
                        reviewedAt: request.reviewedAt,
                        reviewedByName: request.reviewedByName,
                        reviewNote: request.reviewNote,
                        createdAt: request.createdAt
                    )
                }
            )
        case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
        }
    }

    private func loadLeave() async throws -> HRLeave {
        switch try await client().getMyLeave() {
        case let .ok(ok):
            let data = try ok.body.json.data
            return HRLeave(
                types: data.types.map { HRLeaveType(id: $0.id, name: $0.name, color: $0.color, requiresApproval: $0.requiresApproval) },
                balances: data.balances.map { balance in
                    HRLeaveBalance(
                        leaveTypeId: balance.leaveTypeId,
                        name: balance.name,
                        color: balance.color,
                        isPaid: balance.isPaid,
                        overAllowance: balance.overAllowance,
                        allowance: balance.allowance,
                        prorated: balance.prorated,
                        used: balance.used,
                        pending: balance.pending,
                        remaining: balance.remaining
                    )
                },
                requests: data.requests.map { request in
                    HRLeaveRequest(
                        id: request.id,
                        leaveTypeId: request.leaveTypeId,
                        leaveTypeName: request.leaveTypeName,
                        leaveTypeColor: request.leaveTypeColor,
                        startDate: request.startDate,
                        endDate: request.endDate,
                        days: request.days,
                        reason: request.reason,
                        status: request.status,
                        reviewNote: request.reviewNote,
                        reviewedAt: request.reviewedAt,
                        reviewedByName: request.reviewedByName,
                        createdAt: request.createdAt
                    )
                }
            )
        case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
        }
    }

    private func loadAbsences() async throws -> HRAbsences {
        switch try await client().getMyAbsences() {
        case let .ok(ok):
            let data = try ok.body.json.data
            return HRAbsences(current: data.current.map { Self.absence($0.value1) }, history: data.history.map(Self.absence))
        case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
        }
    }

    private func loadDeclarations() async throws -> HRDeclarations {
        switch try await client().getMyDeclarations() {
        case let .ok(ok):
            let rows = try ok.body.json.data.declarations.map { row in
                HRDeclaration(
                    id: row.id,
                    expenseDate: row.expenseDate,
                    category: row.category,
                    description: row.description,
                    amount: row.amount,
                    currency: row.currency,
                    status: row.status,
                    hasReceipt: row.hasReceipt,
                    receiptFileName: row.receiptFileName,
                    reviewNote: row.reviewNote,
                    reviewedAt: row.reviewedAt,
                    paidAt: row.paidAt,
                    createdAt: row.createdAt
                )
            }
            // The server's open totals, worked out the same way from the rows (HRLogic.openAmounts).
            return HRDeclarations(declarations: rows, open: openAmounts(rows))
        case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
        }
    }

    private func loadAnnouncements() async throws -> HRAnnouncements {
        switch try await client().listMyAnnouncements() {
        case let .ok(ok):
            let data = try ok.body.json.data
            return HRAnnouncements(
                announcements: data.announcements.map {
                    HRAnnouncement(id: $0.id, title: $0.title, body: $0.body, pinned: $0.pinned, publishedAt: $0.publishedAt, createdByName: $0.createdByName, readAt: $0.readAt)
                },
                unread: data.unread
            )
        case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
        }
    }

    private func loadOpenShifts() async throws -> [HROpenShift] {
        switch try await client().listMyOpenShifts() {
        case let .ok(ok):
            return try ok.body.json.data.map { shift in
                HROpenShift(
                    id: shift.id,
                    startsAt: shift.startsAt,
                    endsAt: shift.endsAt,
                    workType: shift.workType,
                    breakStartsAt: shift.breakStartsAt,
                    breakEndsAt: shift.breakEndsAt,
                    notes: shift.notes,
                    companyName: shift.companyName,
                    departmentName: shift.departmentName,
                    spots: shift.spots,
                    spotsLeft: shift.spotsLeft,
                    myRequest: shift.myRequest.map { HROpenShiftRequest(id: $0.value1.id, status: $0.value1.status, reviewNote: $0.value1.reviewNote) }
                )
            }
        case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
        }
    }

    private func loadTasks() async throws -> [HRTask] {
        switch try await client().listMyTasks() {
        case let .ok(ok):
            return try ok.body.json.data.map {
                HRTask(id: $0.id, title: $0.title, description: $0.description, dueDate: $0.dueDate, assigneeRole: $0.assigneeRole, completedAt: $0.completedAt, canComplete: $0.canComplete, checklistName: $0.checklistName)
            }
        case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
        }
    }

    private func loadCoaching() async throws -> [HRCoachingLog] {
        switch try await client().listMyCoaching() {
        case let .ok(ok):
            return try ok.body.json.data.map { log in
                HRCoachingLog(
                    id: log.id,
                    sessionDate: log.sessionDate,
                    category: log.category,
                    topic: log.topic,
                    notes: log.notes,
                    actionItems: log.actionItems.map { HRActionItem(id: $0.id, text: $0.text, done: $0.done) },
                    followUpDate: log.followUpDate,
                    coachName: log.coachName,
                    acknowledgedAt: log.acknowledgedAt,
                    employeeComment: log.employeeComment
                )
            }
        case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
        }
    }

    private func loadEvaluations() async throws -> [HREvaluation] {
        switch try await client().listMyEvaluations() {
        case let .ok(ok):
            return try ok.body.json.data.map { row in
                HREvaluation(
                    id: row.id,
                    formName: row.formName,
                    periodStart: row.periodStart,
                    periodEnd: row.periodEnd,
                    criteria: row.criteria.map { HRCriterion(id: $0.id, label: $0.label, maxScore: $0.maxScore) },
                    scores: row.scores.map { HRScore(criterionId: $0.criterionId, score: $0.score) },
                    overallScore: row.overallScore,
                    summary: row.summary,
                    evaluatorName: row.evaluatorName,
                    acknowledgedAt: row.acknowledgedAt,
                    employeeComment: row.employeeComment
                )
            }
        case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
        }
    }

    private func loadPayslips() async throws -> HRPayroll {
        switch try await client().listMyPayslips() {
        case let .ok(ok):
            return try .on(ok.body.json.data.map { slip in
                HRPayslip(
                    id: slip.id,
                    number: slip.number,
                    employerName: slip.employerName,
                    currency: slip.currency,
                    periodStart: slip.periodStart,
                    periodEnd: slip.periodEnd,
                    payDate: slip.payDate,
                    grossPay: slip.grossPay,
                    netPay: slip.netPay,
                    viewedAt: slip.viewedAt
                )
            })
        case let .default(status, response):
            // 404 while the `weldhr-payroll` flag is off: the Pay screen says so instead of an error.
            if status == 404 { return .off }
            throw Self.failure(status, try? response.body.json.error)
        }
    }

    private func loadStatements() async throws -> [HRAnnualStatement] {
        switch try await client().listMyAnnualStatements() {
        case let .ok(ok):
            return try ok.body.json.data.map { HRAnnualStatement(year: $0.year, employerId: $0.employerId, employerName: $0.employerName, kind: $0.kind) }
        case let .default(status, response):
            if status == 404 { return [] }
            throw Self.failure(status, try? response.body.json.error)
        }
    }

    private func loadTeamLeave(status: String, from: String?, to: String?) async throws -> [HRLeaveRequest] {
        switch try await client().listLeaveRequests(query: .init(status: status, from: from, to: to)) {
        case let .ok(ok):
            return try ok.body.json.data.map { request in
                HRLeaveRequest(
                    id: request.id,
                    leaveTypeId: request.leaveTypeId,
                    leaveTypeName: request.leaveTypeName,
                    leaveTypeColor: request.leaveTypeColor,
                    startDate: request.startDate,
                    endDate: request.endDate,
                    days: request.days,
                    reason: request.reason,
                    status: request.status,
                    employeeId: request.employeeId,
                    employeeName: request.employeeName
                )
            }
        case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
        }
    }

    private func loadPendingExpenses() async throws -> [HRDeclaration] {
        switch try await client().listDeclarations(query: .init(status: "pending")) {
        case let .ok(ok):
            return try ok.body.json.data.map { row in
                HRDeclaration(
                    id: row.id,
                    expenseDate: row.expenseDate,
                    category: row.category,
                    description: row.description,
                    amount: row.amount,
                    currency: row.currency,
                    status: row.status,
                    hasReceipt: row.hasReceipt,
                    employeeId: row.employeeId,
                    employeeName: row.employeeName
                )
            }
        case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
        }
    }

    private func loadSickReports() async throws -> [HRAbsence] {
        switch try await client().listAbsences(query: .init(limit: 100)) {
        case let .ok(ok):
            return try ok.body.json.data.map { row in
                HRAbsence(
                    id: row.id,
                    startDate: row.startDate,
                    endDate: row.endDate,
                    firstDay: row.firstDay,
                    note: nil,
                    status: row.status,
                    days: row.days,
                    employeeId: row.employeeId,
                    employeeName: row.employeeName
                )
            }
        case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
        }
    }

    private func loadTeamShifts(from: String, to: String) async throws -> [HRShift] {
        switch try await client().listShifts(query: .init(from: from, to: to)) {
        case let .ok(ok):
            return try ok.body.json.data.map { shift in
                HRShift(
                    id: shift.id,
                    startsAt: shift.startsAt,
                    endsAt: shift.endsAt,
                    workType: shift.workType,
                    breakStartsAt: shift.breakStartsAt,
                    breakEndsAt: shift.breakEndsAt,
                    companyName: shift.companyName,
                    notes: nil,
                    hourlyRate: nil,
                    currency: nil,
                    employeeId: shift.employeeId,
                    employeeName: shift.employeeName
                )
            }
        case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
        }
    }

    private func loadTeamAttendance(from: String, to: String) async throws -> [HRClockRecord] {
        switch try await client().listAttendance(query: .init(from: from, to: to, limit: 200)) {
        case let .ok(ok):
            return try ok.body.json.data.map { record in
                HRClockRecord(
                    id: record.id,
                    date: record.date,
                    clockIn: record.clockIn,
                    clockOut: record.clockOut,
                    breakMinutes: nil,
                    workedMinutes: record.workedMinutes,
                    lateMinutes: nil,
                    status: record.status,
                    source: "",
                    approved: false,
                    companyName: record.companyName,
                    shiftId: record.shiftId,
                    notes: nil,
                    hourlyRate: nil,
                    currency: nil,
                    employeeId: record.employeeId,
                    employeeName: record.employeeName
                )
            }
        case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
        }
    }

    /// Everyone still on the books: the directory leaves out terminated employees.
    static let currentStatuses = "onboarding,active,on_leave,offboarding"

    private func loadEmployees(search: String) async throws -> [HRColleague] {
        let term = search.trimmingCharacters(in: .whitespaces)
        switch try await client().listEmployees(query: .init(search: term.isEmpty ? nil : term, status: Self.currentStatuses, limit: 100)) {
        case let .ok(ok):
            return try ok.body.json.data.map {
                HRColleague(id: $0.id, displayName: $0.displayName, email: $0.email, avatarUrl: $0.avatarUrl, jobTitle: $0.jobTitle, departmentName: $0.departmentName)
            }
        case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
        }
    }

    private func loadEmployee(id: String) async throws -> HRColleagueDetail {
        switch try await client().getEmployee(path: .init(id: id)) {
        case let .ok(ok):
            let data = try ok.body.json.data
            return HRColleagueDetail(
                id: data.id,
                displayName: data.displayName,
                email: data.email,
                phone: data.phone,
                avatarUrl: data.avatarUrl,
                pronouns: data.pronouns,
                jobTitle: data.jobTitle,
                departmentName: data.departmentName,
                managerName: data.managerName,
                status: data.status,
                startDate: data.startDate,
                location: data.location,
                directReports: data.directReports.map {
                    HRColleague(id: $0.id, displayName: $0.displayName, email: nil, avatarUrl: $0.avatarUrl, jobTitle: $0.jobTitle, departmentName: nil)
                }
            )
        case let .default(status, response): throw Self.failure(status, try? response.body.json.error)
        }
    }

    nonisolated private static func profile(_ profile: Components.Schemas.Profile) -> HRProfile {
        HRProfile(
            id: profile.id,
            displayName: profile.displayName,
            email: profile.email,
            phone: profile.phone,
            avatarUrl: profile.avatarUrl,
            jobTitle: profile.jobTitle,
            employeeNumber: profile.employeeNumber,
            status: profile.status,
            startDate: profile.startDate,
            location: profile.location,
            departmentName: profile.departmentName,
            managerName: profile.manager?.value1.displayName
        )
    }

    nonisolated private static func absence(_ row: Components.Schemas.MyAbsence) -> HRAbsence {
        HRAbsence(
            id: row.id,
            startDate: row.startDate,
            endDate: row.endDate,
            firstDay: row.firstDay,
            note: row.note,
            status: row.status,
            days: row.days,
            createdAt: row.createdAt
        )
    }
}

/// Money still outstanding per currency, in first-seen order: awaiting a
/// decision, and approved but not paid (the server's `open`, to the cent).
func openAmounts(_ rows: [HRDeclaration]) -> [HROpenAmount] {
    var order: [String] = []
    var pending: [String: Double] = [:]
    var approved: [String: Double] = [:]
    for row in rows where row.status == "pending" || row.status == "approved" {
        if pending[row.currency] == nil {
            order.append(row.currency)
            pending[row.currency] = 0
            approved[row.currency] = 0
        }
        if row.status == "pending" {
            pending[row.currency] = (((pending[row.currency] ?? 0) + row.amount) * 100).rounded() / 100
        } else {
            approved[row.currency] = (((approved[row.currency] ?? 0) + row.amount) * 100).rounded() / 100
        }
    }
    return order.map { HROpenAmount(currency: $0, pending: pending[$0] ?? 0, approved: approved[$0] ?? 0) }
}
