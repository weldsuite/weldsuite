import QuickLook
import SwiftUI
import WeldCore
import WeldUI

/// One of my shifts (or hours clocked without one, by the record's id): when
/// and what for, its breaks, what was clocked on it, and what it pays.
struct ShiftView: View {
    let id: String
    let day: String
    let workspace: String
    @Environment(HRStore.self) private var store
    @State private var now = nowMillis()

    var body: some View {
        let from = HRDays.startOfWeek(day.isEmpty ? HRDays.today() : day)
        let to = HRDays.add(from, 6)
        List {
            QueryBody(state: store.week(from, to), retry: { await store.load(.week(from, to)) }) { data in
                let shift = data.shifts.first { $0.id == id }
                let loose = shift == nil ? data.records.first { $0.id == id } : nil
                if shift == nil && loose == nil {
                    HREmpty(HRStrings.shiftNotFound, symbol: "calendar")
                } else {
                    let worked: [HRClockRecord] = shift.map { shift in
                        ShiftMath.byClockIn(data.records.filter { ShiftMath.shiftOf($0, shifts: data.shifts, now: now)?.id == shift.id })
                    } ?? [loose].compactMap { $0 }
                    ShiftDetail(shift: shift, loose: loose, worked: worked, now: now, workspace: workspace)
                }
            }
        }
        .navigationTitle(day.isEmpty ? HRStrings.shiftDetails : Fmt.longDay(day))
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await store.load(.week(from, to)) }
        .task(id: from) { await store.ensure(.week(from, to)) }
        .task {
            while !Task.isCancelled {
                now = nowMillis()
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }
}

private struct ShiftDetail: View {
    let shift: HRShift?
    let loose: HRClockRecord?
    let worked: [HRClockRecord]
    let now: Double
    let workspace: String

    var body: some View {
        let company = shift?.companyName ?? loose?.companyName
        let open = worked.first(where: ShiftMath.isOpen)
        let started = shift.map { (WeldDate.parse($0.startsAt)?.timeIntervalSince1970 ?? 0) * 1000 <= now } ?? true
        let workedMinutes = worked.reduce(0) { $0 + ShiftMath.minutesOf($1, now: now) }
        let status = statusOf(open: open != nil, started: started)
        let place = shift.map { [$0.workType, company].compactMap { $0 }.joined(separator: " · ") }.map { $0.isEmpty ? workspace : $0 } ?? HRStrings.scheduleWithoutShift
        Section {
            HStack(alignment: .top, spacing: Tokens.Spacing.m) {
                RoundedRectangle(cornerRadius: 2).fill(Color(hrRGB: Swatches.shiftColor(company))).frame(width: 4)
                VStack(alignment: .leading, spacing: 2) {
                    HStack {
                        Text(shift.map { Fmt.timeRange($0.startsAt, $0.endsAt) } ?? Fmt.timeRange(loose?.clockIn, loose?.clockOut))
                            .font(.inter(.title3))
                        Spacer()
                        Text(shift.map { Fmt.hm(Double(ShiftMath.plannedMinutes($0))) } ?? Fmt.hm(workedMinutes)).foregroundStyle(.secondary)
                    }
                    Text(place).font(.inter(.subheadline)).foregroundStyle(.secondary).lineLimit(1)
                    ToneBadge(status.text, tone: status.tone)
                        .padding(.top, Tokens.Spacing.xs)
                        .accessibilityIdentifier("shift-status")
                }
            }
            .fixedSize(horizontal: false, vertical: true)
        }
        if let notes = shift?.notes {
            Section(HRStrings.shiftNotes) { Text(notes) }
        }
        breaks
        if !worked.isEmpty || started {
            Section(HRStrings.shiftWorked) {
                if worked.isEmpty {
                    HRRow(title: HRStrings.scheduleNotClockedIn, muted: true)
                }
                ForEach(worked) { record in
                    let since = ShiftMath.isOpen(record) ? record.clockIn : nil
                    let late = record.lateMinutes.flatMap { $0 > 0 ? HRStrings.timesheetLate(minutes: String($0)) : nil }
                    HRRow(
                        title: record.clockIn != nil ? Fmt.timeRange(record.clockIn, record.clockOut) : Labels.attendanceStatus(record.status),
                        subtitle: [Labels.source(record.source), late].compactMap { $0 }.joined(separator: " · "),
                        value: since.map { ShiftMath.timer(now - (WeldDate.parse($0)?.timeIntervalSince1970 ?? 0) * 1000) } ?? Fmt.hm(ShiftMath.minutesOf(record, now: now)),
                        detail: since != nil ? HRStrings.timesheetClockedIn : nil,
                        detailColor: Tokens.Status.success,
                        tag: since == nil ? .status(record.status, Labels.attendanceStatus(record.status)) : nil
                    )
                }
                ForEach(worked.compactMap(\.notes), id: \.self) { note in FactRow(label: HRStrings.shiftNotes, value: note) }
            }
        }
        pay(workedMinutes: workedMinutes)
    }

    /// The shift's state as the platform's badge.
    private func statusOf(open: Bool, started: Bool) -> (text: String, tone: Tone) {
        if open { return (HRStrings.timesheetClockedIn, .primary) }
        if !worked.isEmpty {
            return worked.allSatisfy(\.approved)
                ? (HRStrings.timesheetApproved, .primary)
                : (HRStrings.timesheetPendingApproval, .outline)
        }
        if started { return (HRStrings.scheduleNotClockedIn, .outline) }
        return (HRStrings.shiftPlanned, .secondary)
    }

    private func minutesText(_ value: Double) -> String {
        value >= 60 ? Fmt.hm(value) : HRStrings.shiftMinutes(minutes: String(Int(value.rounded())))
    }

    /// The planned break, time clocked out in between, and break minutes recorded; each unpaid.
    @ViewBuilder
    private var breaks: some View {
        let planned = shift.flatMap(ShiftMath.plannedBreak)
        let gaps = ShiftMath.clockedOutGaps(worked)
        let recorded = worked.filter { ($0.breakMinutes ?? 0) > 0 }
        Section {
            if planned == nil && gaps.isEmpty && recorded.isEmpty {
                HRRow(title: HRStrings.shiftNoBreak, muted: true)
            }
            if let planned {
                HRRow(
                    title: Fmt.timeRange(planned.0, planned.1),
                    subtitle: HRStrings.shiftPlannedBreak,
                    value: minutesText(Double(ShiftMath.minutesBetween(planned.0, planned.1))),
                    detail: HRStrings.shiftUnpaid
                )
            }
            ForEach(Array(gaps.enumerated()), id: \.offset) { _, gap in
                HRRow(
                    title: Fmt.timeRange(gap.0, gap.1),
                    subtitle: HRStrings.shiftClockedOut,
                    value: minutesText(Double(ShiftMath.minutesBetween(gap.0, gap.1))),
                    detail: HRStrings.shiftUnpaid
                )
            }
            ForEach(recorded) { record in
                HRRow(
                    title: HRStrings.shiftRecordedBreak,
                    subtitle: record.clockIn.map { Fmt.timeRange($0, record.clockOut) },
                    value: minutesText(Double(record.breakMinutes ?? 0)),
                    detail: HRStrings.shiftUnpaid
                )
            }
        } header: {
            Text(HRStrings.shiftBreaks)
        } footer: {
            if planned != nil || !gaps.isEmpty || !recorded.isEmpty { Text(HRStrings.shiftBreaksUnpaid) }
        }
    }

    /// The hourly rate, and what was earned or, before any hours, what the shift will pay.
    @ViewBuilder
    private func pay(workedMinutes: Double) -> some View {
        let priced = worked.first { $0.hourlyRate != nil }
        let rate = shift?.hourlyRate ?? priced?.hourlyRate
        let currency = shift?.currency ?? priced?.currency ?? ShiftMath.defaultCurrency
        Section(HRStrings.shiftPay) {
            FactRow(label: HRStrings.shiftHourlyRate, value: rate.map { HRStrings.shiftPerHour(amount: Fmt.money($0, currency)) } ?? HRStrings.shiftNoRate)
            if !worked.isEmpty {
                FactRow(label: HRStrings.shiftPaidHours, value: Fmt.hm(workedMinutes))
                FactRow(label: HRStrings.shiftEarned, value: Fmt.earnings(ShiftMath.earnings(worked, now: now, fallback: currency)))
            } else {
                let planned = shift.map(ShiftMath.plannedMinutes) ?? 0
                FactRow(label: HRStrings.shiftPaidHours, value: Fmt.hm(Double(planned)))
                FactRow(label: HRStrings.shiftExpected, value: Fmt.money(rate.map { Double(planned) / 60 * $0 } ?? 0, currency))
            }
        }
    }
}

/// A shift I asked to work: when, what for, my note and the answer; withdraw while it waits.
struct ShiftRequestView: View {
    let id: String
    let day: String
    @Environment(HRStore.self) private var store
    @Environment(Toaster.self) private var toaster
    @Environment(\.dismiss) private var dismiss
    @State private var confirming = false
    @State private var busy = false

    var body: some View {
        let from = HRDays.startOfWeek(day.isEmpty ? HRDays.today() : day)
        let to = HRDays.add(from, 6)
        List {
            QueryBody(state: store.week(from, to), retry: { await store.load(.week(from, to)) }) { data in
                if let request = data.requests.first(where: { $0.id == id }) {
                    let range = Fmt.timeRange(request.startsAt, request.endsAt)
                    let dayText = Fmt.longDay(HRDays.dayOf(request.startsAt))
                    let hours = Fmt.hm(Double(ShiftMath.minutesBetween(request.startsAt, request.endsAt)))
                    let reviewed = request.reviewedAt.map(Fmt.date)
                    Section {
                        HRRow(
                            title: range,
                            subtitle: [hours, request.workType].compactMap { $0 }.joined(separator: " · "),
                            tag: .status(request.status, Labels.shiftRequestStatus(request.status))
                        ) { ShiftBar(client: nil) }
                    }
                    Section(HRStrings.shiftDetails) {
                        Facts(rows: [
                            (HRStrings.shiftRequestDay, dayText),
                            (HRStrings.shiftTime, range),
                            (HRStrings.shiftLength, hours),
                            (HRStrings.shiftWork, request.workType),
                            (HRStrings.shiftRequestNote, request.note),
                            (HRStrings.shiftRequestRequested, Fmt.date(request.createdAt)),
                            (HRStrings.shiftRequestReviewed, reviewed.map { date in request.reviewedByName.map { HRStrings.shiftRequestReviewedBy(date: date, name: $0) } ?? date }),
                            (HRStrings.shiftRequestReviewNote, request.reviewNote),
                        ])
                    }
                    if request.status == "pending" {
                        Section {
                            Button(HRStrings.shiftRequestWithdraw, role: .destructive) { confirming = true }
                                .accessibilityIdentifier("shift-request-withdraw")
                        }
                        .confirmationDialog(HRStrings.shiftRequestWithdrawTitle, isPresented: $confirming, titleVisibility: .visible) {
                            Button(HRStrings.shiftRequestWithdrawConfirm, role: .destructive) {
                                Task {
                                    busy = true
                                    if await runWrite(toaster, success: HRStrings.shiftRequestWithdrawn, { try await store.cancelShiftRequest(id: request.id) }) { dismiss() }
                                    busy = false
                                }
                            }
                            .accessibilityIdentifier("confirm-withdraw")
                            Button(HRStrings.shiftRequestKeep, role: .cancel) {}
                        } message: {
                            Text(HRStrings.shiftRequestWithdrawMessage(when: "\(dayText) \(range)"))
                        }
                    }
                } else {
                    HREmpty(HRStrings.shiftRequestNotFound, symbol: "calendar")
                }
            }
        }
        .disabled(busy)
        .navigationTitle(HRStrings.shiftRequestDetails)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await store.load(.week(from, to)) }
        .task(id: from) { await store.ensure(.week(from, to)) }
    }
}

/// An open shift: sign up with a note, see that it waits (and withdraw), or why it is declined or full.
struct OpenShiftView: View {
    let id: String
    @Environment(HRStore.self) private var store
    @Environment(Toaster.self) private var toaster
    @Environment(\.dismiss) private var dismiss
    @State private var note = ""
    @State private var confirming = false
    @State private var busy = false

    var body: some View {
        List {
            QueryBody(state: store.openShifts, retry: { await store.load(.openShifts) }) { list in
                if let shift = list.first(where: { $0.id == id }) {
                    content(shift)
                } else {
                    HREmpty(HRStrings.openShiftsNotFound, symbol: "calendar")
                }
            }
        }
        .navigationTitle(HRStrings.openShiftsDetails)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await store.load(.openShifts) }
        .task { await store.ensure(.openShifts) }
    }

    @ViewBuilder
    private func content(_ shift: HROpenShift) -> some View {
        let standing = OpenShiftRules.standingOf(shift)
        let range = Fmt.timeRange(shift.startsAt, shift.endsAt)
        let dayText = Fmt.longDay(HRDays.dayOf(shift.startsAt))
        let hours = Fmt.hm(Double(ShiftMath.plannedMinutes(startsAt: shift.startsAt, endsAt: shift.endsAt, breakStartsAt: shift.breakStartsAt, breakEndsAt: shift.breakEndsAt)))
        let canSignUp = OpenShiftRules.canSignUp(shift, now: nowMillis())
        Section {
            HRRow(
                title: range,
                subtitle: [hours, shift.workType].compactMap { $0 }.joined(separator: " · "),
                detail: spotsText(shift.spotsLeft),
                tag: standingTag(standing)
            ) { ShiftBar(client: shift.companyName) }
        }
        if canSignUp {
            Section {
                TextField(HRStrings.openShiftsNotePlaceholder, text: $note, axis: .vertical)
                    .lineLimit(2 ... 5)
                    .accessibilityIdentifier("open-shift-note")
                Button {
                    Task {
                        busy = true
                        let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
                        if await runWrite(toaster, success: HRStrings.openShiftsSignedUp, {
                            try await store.signUp(openShiftId: shift.id, note: trimmed.isEmpty ? nil : String(trimmed.prefix(1000)))
                        }) { dismiss() }
                        busy = false
                    }
                } label: {
                    if busy { ProgressView() } else { Text(HRStrings.openShiftsSubmit).frame(maxWidth: .infinity) }
                }
                .buttonStyle(.borderedProminent)
                .disabled(busy)
                .accessibilityIdentifier("open-shift-sign-up")
            } header: {
                Text(HRStrings.openShiftsNote)
            } footer: {
                Text(HRStrings.openShiftsSignUpHint)
            }
        }
        if standing == .waiting, let requestId = shift.myRequest?.id {
            Section {
                Button(HRStrings.openShiftsWithdraw, role: .destructive) { confirming = true }
                    .accessibilityIdentifier("open-shift-withdraw")
            } footer: {
                Text(HRStrings.openShiftsWaitingHint)
            }
            .confirmationDialog(HRStrings.openShiftsWithdrawTitle, isPresented: $confirming, titleVisibility: .visible) {
                Button(HRStrings.openShiftsWithdrawConfirm, role: .destructive) {
                    Task {
                        if await runWrite(toaster, success: HRStrings.openShiftsWithdrawn, { try await store.cancelShiftRequest(id: requestId) }) { dismiss() }
                    }
                }
                .accessibilityIdentifier("confirm-withdraw")
                Button(HRStrings.openShiftsKeep, role: .cancel) {}
            } message: {
                Text(HRStrings.openShiftsWithdrawMessage(when: "\(dayText) \(range)"))
            }
        }
        if standing == .declined && !canSignUp {
            Section { Text(HRStrings.openShiftsDeclinedHint).foregroundStyle(.secondary) }
        }
        if standing == .full {
            Section { Text(HRStrings.openShiftsFullHint).foregroundStyle(.secondary) }
        }
        Section(HRStrings.shiftDetails) {
            Facts(rows: [
                (HRStrings.shiftRequestDay, dayText),
                (HRStrings.shiftTime, range),
                (HRStrings.shiftLength, hours),
                (HRStrings.shiftPlannedBreak, shift.breakStartsAt.flatMap { start in shift.breakEndsAt.map { Fmt.timeRange(start, $0) } }),
                (HRStrings.shiftWork, shift.workType),
                (HRStrings.openShiftsClient, shift.companyName),
                (HRStrings.openShiftsDepartment, shift.departmentName),
                (HRStrings.openShiftsSpots, HRStrings.openShiftsSpotsOf(left: String(shift.spotsLeft), total: String(shift.spots))),
                (HRStrings.shiftNotes, shift.notes),
                (HRStrings.openShiftsManagerNote, shift.myRequest?.reviewNote),
            ])
        }
    }
}

/// One of my leave requests: the period, paid or not, the reason and review, the balance, cancel while allowed.
struct LeaveView: View {
    let id: String
    @Environment(HRStore.self) private var store
    @Environment(Toaster.self) private var toaster
    @Environment(\.dismiss) private var dismiss
    @State private var confirming = false

    var body: some View {
        let title = store.leave.data?.requests.first { $0.id == id }?.leaveTypeName ?? HRStrings.absenceLeave
        List {
            QueryBody(state: store.leave, retry: { await store.load(.leave) }) { data in
                if let request = data.requests.first(where: { $0.id == id }) {
                    content(request, data: data)
                } else {
                    HREmpty(HRStrings.leaveDetailNotFound, symbol: "calendar")
                }
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await store.load(.leave) }
        .task { await store.ensure(.leave) }
    }

    @ViewBuilder
    private func content(_ request: HRLeaveRequest, data: HRLeave) -> some View {
        let today = HRDays.today()
        let type = data.types.first { $0.id == request.leaveTypeId }
        let paid = data.balances.first { $0.leaveTypeId == request.leaveTypeId }?.isPaid
        let balance = LeaveRules.balanceForStart(data.balances, leaveTypeId: request.leaveTypeId, startDate: request.startDate, today: today)
        let reviewed = request.reviewedAt.map(Fmt.date)
        let days = { (value: Double?) in value.map(Fmt.days) ?? HRStrings.balanceUnlimited }
        // The platform panel's title: the type's dot and name, with the status badge.
        Section {
            HRRow(
                title: request.leaveTypeName ?? type?.name ?? HRStrings.absenceLeave,
                subtitle: "\(Fmt.span(request.startDate, request.endDate)) · \(Fmt.daysText(request.days))",
                dot: HRDot(color: request.leaveTypeColor ?? type?.color),
                tag: .status(request.status, Labels.leaveStatus(request.status))
            )
        }
        Section(HRStrings.absenceLeave) {
            Facts(rows: [
                (HRStrings.leaveDetailPeriod, Fmt.dateRange(request.startDate, request.endDate)),
                (HRStrings.leaveDetailLength, Fmt.daysText(request.days)),
                (HRStrings.leaveDetailKind, paid.map { $0 ? HRStrings.leaveDetailPaid : HRStrings.leaveDetailUnpaid }),
                (HRStrings.leaveDetailRequested, request.createdAt.map(Fmt.date)),
                (HRStrings.leaveDetailReason, request.reason),
                (HRStrings.leaveDetailReviewed, reviewed.map { date in request.reviewedByName.map { HRStrings.leaveDetailReviewedBy(date: date, name: $0) } ?? date }),
                (HRStrings.leaveDetailNote, request.reviewNote),
            ])
        }
        if let balance {
            Section(HRStrings.leaveDetailBalance(year: String(today.prefix(4)))) {
                FactRow(label: HRStrings.absenceAllowance, value: days(balance.allowance))
                FactRow(label: HRStrings.absenceTaken, value: days(balance.used))
                FactRow(label: HRStrings.absenceWaiting, value: days(balance.pending))
                FactRow(label: HRStrings.absenceLeft, value: days(balance.remaining))
            }
        }
        if LeaveRules.canCancel(request, today: today) {
            Section {
                Button(HRStrings.leaveDetailCancel, role: .destructive) { confirming = true }
                    .accessibilityIdentifier("leave-cancel")
            }
            .confirmationDialog(HRStrings.timeOffCancelTitle, isPresented: $confirming, titleVisibility: .visible) {
                Button(HRStrings.timeOffCancelConfirm, role: .destructive) {
                    Task {
                        if await runWrite(toaster, success: HRStrings.timeOffCancelled, { try await store.cancelLeave(id: request.id) }) { dismiss() }
                    }
                }
                .accessibilityIdentifier("confirm-cancel")
                Button(HRStrings.timeOffKeep, role: .cancel) {}
            } message: {
                Text(HRStrings.timeOffCancelMessage(type: request.leaveTypeName ?? "", dates: Fmt.dateRange(request.startDate, request.endDate)))
            }
        }
    }
}

/// One of my sick reports, with "I'm better" while it is open.
struct SickReportView: View {
    let id: String
    @Environment(HRStore.self) private var store
    @Environment(HRNavigator.self) private var nav

    var body: some View {
        List {
            QueryBody(state: store.absences, retry: { await store.load(.absences) }) { data in
                if let report = ([data.current].compactMap { $0 } + data.history).first(where: { $0.id == id }) {
                    Section { SickRowView(absence: report) }
                    Section(HRStrings.absenceSickLeave) {
                        Facts(rows: [
                            (HRStrings.sickDetailFirstDay, "\(Fmt.longDay(report.startDate)) · \(report.firstDay == "half" ? HRStrings.sickHalfDay : HRStrings.sickFullDay)"),
                            (HRStrings.sickDetailLastDay, report.endDate.map(Fmt.longDay) ?? HRStrings.sickDetailStillSick),
                            (HRStrings.sickDetailLength, Fmt.daysText(report.days)),
                            (HRStrings.sickDetailReported, report.createdAt.map(Fmt.date)),
                            (HRStrings.sickDetailNote, report.note),
                        ])
                    }
                    if report.status == "ongoing" {
                        Section {
                            Button(HRStrings.sickRecoverSubmit) { nav.present(.sick) }
                                .accessibilityIdentifier("sick-recover")
                        }
                    }
                } else {
                    HREmpty(HRStrings.sickDetailNotFound, symbol: "calendar")
                }
            }
        }
        .navigationTitle(HRStrings.absenceSick)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await store.load(.absences) }
        .task { await store.ensure(.absences) }
    }
}

/// One of my expense claims: the facts, the receipt to open, and withdrawing it while it waits.
struct ExpenseView: View {
    let id: String
    @Environment(HRStore.self) private var store
    @Environment(Toaster.self) private var toaster
    @Environment(\.dismiss) private var dismiss
    @State private var confirming = false
    @State private var opening = false
    @State private var preview: URL?

    var body: some View {
        let title = store.declarations.data?.declarations.first { $0.id == id }?.description ?? HRStrings.expenseDetailTitle
        List {
            QueryBody(state: store.declarations, retry: { await store.load(.declarations) }) { data in
                if let declaration = data.declarations.first(where: { $0.id == id }) {
                    content(declaration)
                } else {
                    HREmpty(HRStrings.expenseDetailNotFound, symbol: "wallet.bifold")
                }
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await store.load(.declarations) }
        .task { await store.ensure(.declarations) }
        .quickLookPreview($preview)
    }

    @ViewBuilder
    private func content(_ declaration: HRDeclaration) -> some View {
        let amount = Fmt.money(declaration.amount, declaration.currency)
        Section { DeclarationRowView(row: declaration) }
        Section(HRStrings.expenseDetailTitle) {
            Facts(rows: [
                (HRStrings.expenseFormAmount, amount),
                (HRStrings.expenseFormCategory, Labels.category(declaration.category)),
                (HRStrings.expenseFormDate, Fmt.date(declaration.expenseDate)),
                (HRStrings.expenseDetailSubmitted, declaration.createdAt.map(Fmt.date)),
                (HRStrings.expenseDetailReviewed, declaration.reviewedAt.map(Fmt.date)),
                (HRStrings.expenseDetailPaid, declaration.paidAt.map(Fmt.date)),
                (HRStrings.expenseDetailNote, declaration.reviewNote),
            ])
        }
        Section(HRStrings.expenseFormReceipt) {
            if declaration.hasReceipt {
                Button {
                    open(declaration)
                } label: {
                    HRRow(title: HRStrings.expensesViewReceipt, subtitle: declaration.receiptFileName) {
                        Image(systemName: "paperclip").foregroundStyle(.secondary)
                    } value: {
                        if opening { ProgressView() } else { Image(systemName: "chevron.right").foregroundStyle(.tertiary) }
                    }
                }
                .buttonStyle(.plain)
                .disabled(opening)
                .accessibilityIdentifier("expense-receipt")
            } else {
                HRRow(title: HRStrings.expensesNoReceipt, muted: true)
            }
        }
        if declaration.status == "pending" {
            Section {
                Button(HRStrings.expensesCancelConfirm, role: .destructive) { confirming = true }
                    .accessibilityIdentifier("expense-cancel")
            }
            .confirmationDialog(HRStrings.expensesCancelTitle, isPresented: $confirming, titleVisibility: .visible) {
                Button(HRStrings.expensesCancelConfirm, role: .destructive) {
                    Task {
                        if await runWrite(toaster, success: HRStrings.expensesCancelled, { try await store.cancelDeclaration(id: declaration.id) }) { dismiss() }
                    }
                }
                .accessibilityIdentifier("confirm-cancel")
                Button(HRStrings.expensesKeep, role: .cancel) {}
            } message: {
                Text("\(declaration.description) · \(amount)")
            }
        }
    }

    private func open(_ declaration: HRDeclaration) {
        opening = true
        Task {
            defer { opening = false }
            let name = declaration.receiptFileName ?? "receipt-\(declaration.expenseDate).jpg"
            do {
                preview = try await store.download(path: "api/weldhr/me/declarations/\(declaration.id)/receipt", fileName: name)
            } catch {
                toaster.show(HRStrings.expensesReceiptFailed)
            }
        }
    }
}

/// One announcement, its text with its line breaks; opening an unread one marks it read.
struct AnnouncementView: View {
    let id: String
    @Environment(HRStore.self) private var store
    @State private var marked = false

    var body: some View {
        let announcement = store.announcements.data?.announcements.first { $0.id == id }
        List {
            QueryBody(state: store.announcements, retry: { await store.load(.announcements) }) { data in
                if let item = data.announcements.first(where: { $0.id == id }) {
                    Section {
                        VStack(alignment: .leading, spacing: Tokens.Spacing.s) {
                            if item.pinned {
                                Label(HRStrings.announcementsPinned, systemImage: "pin").font(.inter(.footnote, weight: .medium)).foregroundStyle(.secondary)
                            }
                            Text(item.title).font(.inter(.title2, weight: .semibold)).accessibilityIdentifier("announcement-title")
                            Text([item.createdByName.map { HRStrings.announcementsBy(name: $0) }, "\(Fmt.date(item.publishedAt)), \(Fmt.time(item.publishedAt))"].compactMap { $0 }.joined(separator: " · "))
                                .font(.inter(.subheadline))
                                .foregroundStyle(.secondary)
                            Text(item.body).font(.inter(.body)).textSelection(.enabled).padding(.top, Tokens.Spacing.s)
                        }
                        .padding(.vertical, Tokens.Spacing.s)
                    }
                } else {
                    HREmpty(HRStrings.announcementsNotFound, symbol: "newspaper")
                }
            }
        }
        .navigationTitle(HRStrings.announcementsDetails)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await store.load(.announcements) }
        .task { await store.ensure(.announcements) }
        // Once per opening; a failed call is tried again the next time it is opened.
        .task(id: announcement?.readAt == nil && announcement != nil) {
            guard let announcement, announcement.readAt == nil, !marked else { return }
            marked = true
            try? await store.markRead(id: announcement.id)
        }
    }
}
