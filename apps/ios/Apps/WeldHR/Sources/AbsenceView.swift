import SwiftUI
import WeldCore
import WeldUI

/// Absence: the member's requests and sick reports per year; for who may, who
/// is off on a given day, and the leave requests waiting for their approval.
struct AbsenceView: View {
    @Environment(HRStore.self) private var store
    @Environment(HRNavigator.self) private var nav
    @State private var chosen = "mine"
    @State private var year = Calendar.current.component(.year, from: Date())
    @State private var day = HRDays.today()
    @State private var picking = false

    var body: some View {
        let access = store.access.data ?? .noAccess
        let state = SelfState.of(me: store.me, access: store.access)
        let thisYear = Calendar.current.component(.year, from: Date())
        var options: [Segment<String>] = []
        if access.me { options.append(Segment(value: "mine", label: HRStrings.absenceMine, tag: "absence-mine")) }
        if access.leave || access.sickToday { options.append(Segment(value: "absences", label: HRStrings.absenceAbsences, tag: "absence-team")) }
        if access.approveLeave {
            options.append(Segment(value: "requests", label: HRStrings.absenceRequests, tag: "absence-requests", count: store.pendingLeave.data?.count ?? 0))
        }
        let view = options.contains { $0.value == chosen } ? chosen : options.first?.value ?? "mine"
        return List {
            Section {
                Segments(options: options, selection: Binding(get: { view }, set: { chosen = $0 }))
                    .segmentsRow()
                    .listRowBackground(Color.clear)
                if view == "mine" {
                    PeriodNav(label: String(year), onPrevious: { year -= 1 }, onNext: year <= thisYear ? Optional({ year += 1 }) : nil)
                        .segmentsRow()
                        .listRowBackground(Color.clear)
                } else if view == "absences" {
                    PeriodNav(
                        label: Fmt.longDay(day),
                        onPrevious: { day = HRDays.add(day, -1) },
                        onNext: { day = HRDays.add(day, 1) },
                        onLabel: { picking = true }
                    )
                    .segmentsRow()
                    .listRowBackground(Color.clear)
                }
            }
            switch view {
            case "mine":
                SelfGate(state: state, retry: { await store.load(.me) }) { _, features in
                    QueryBody(state: store.leave, retry: { await store.load(.leave) }) { leave in
                        MyAbsence(year: year, requests: leave.requests, absences: store.absences.data, canRequest: features.leaveRequests)
                    }
                }
            case "absences":
                let loading = (access.leave && store.teamLeave(day, day).data == nil && store.teamLeave(day, day).error == nil)
                    || (access.sickToday && store.sickReports.data == nil && store.sickReports.error == nil)
                if loading {
                    ProgressView().frame(maxWidth: .infinity)
                } else {
                    OffOnDay(
                        day: day,
                        leave: access.leave ? store.teamLeave(day, day).data ?? [] : [],
                        sick: access.sickToday ? store.sickReports.data ?? [] : []
                    )
                }
            default:
                QueryBody(state: store.pendingLeave, retry: { await store.load(.pendingLeave) }) { requests in
                    if requests.isEmpty {
                        HREmpty(HRStrings.teamNothingToApprove, description: HRStrings.teamNothingToApproveDescription, symbol: "calendar")
                    } else {
                        LeaveApprovals(requests: requests)
                    }
                }
            }
        }
        .listStyle(.plain)
        .navigationTitle(HRStrings.tabsAbsence)
        .refreshable {
            switch view {
            case "mine":
                await store.load(.leave)
                await store.load(.absences)
            case "absences":
                await store.load(.teamLeave(day, day))
                await store.load(.sickReports)
            default:
                await store.load(.pendingLeave)
            }
        }
        .task(id: "\(view)-\(day)-\(state.features != nil)") {
            switch view {
            case "mine":
                if state.features != nil {
                    await store.ensure(.leave)
                    await store.ensure(.absences)
                }
            case "absences":
                if access.leave { await store.ensure(.teamLeave(day, day)) }
                if access.sickToday { await store.ensure(.sickReports) }
            default:
                await store.ensure(.pendingLeave)
            }
        }
        .sheet(isPresented: $picking) {
            DayPicker(day: day) { picked in
                day = picked
                picking = false
            }
        }
    }
}

/// The member's year, in the platform's groups: leave requests Pending,
/// Approved and Rejected & cancelled, then the sick reports, and the totals.
private struct MyAbsence: View {
    let year: Int
    let requests: [HRLeaveRequest]
    let absences: HRAbsences?
    let canRequest: Bool
    @Environment(HRNavigator.self) private var nav

    var body: some View {
        let today = HRDays.today()
        let prefix = String(year)
        let inYear = requests.filter { $0.startDate.hasPrefix(prefix) || $0.endDate.hasPrefix(prefix) }
        let open = inYear.filter { $0.status == "pending" }.sorted { $0.startDate < $1.startDate }
        let approved = inYear.filter { $0.status == "approved" }.sorted { $0.startDate > $1.startDate }
        let closed = inYear.filter { $0.status != "pending" && $0.status != "approved" }.sorted { $0.startDate > $1.startDate }
        let groups: [(title: String, requests: [HRLeaveRequest])] = [
            (title: HRStrings.absenceGroupsPending, requests: open),
            (title: HRStrings.absenceGroupsApproved, requests: approved),
            (title: HRStrings.absenceGroupsRejectedCancelled, requests: closed),
        ]
        let current = absences?.current
        let reports = ([current].compactMap { $0 } + (absences?.history ?? []).filter { $0.id != current?.id })
            .filter { $0.startDate.hasPrefix(prefix) || ($0.endDate ?? today).hasPrefix(prefix) }
        let reportSick = today.hasPrefix(prefix) && current == nil
        Group {
            if !canRequest {
                Section { Text(HRStrings.timeOffTurnedOff).font(.inter(.subheadline)).foregroundStyle(.secondary) }
            }
            if inYear.isEmpty && reports.isEmpty && !reportSick {
                HREmpty(HRStrings.absenceNoAbsence(year: prefix), symbol: "calendar")
            } else {
                ForEach(groups.filter { !$0.requests.isEmpty }, id: \.title) { group in
                    Section {
                        ForEach(group.requests) { request in Button { nav.open(.leave(request.id)) } label: { LeaveRowView(request: request) } }
                    } header: { GroupHead(title: group.title, count: group.requests.count) }
                }
                if !reports.isEmpty || reportSick {
                    Section {
                        ForEach(reports) { report in Button { nav.open(.sickReport(report.id)) } label: { SickRowView(absence: report) } }
                        if reportSick {
                            Button { nav.present(.sick) } label: {
                                HRRow(title: HRStrings.absenceReportSick) {
                                    Image(systemName: "heart.text.square").foregroundStyle(.secondary)
                                }
                            }
                            .accessibilityIdentifier("absence-report-sick")
                        }
                    } header: { GroupHead(title: HRStrings.absenceSickLeave, count: reports.isEmpty ? nil : reports.count) }
                }
                Section {
                    let leaveDays = inYear.filter { $0.status == "approved" }.reduce(0) { $0 + $1.days }
                    let sickDays = reports.reduce(0) { $0 + $1.days }
                    LabeledContent(
                        HRStrings.commonTotal,
                        value: "\(HRStrings.absenceLeaveDays(days: Fmt.daysText(leaveDays))) · \(HRStrings.absenceSickDays(days: Fmt.daysText(sickDays)))"
                    )
                }
            }
        }
        .buttonStyle(.plain)
    }
}

/// Who is off on `day`: approved leave and sick reports that cover it.
private struct OffOnDay: View {
    let day: String
    let leave: [HRLeaveRequest]
    let sick: [HRAbsence]

    var body: some View {
        let today = HRDays.today()
        let onLeave = leave.filter { $0.startDate <= day && $0.endDate >= day }
        let ill = sick.filter { $0.startDate <= day && ($0.endDate ?? today) >= day && day <= today }
        if onLeave.isEmpty && ill.isEmpty {
            HREmpty(HRStrings.absenceNobodyAbsent, description: HRStrings.absenceNobodyAbsentDescription, symbol: "calendar")
        } else {
            if !onLeave.isEmpty {
                Section {
                    ForEach(onLeave) { request in
                        HRRow(
                            title: request.employeeName ?? "",
                            subtitle: "\(request.leaveTypeName ?? HRStrings.absenceLeave) · \(Fmt.span(request.startDate, request.endDate))",
                            detail: Fmt.daysText(request.days),
                            subtitleDot: HRDot(color: request.leaveTypeColor)
                        ) { PersonAvatar(name: request.employeeName, size: 32) }
                    }
                } header: { GroupHead(title: HRStrings.absenceLeave, count: onLeave.count) }
            }
            if !ill.isEmpty {
                Section {
                    ForEach(ill) { absence in
                        HRRow(
                            title: absence.employeeName ?? "",
                            subtitle: absence.endDate.map { Fmt.span(absence.startDate, $0) } ?? "\(Fmt.shortDate(absence.startDate))\(Fmt.range)…",
                            detail: Fmt.daysText(absence.days),
                            tag: .status(absence.status, Labels.absenceStatus(absence.status))
                        ) { PersonAvatar(name: absence.employeeName, size: 32) }
                    }
                } header: { GroupHead(title: HRStrings.absenceSick, count: ill.count) }
            }
        }
    }
}

/// The requests to approve: a search over who, what type, why and when, and a filter that switches leave types off.
private struct LeaveApprovals: View {
    let requests: [HRLeaveRequest]
    @Environment(HRStore.self) private var store
    @State private var search = ""
    @State private var off: Set<String> = []
    @State private var filtering = false

    var body: some View {
        var types: [String: String] = [:]
        for request in requests { types[request.leaveTypeId] = request.leaveTypeName ?? HRStrings.absenceLeave }
        let hidden = off.filter { types[$0] != nil }
        let shown = requests.filter { request in
            !hidden.contains(request.leaveTypeId) && HRSearch.matches(search, [
                request.employeeName, request.leaveTypeName, request.reason,
                Fmt.span(request.startDate, request.endDate), Fmt.daysText(request.days),
            ])
        }
        return Group {
            Section {
                SearchBox(text: $search, placeholder: HRStrings.absenceSearch, filtered: !hidden.isEmpty, onFilter: { filtering = true }, tag: "leave-approvals")
                    .sheet(isPresented: $filtering) {
                        FilterSheet(options: types.map { ($0.key, $0.value) }.sorted { $0.1 < $1.1 }, off: hidden) { off = $0 }
                    }
            }
            if shown.isEmpty {
                NoMatches(
                    title: HRStrings.absenceNoResults,
                    description: HRStrings.absenceNoResultsDescription,
                    filtered: !hidden.isEmpty,
                    clearFilters: { off = [] },
                    clearSearch: { search = "" }
                )
            } else {
                Section {
                    ForEach(shown) { request in
                        ApprovalRow(
                            id: request.id,
                            name: request.employeeName ?? "",
                            subtitle: "\(request.leaveTypeName ?? HRStrings.absenceLeave) · \(Fmt.span(request.startDate, request.endDate)) · \(Fmt.daysText(request.days))",
                            subtitleDot: HRDot(color: request.leaveTypeColor),
                            note: request.reason
                        ) { approve, note in
                            try await store.reviewLeave(id: request.id, approve: approve, note: note)
                        }
                    }
                } header: {
                    GroupHead(title: HRStrings.absenceGroupsPending, count: shown.count)
                }
            }
        }
    }
}

/// A request or claim to approve, the same on Absence → Requests and Expenses →
/// To approve, as the platform's review rows: who (medium) with what and when
/// under it, the amount on the right, and the small outline Approve and Reject
/// buttons the platform puts on a pending row.
struct ApprovalRow: View {
    let id: String
    let name: String
    let subtitle: String
    var subtitleDot: HRDot?
    var subtitleSymbol: String?
    let note: String?
    var value: String?
    let decide: (Bool, String?) async throws -> Void
    @Environment(Toaster.self) private var toaster
    @State private var busy = false
    @State private var rejecting = false
    @State private var reason = ""

    var body: some View {
        HStack(alignment: .top, spacing: Tokens.Spacing.m) {
            PersonAvatar(name: name, size: 32)
            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text(name).font(.inter(size: 15, weight: .medium)).lineLimit(1)
                    Spacer(minLength: Tokens.Spacing.s)
                    if let value { Text(value).font(.inter(.subheadline, weight: .medium)).monospacedDigit().lineLimit(1) }
                }
                HStack(spacing: 6) {
                    if let subtitleDot { ColorDot(color: subtitleDot.color) }
                    if let subtitleSymbol { Image(systemName: subtitleSymbol).font(.system(size: 11)).foregroundStyle(.secondary) }
                    Text(subtitle).font(.inter(.footnote)).foregroundStyle(.secondary).lineLimit(2)
                }
                if let note, !note.isEmpty { Text(note).font(.inter(.footnote)).foregroundStyle(.secondary).lineLimit(2) }
                HStack(spacing: 6) {
                    Button { run(approve: true, note: nil) } label: {
                        Label(HRStrings.teamApprove, systemImage: "checkmark").font(.inter(.caption, weight: .medium))
                    }
                    .accessibilityIdentifier("approve-\(id)")
                    Button { rejecting = true } label: {
                        Label(HRStrings.teamReject, systemImage: "xmark").font(.inter(.caption, weight: .medium))
                    }
                    .accessibilityIdentifier("reject-\(id)")
                    if busy { ProgressView().controlSize(.small) }
                }
                .buttonStyle(.bordered)
                .tint(Tokens.Palette.foreground)
                .controlSize(.small)
                .disabled(busy)
                .padding(.top, Tokens.Spacing.s)
            }
        }
        .padding(.vertical, Tokens.Spacing.xs)
        .accessibilityIdentifier("approval-\(id)")
        .sheet(isPresented: $rejecting) {
            NavigationStack {
                Form {
                    Section(HRStrings.teamRejectNote) {
                        TextField(HRStrings.teamRejectNotePlaceholder, text: $reason, axis: .vertical)
                            .lineLimit(3 ... 6)
                            .accessibilityIdentifier("reject-note")
                    }
                    Section {
                        Button(HRStrings.teamRejectConfirm, role: .destructive) {
                            run(approve: false, note: reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : String(reason.prefix(2000)))
                        }
                        .disabled(busy)
                        .accessibilityIdentifier("reject-confirm")
                    }
                }
                .navigationTitle(HRStrings.teamRejectTitle)
                .navigationBarTitleDisplayMode(.inline)
            }
            .presentationDetents([.medium])
        }
    }

    private func run(approve: Bool, note: String?) {
        busy = true
        Task {
            let done = await runWrite(toaster, success: approve ? HRStrings.teamApproved : HRStrings.teamRejected) {
                try await decide(approve, note)
            }
            busy = false
            if done { rejecting = false }
        }
    }
}
