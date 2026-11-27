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
            options.append(Segment(value: "requests", label: withCount(HRStrings.absenceRequests, store.pendingLeave.data?.count ?? 0), tag: "absence-requests"))
        }
        let view = options.contains { $0.value == chosen } ? chosen : options.first?.value ?? "mine"
        return List {
            Section {
                Segments(options: options, selection: Binding(get: { view }, set: { chosen = $0 }))
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                if view == "mine" {
                    PeriodNav(label: String(year), onPrevious: { year -= 1 }, onNext: year <= thisYear ? Optional({ year += 1 }) : nil)
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                } else if view == "absences" {
                    PeriodNav(
                        label: Fmt.longDay(day),
                        onPrevious: { day = HRDays.add(day, -1) },
                        onNext: { day = HRDays.add(day, 1) },
                        onLabel: { picking = true }
                    )
                    .listRowInsets(EdgeInsets())
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
                        ContentUnavailableView(HRStrings.teamNothingToApprove, systemImage: "checkmark.circle", description: Text(HRStrings.teamNothingToApproveDescription))
                    } else {
                        LeaveApprovals(requests: requests)
                    }
                }
            }
        }
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

/// The member's year: requests waiting, the ones reviewed, sick reports, and the totals.
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
        let reviewed = inYear.filter { $0.status != "pending" }.sorted { $0.startDate > $1.startDate }
        let current = absences?.current
        let reports = ([current].compactMap { $0 } + (absences?.history ?? []))
            .filter { $0.startDate.hasPrefix(prefix) || ($0.endDate ?? today).hasPrefix(prefix) }
        let reportSick = today.hasPrefix(prefix) && current == nil
        Group {
            if !canRequest {
                Section { Text(HRStrings.timeOffTurnedOff).font(.subheadline).foregroundStyle(.secondary) }
            }
            if open.isEmpty && reviewed.isEmpty && reports.isEmpty && !reportSick {
                ContentUnavailableView(HRStrings.absenceNoAbsence(year: prefix), systemImage: "calendar")
            } else {
                if !open.isEmpty {
                    Section {
                        ForEach(open) { request in Button { nav.open(.leave(request.id)) } label: { LeaveRowView(request: request) } }
                    } header: { HeadWithFigure(title: HRStrings.absenceOpenRequests, figure: String(open.count)) }
                }
                if !reviewed.isEmpty {
                    Section {
                        ForEach(reviewed) { request in Button { nav.open(.leave(request.id)) } label: { LeaveRowView(request: request) } }
                    } header: { HeadWithFigure(title: HRStrings.absenceReviewed, figure: String(reviewed.count)) }
                }
                if !reports.isEmpty || reportSick {
                    Section {
                        ForEach(reports) { report in Button { nav.open(.sickReport(report.id)) } label: { SickRowView(absence: report) } }
                        if reportSick {
                            Button { nav.present(.sick) } label: {
                                HRRow(title: HRStrings.absenceReportSick) { IconTile(symbol: "thermometer.medium") }
                            }
                            .accessibilityIdentifier("absence-report-sick")
                        }
                    } header: { HeadWithFigure(title: HRStrings.absenceSickLeave, figure: reports.isEmpty ? nil : String(reports.count)) }
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
            ContentUnavailableView(HRStrings.absenceNobodyAbsent, systemImage: "person.3", description: Text(HRStrings.absenceNobodyAbsentDescription))
        } else {
            if !onLeave.isEmpty {
                Section {
                    ForEach(onLeave) { request in
                        HRRow(
                            title: request.employeeName ?? "",
                            subtitle: request.leaveTypeName ?? HRStrings.absenceLeave,
                            value: Fmt.span(request.startDate, request.endDate),
                            detail: Fmt.daysText(request.days)
                        ) { PersonAvatar(name: request.employeeName) }
                    }
                } header: { HeadWithFigure(title: HRStrings.absenceLeave, figure: String(onLeave.count)) }
            }
            if !ill.isEmpty {
                Section {
                    ForEach(ill) { absence in
                        HRRow(
                            title: absence.employeeName ?? "",
                            subtitle: HRStrings.absenceSick,
                            value: absence.endDate.map { Fmt.span(absence.startDate, $0) } ?? "\(Fmt.shortDate(absence.startDate))\(Fmt.range)…",
                            detail: Fmt.daysText(absence.days)
                        ) { PersonAvatar(name: absence.employeeName) }
                    }
                } header: { HeadWithFigure(title: HRStrings.absenceSick, figure: String(ill.count)) }
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
                            subtitle: request.leaveTypeName ?? HRStrings.absenceLeave,
                            note: request.reason,
                            value: Fmt.span(request.startDate, request.endDate),
                            detail: Fmt.daysText(request.days)
                        ) { approve, note in
                            try await store.reviewLeave(id: request.id, approve: approve, note: note)
                        }
                    }
                }
            }
        }
    }
}

/// A request or claim to approve: who and what for, the dates or the amount, Decline and Approve under it.
struct ApprovalRow: View {
    let id: String
    let name: String
    let subtitle: String
    let note: String?
    let value: String
    let detail: String
    let decide: (Bool, String?) async throws -> Void
    @Environment(Toaster.self) private var toaster
    @State private var busy = false
    @State private var rejecting = false
    @State private var reason = ""

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Spacing.m) {
            HStack(alignment: .top, spacing: Tokens.Spacing.m) {
                PersonAvatar(name: name)
                VStack(alignment: .leading, spacing: 2) {
                    Text(name).font(.body.weight(.semibold)).lineLimit(1)
                    Text(subtitle).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                    if let note, !note.isEmpty { Text(note).font(.subheadline).foregroundStyle(.secondary).lineLimit(2) }
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Text(value).font(.subheadline).lineLimit(1)
                    Text(detail).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            HStack {
                Button(HRStrings.teamReject) { rejecting = true }
                    .buttonStyle(.bordered)
                    .disabled(busy)
                    .accessibilityIdentifier("reject-\(id)")
                Button {
                    run(approve: true, note: nil)
                } label: {
                    if busy { ProgressView() } else { Text(HRStrings.teamApprove) }
                }
                .buttonStyle(.borderedProminent)
                .disabled(busy)
                .accessibilityIdentifier("approve-\(id)")
            }
            .padding(.leading, 34 + Tokens.Spacing.m)
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
