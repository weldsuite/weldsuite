import SwiftUI
import WeldCore
import WeldUI

/// Schedule: a week of what was planned and what was worked. My week has the
/// member's own days and the open shifts to sign up for; Team has everyone's
/// shifts per day, for who can read attendance.
struct ScheduleView: View {
    let workspace: WorkspaceRef
    @Environment(HRStore.self) private var store
    @State private var chosen = "mine"
    @State private var day = HRDays.today()
    @State private var picking = false

    var body: some View {
        let access = store.access.data ?? .noAccess
        let state = SelfState.of(me: store.me, access: store.access)
        var options: [Segment<String>] = []
        if access.me { options.append(Segment(value: "mine", label: HRStrings.scheduleMine, tag: "schedule-mine")) }
        if access.attendance { options.append(Segment(value: "team", label: HRStrings.scheduleTeam, tag: "schedule-team")) }
        let view = options.contains { $0.value == chosen } ? chosen : options.first?.value ?? "mine"
        let from = HRDays.startOfWeek(day)
        let to = HRDays.add(from, 6)
        return List {
            Section {
                Segments(options: options, selection: Binding(get: { view }, set: { chosen = $0 }))
                    .segmentsRow()
                    .listRowBackground(Color.clear)
                PeriodNav(
                    label: HRStrings.scheduleWeek(week: String(HRDays.isoWeek(from))),
                    sublabel: Fmt.span(from, to),
                    onPrevious: { day = HRDays.add(from, -7) },
                    onNext: { day = HRDays.add(from, 7) },
                    onLabel: { picking = true }
                )
                .segmentsRow()
                .listRowBackground(Color.clear)
            }
            if view == "mine" {
                SelfGate(state: state, retry: { await store.load(.me) }) { _, _ in
                    OpenShiftsSection(workspace: workspace.name)
                    QueryBody(state: store.week(from, to), retry: { await store.load(.week(from, to)) }) { data in
                        MyWeek(data: data, from: from, to: to, workspace: workspace.name)
                    }
                }
            } else {
                QueryBody(state: store.teamShifts(from, to), retry: { await store.load(.teamShifts(from, to)) }) { shifts in
                    QueryBody(state: store.teamAttendance(from, to), retry: { await store.load(.teamAttendance(from, to)) }) { records in
                        TeamWeek(shifts: shifts, records: records, from: from, to: to)
                    }
                }
            }
        }
        .listStyle(.plain)
        .navigationTitle(HRStrings.tabsSchedule)
        .refreshable {
            if view == "mine" {
                await store.load(.week(from, to))
                await store.load(.openShifts)
            } else {
                await store.load(.teamShifts(from, to))
                await store.load(.teamAttendance(from, to))
            }
        }
        .task(id: "\(view)-\(from)-\(state.features != nil)") {
            if view == "mine", state.features != nil {
                await store.ensure(.week(from, to))
                await store.ensure(.openShifts)
                await store.ensure(.leave)
                await store.ensure(.absences)
            }
            if view == "team" {
                await store.ensure(.teamShifts(from, to))
                await store.ensure(.teamAttendance(from, to))
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

/// The calendar on its own, to jump to another week or day.
struct DayPicker: View {
    let day: String
    let onPick: (String) -> Void
    @State private var date = Date()

    var body: some View {
        DatePicker("", selection: $date, displayedComponents: .date)
            .datePickerStyle(.graphical)
            .labelsHidden()
            .padding()
            .presentationDetents([.medium])
            .onAppear { date = HRDays.parse(day) ?? Date() }
            .onChange(of: date) { _, picked in
                let iso = HRDays.string(picked)
                if iso != day { onPick(iso) }
            }
    }
}

/// Open shifts HR posted, soonest first; nothing while there are none.
private struct OpenShiftsSection: View {
    let workspace: String
    @Environment(HRStore.self) private var store
    @Environment(HRNavigator.self) private var nav
    @State private var expanded = false

    var body: some View {
        let shifts = OpenShiftRules.listable(store.openShifts.data ?? [], now: nowMillis())
        if !shifts.isEmpty {
            Section {
                ForEach(expanded ? shifts : Array(shifts.prefix(3))) { shift in
                    let standing = OpenShiftRules.standingOf(shift)
                    let place = [Fmt.day(HRDays.dayOf(shift.startsAt)), shift.workType, shift.companyName ?? workspace].compactMap { $0 }.joined(separator: " · ")
                    let note = standing == .declined ? shift.myRequest?.reviewNote : nil
                    Button { nav.open(.openShift(shift.id)) } label: {
                        HRRow(
                            title: Fmt.timeRange(shift.startsAt, shift.endsAt),
                            subtitle: note.map { "\(place)\n\(HRStrings.openShiftsReviewNote(note: $0))" } ?? place,
                            subtitleLines: 2,
                            detail: spotsText(shift.spotsLeft),
                            tag: standingTag(standing)
                        ) { ShiftBar(client: shift.companyName) }
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("open-shift-\(shift.id)")
                }
                if shifts.count > 3 {
                    Button(expanded ? HRStrings.openShiftsShowLess : HRStrings.openShiftsShowAll(count: shifts.count)) { expanded.toggle() }
                        .font(.inter(.subheadline, weight: .medium))
                        .foregroundStyle(Tokens.Palette.primary)
                        .accessibilityIdentifier("open-shifts-toggle")
                }
            } header: {
                GroupHead(title: HRStrings.openShiftsTitle, count: shifts.count)
            }
        }
    }
}

/// One day of My week.
private struct MyDay: Identifiable {
    let day: String
    let shifts: [HRShift]
    let loose: [HRClockRecord]
    let asked: [HRShiftRequest]
    let away: [HRLeaveRequest]
    let ill: [HRAbsence]
    let planned: Int
    let records: [HRClockRecord]

    var id: String { day }
}

/// My week, as a timesheet: each day with its hours and pay (planned, for days to come).
private struct MyWeek: View {
    let data: HRAttendance
    let from: String
    let to: String
    let workspace: String
    @Environment(HRStore.self) private var store
    @Environment(HRNavigator.self) private var nav
    @State private var now = nowMillis()

    var body: some View {
        let today = HRDays.today()
        let records = ShiftMath.byClockIn(data.records.filter { $0.date >= from && $0.date <= to })
        let shifts = data.shifts.filter { HRDays.dayOf($0.startsAt) >= from && HRDays.dayOf($0.startsAt) <= to }.sorted { $0.startsAt < $1.startsAt }
        let days = Self.days(data: data, records: records, shifts: shifts, from: from, to: to, today: today, leave: store.leave.data?.requests ?? [], absences: store.absences.data, now: now)
        let currency = records.first { $0.currency != nil }?.currency ?? ShiftMath.defaultCurrency
        let minutes = { (list: [HRClockRecord]) in list.reduce(0) { $0 + ShiftMath.minutesOf($1, now: now) } }
        let running = records.contains(where: ShiftMath.isOpen)
        Group {
            if days.isEmpty {
                HREmpty(HRStrings.scheduleNoShifts, description: HRStrings.scheduleNoShiftsDescription, symbol: "calendar")
                    .task(id: running) { await tick(running) }
            } else {
                ForEach(days) { group in
                    Section {
                        ForEach(group.shifts) { shift in MyShiftRow(shift: shift, worked: onShift(records, shifts)[shift.id] ?? [], now: now, workspace: workspace) }
                        ForEach(group.loose) { record in LooseRow(record: record, now: now, workspace: workspace) }
                        ForEach(group.asked) { request in
                            Button { nav.open(.shiftRequest(id: request.id, day: HRDays.dayOf(request.startsAt))) } label: {
                                HRRow(
                                    title: Fmt.timeRange(request.startsAt, request.endsAt),
                                    subtitle: [Fmt.hm(Double(ShiftMath.minutesBetween(request.startsAt, request.endsAt))), request.workType].compactMap { $0 }.joined(separator: " · "),
                                    tag: .status(request.status, Labels.shiftRequestStatus(request.status))
                                ) { ShiftBar(client: nil) }
                            }
                            .accessibilityIdentifier("shift-request-\(request.id)")
                        }
                        ForEach(group.away) { request in
                            Button { nav.open(.leave(request.id)) } label: {
                                HRRow(
                                    title: request.leaveTypeName ?? HRStrings.absenceLeave,
                                    subtitle: "\(Fmt.span(request.startDate, request.endDate)) · \(HRStrings.scheduleHoursOff(hours: Fmt.hm(LeaveRules.minutesOff(request, planned: group.planned))))",
                                    dot: HRDot(color: request.leaveTypeColor),
                                    tag: .status(request.status, Labels.leaveStatus(request.status))
                                )
                            }
                        }
                        ForEach(group.ill) { absence in
                            Button { nav.open(.sickReport(absence.id)) } label: {
                                HRRow(
                                    title: HRStrings.absenceSick,
                                    subtitle: group.day == absence.startDate && absence.firstDay == "half" ? HRStrings.sickHalfDay : HRStrings.sickFullDay,
                                    tag: .status(absence.status, Labels.absenceStatus(absence.status))
                                )
                            }
                        }
                    } header: {
                        DayHead(day: group.day, figure: figure(group, today: today, currency: currency, minutes: minutes))
                    }
                }
                Section {
                    let planned = shifts.reduce(0) { $0 + ShiftMath.plannedMinutes($1) }
                    let worked = ShiftMath.duration(minutes(records))
                    let total = planned > 0 ? HRStrings.scheduleWorkedOfPlanned(worked: worked, planned: ShiftMath.duration(Double(planned))) : worked
                    LabeledContent(HRStrings.commonTotal, value: "\(total) · \(Fmt.earnings(ShiftMath.earnings(records, now: now, fallback: currency)))")
                }
                .task(id: running) { await tick(running) }
            }
        }
        .buttonStyle(.plain)
    }

    /// The page's one clock: every second while clocked in, else every half minute.
    private func tick(_ running: Bool) async {
        while !Task.isCancelled {
            now = nowMillis()
            try? await Task.sleep(for: .seconds(running ? 1 : 30))
        }
    }

    private func onShift(_ records: [HRClockRecord], _ shifts: [HRShift]) -> [String: [HRClockRecord]] {
        var result: [String: [HRClockRecord]] = [:]
        for record in records {
            if let shift = ShiftMath.shiftOf(record, shifts: shifts, now: now) { result[shift.id, default: []].append(record) }
        }
        return result
    }

    private func figure(_ group: MyDay, today: String, currency: String, minutes: ([HRClockRecord]) -> Double) -> String? {
        if group.day <= today {
            return "\(ShiftMath.duration(minutes(group.records))) | \(Fmt.earnings(ShiftMath.earnings(group.records, now: now, fallback: currency)))"
        }
        return group.planned > 0 ? HRStrings.schedulePlanned(hours: ShiftMath.duration(Double(group.planned))) : nil
    }

    private static func days(
        data: HRAttendance,
        records: [HRClockRecord],
        shifts: [HRShift],
        from: String,
        to: String,
        today: String,
        leave: [HRLeaveRequest],
        absences: HRAbsences?,
        now: Double
    ) -> [MyDay] {
        let asked = data.requests.filter { HRDays.dayOf($0.startsAt) >= from && HRDays.dayOf($0.startsAt) <= to }.sorted { $0.startsAt < $1.startsAt }
        let requests = leave.filter { ($0.status == "approved" || $0.status == "pending") && $0.startDate <= to && $0.endDate >= from }
        let sick = ([absences?.current].compactMap { $0 } + (absences?.history ?? [])).filter { $0.startDate <= to && ($0.endDate ?? today) >= from }
        let loose = records.filter { ShiftMath.shiftOf($0, shifts: shifts, now: now) == nil }
        return (0 ..< 7).map { HRDays.add(from, $0) }.map { day in
            let dayShifts = shifts.filter { HRDays.dayOf($0.startsAt) == day }
            return MyDay(
                day: day,
                shifts: dayShifts,
                loose: loose.filter { $0.date == day },
                asked: asked.filter { HRDays.dayOf($0.startsAt) == day },
                // Leave over several days skips the weekend, the way it is counted.
                away: requests.filter { $0.startDate <= day && $0.endDate >= day && ($0.startDate == $0.endDate || !HRDays.isWeekend(day)) },
                ill: sick.filter { $0.startDate <= day && ($0.endDate ?? today) >= day && day <= today },
                planned: dayShifts.reduce(0) { $0 + ShiftMath.plannedMinutes($1) },
                records: records.filter { $0.date == day }
            )
        }
        .filter { $0.shifts.count + $0.loose.count + $0.asked.count + $0.away.count + $0.ill.count > 0 }
    }
}

/// A shift: the hours planned, and what was clocked on it or that nothing was.
private struct MyShiftRow: View {
    let shift: HRShift
    let worked: [HRClockRecord]
    let now: Double
    let workspace: String
    @Environment(HRNavigator.self) private var nav

    var body: some View {
        Button { nav.open(.shift(id: shift.id, day: HRDays.dayOf(shift.startsAt))) } label: { row }
            .accessibilityIdentifier("shift-\(shift.id)")
    }

    @ViewBuilder
    private var row: some View {
        let started = (WeldDate.parse(shift.startsAt)?.timeIntervalSince1970 ?? 0) * 1000 <= now
        if let openSince = worked.first(where: ShiftMath.isOpen)?.clockIn {
            HRRow(
                title: Fmt.timeRange(shift.startsAt, shift.endsAt),
                subtitle: HRStrings.homeSince(time: Fmt.time(openSince)),
                detail: HRStrings.timesheetClockedIn,
                detailColor: Tokens.Status.success
            ) {
                ShiftBar(client: shift.companyName)
            } value: {
                Running(text: ShiftMath.timer(now - (WeldDate.parse(openSince)?.timeIntervalSince1970 ?? 0) * 1000))
            }
        } else if !worked.isEmpty {
            let approved = worked.allSatisfy(\.approved)
            let clocked = worked.filter { $0.clockIn != nil }
            let range = clocked.isEmpty ? "" : Fmt.timeRange(clocked.first?.clockIn, clocked.last?.clockOut)
            let late = worked.first?.lateMinutes.flatMap { $0 > 0 ? HRStrings.timesheetLate(minutes: String($0)) : nil }
            HRRow(
                title: Fmt.timeRange(shift.startsAt, shift.endsAt),
                subtitle: [HRStrings.scheduleWorked(range: range), late].compactMap { $0 }.joined(separator: " · "),
                value: Fmt.hm(worked.reduce(0) { $0 + ShiftMath.minutesOf($1, now: now) }),
                tag: approvalTag(approved)
            ) { ShiftBar(client: shift.companyName) }
        } else {
            HRRow(
                title: Fmt.timeRange(shift.startsAt, shift.endsAt),
                subtitle: started ? HRStrings.scheduleNotClockedIn : [workspace, shift.companyName ?? shift.notes].compactMap { $0 }.joined(separator: " | "),
                subtitleColor: started ? Tokens.Status.warning : .secondary
            ) { ShiftBar(client: shift.companyName) }
        }
    }
}

/// Hours clocked outside any shift.
private struct LooseRow: View {
    let record: HRClockRecord
    let now: Double
    let workspace: String
    @Environment(HRNavigator.self) private var nav

    var body: some View {
        let since = ShiftMath.isOpen(record) ? record.clockIn : nil
        let late = record.lateMinutes.flatMap { $0 > 0 ? HRStrings.timesheetLate(minutes: String($0)) : nil }
        let place = since.map { HRStrings.homeSince(time: Fmt.time($0)) } ?? [workspace, record.companyName].compactMap { $0 }.joined(separator: " | ")
        Button { nav.open(.shift(id: record.id, day: record.date)) } label: {
            HRRow(
                title: record.clockIn != nil ? Fmt.timeRange(record.clockIn, record.clockOut) : Labels.attendanceStatus(record.status),
                subtitle: [place, HRStrings.scheduleWithoutShift, late].compactMap { $0 }.joined(separator: " · "),
                detail: since != nil ? HRStrings.timesheetClockedIn : nil,
                detailColor: Tokens.Status.success,
                tag: since == nil ? approvalTag(record.approved) : nil
            ) {
                ShiftBar(client: record.companyName)
            } value: {
                if let since {
                    Running(text: ShiftMath.timer(now - (WeldDate.parse(since)?.timeIntervalSince1970 ?? 0) * 1000))
                } else {
                    Text(Fmt.hm(ShiftMath.minutesOf(record, now: now))).font(.inter(.subheadline))
                }
            }
        }
        .accessibilityIdentifier("record-\(record.id)")
    }
}

/// Everyone's week: each shift with whether its person clocked in, and hours without a shift.
private struct TeamWeek: View {
    let shifts: [HRShift]
    let records: [HRClockRecord]
    let from: String
    let to: String
    @State private var now = nowMillis()

    var body: some View {
        let week = ShiftMath.byClockIn(records.filter { $0.date >= from && $0.date <= to })
        let planned = shifts.filter { HRDays.dayOf($0.startsAt) >= from && HRDays.dayOf($0.startsAt) <= to }
            .sorted { ($0.startsAt, $0.employeeName ?? "") < ($1.startsAt, $1.employeeName ?? "") }
        var onShift: [String: [HRClockRecord]] = [:]
        var loose: [HRClockRecord] = []
        for record in week {
            if let shift = ShiftMath.shiftOf(record, shifts: planned.filter { $0.employeeId == record.employeeId }, now: now) {
                onShift[shift.id, default: []].append(record)
            } else {
                loose.append(record)
            }
        }
        let running = week.contains(where: ShiftMath.isOpen)
        let days = (0 ..< 7).map { HRDays.add(from, $0) }.filter { day in
            planned.contains { HRDays.dayOf($0.startsAt) == day } || loose.contains { $0.date == day }
        }
        return Group {
            if days.isEmpty {
                HREmpty(HRStrings.scheduleNoTeamShifts, symbol: "calendar")
                    .task(id: running) { await tick(running) }
            } else {
                ForEach(days, id: \.self) { day in
                    let dayShifts = planned.filter { HRDays.dayOf($0.startsAt) == day }
                    let dayLoose = loose.filter { $0.date == day }
                    Section {
                        ForEach(dayShifts) { shift in teamShiftRow(shift, worked: onShift[shift.id] ?? []) }
                        ForEach(dayLoose) { record in teamLooseRow(record) }
                    } header: {
                        DayHead(day: day, count: dayShifts.count + dayLoose.count)
                    }
                }
                Section {
                    let plannedWeek = planned.reduce(0) { $0 + ShiftMath.plannedMinutes($1) }
                    let worked = ShiftMath.duration(week.reduce(0) { $0 + ShiftMath.minutesOf($1, now: now) })
                    LabeledContent(
                        HRStrings.commonTotal,
                        value: plannedWeek > 0 ? HRStrings.scheduleWorkedOfPlanned(worked: worked, planned: ShiftMath.duration(Double(plannedWeek))) : worked
                    )
                }
                .task(id: running) { await tick(running) }
            }
        }
    }

    private func tick(_ running: Bool) async {
        while !Task.isCancelled {
            now = nowMillis()
            try? await Task.sleep(for: .seconds(running ? 1 : 30))
        }
    }

    @ViewBuilder
    private func teamShiftRow(_ shift: HRShift, worked: [HRClockRecord]) -> some View {
        let openSince = worked.first(where: ShiftMath.isOpen)?.clockIn
        let started = (WeldDate.parse(shift.startsAt)?.timeIntervalSince1970 ?? 0) * 1000 <= now
        let clocked = worked.filter { $0.clockIn != nil }
        let detail: String? = openSince != nil ? HRStrings.timesheetClockedIn
            : (!worked.isEmpty ? (clocked.isEmpty ? nil : Fmt.timeRange(clocked.first?.clockIn, clocked.last?.clockOut))
                : (started ? HRStrings.scheduleNotClockedIn : nil))
        let detailColor: Color = openSince != nil ? Tokens.Status.success : (worked.isEmpty && started ? Tokens.Status.warning : .secondary)
        HRRow(
            title: shift.employeeName ?? "",
            subtitle: [Fmt.timeRange(shift.startsAt, shift.endsAt), shift.workType ?? shift.companyName].compactMap { $0 }.joined(separator: " • "),
            detail: detail,
            detailColor: detailColor
        ) {
            HStack(spacing: Tokens.Spacing.s) {
                ShiftBar(client: shift.companyName)
                PersonAvatar(name: shift.employeeName, size: 32)
            }
        } value: {
            if let openSince {
                Running(text: ShiftMath.timer(now - (WeldDate.parse(openSince)?.timeIntervalSince1970 ?? 0) * 1000))
            } else if !worked.isEmpty {
                Text(Fmt.hm(worked.reduce(0) { $0 + ShiftMath.minutesOf($1, now: now) })).font(.inter(.subheadline))
            }
        }
        .accessibilityIdentifier("team-shift-\(shift.id)")
    }

    private func teamLooseRow(_ record: HRClockRecord) -> some View {
        let since = ShiftMath.isOpen(record) ? record.clockIn : nil
        return HRRow(
            title: record.employeeName ?? "",
            subtitle: [record.clockIn != nil ? Fmt.timeRange(record.clockIn, record.clockOut) : Labels.attendanceStatus(record.status), HRStrings.scheduleWithoutShift].joined(separator: " • "),
            detail: since != nil ? HRStrings.timesheetClockedIn : nil,
            detailColor: since != nil ? Tokens.Status.success : .secondary
        ) {
            PersonAvatar(name: record.employeeName, size: 32)
        } value: {
            if let since {
                Running(text: ShiftMath.timer(now - (WeldDate.parse(since)?.timeIntervalSince1970 ?? 0) * 1000))
            } else {
                Text(Fmt.hm(ShiftMath.minutesOf(record, now: now))).font(.inter(.subheadline))
            }
        }
    }
}
