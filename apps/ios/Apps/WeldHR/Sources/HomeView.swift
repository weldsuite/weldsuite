import SwiftUI
import UIKit
import WeldCore
import WeldUI

/// Home, as the platform's My HR overview: who you are at the top (tap for the
/// profile), the next shift with the clock button, the upcoming shifts, the
/// leave balances, this year's absences and what waits for you.
struct HomeView: View {
    let workspace: WorkspaceRef
    @Environment(HRStore.self) private var store
    @Environment(HRNavigator.self) private var nav

    var body: some View {
        let state = SelfState.of(me: store.me, access: store.access)
        List {
            Section {
                // The record's header, as the platform's: your avatar and name, the job title under it.
                Button { nav.open(.profile) } label: {
                    HStack(spacing: Tokens.Spacing.m) {
                        PersonAvatar(name: state.profile?.displayName ?? workspace.name, url: state.profile?.avatarUrl, size: 32)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(state.profile?.displayName ?? workspace.name).font(.inter(size: 15, weight: .medium)).foregroundStyle(.primary).lineLimit(1)
                            Text(state.profile?.jobTitle ?? HRStrings.homeProfileAndSettings).font(.inter(.caption)).foregroundStyle(.secondary).lineLimit(1)
                        }
                        Spacer()
                        Image(systemName: "chevron.right").foregroundStyle(.tertiary)
                    }
                }
                .accessibilityIdentifier("home-workspace")
            }
            SelfGate(state: state, retry: { await store.load(.me) }) { _, features in
                QueryBody(state: store.overview, retry: { await store.load(.overview) }) { overview in
                    HomeBody(overview: overview, features: features, workspace: workspace.name)
                }
            }
        }
        .listStyle(.plain)
        .navigationTitle(workspace.name)
        .refreshable {
            await store.load(.me)
            await store.load(.access)
            await store.invalidate()
        }
        .task(id: state.features != nil) {
            guard state.features != nil else { return }
            await store.ensure(.overview)
            await store.ensure(.leave)
            await store.ensure(.absences)
        }
    }
}

private struct HomeBody: View {
    let overview: HROverview
    let features: HRFeatures
    let workspace: String
    @Environment(HRNavigator.self) private var nav
    @State private var now = nowMillis()

    var body: some View {
        content.buttonStyle(.plain)
    }

    @ViewBuilder
    private var content: some View {
            let today = HRDays.today()
            let shifts = overview.upcomingShifts
                .filter { (WeldDate.parse($0.endsAt)?.timeIntervalSince1970 ?? 0) * 1000 >= now }
                .sorted { $0.startsAt < $1.startsAt }
            let next = shifts.first
            let onShift = overview.clockShiftId.flatMap { id in overview.upcomingShifts.first { $0.id == id } }
            let switchable = shifts.filter { $0.id != overview.clockShiftId && HRDays.dayOf($0.startsAt) <= today }
            Group {
                if features.selfClockIn || next != nil || overview.clockedIn {
                    Section {
                        ShiftHero(overview: overview, next: next, onShift: onShift, switchable: switchable, features: features, now: now)
                    }
                }
                Section {
                    if shifts.isEmpty {
                        Button { nav.tab = .schedule } label: {
                            HRRow(title: HRStrings.homeNoShifts, muted: true)
                        }
                    } else {
                        ForEach(shifts.prefix(3)) { shift in
                            Button { nav.open(.shift(id: shift.id, day: HRDays.dayOf(shift.startsAt))) } label: {
                                ShiftRowView(startsAt: shift.startsAt, endsAt: shift.endsAt, client: shift.companyName)
                            }
                            .accessibilityIdentifier("home-shift-\(shift.id)")
                        }
                    }
                } header: {
                    GroupHead(title: HRStrings.homeMySchedule, count: shifts.isEmpty ? nil : shifts.count)
                }
                .task(id: overview.clockedIn) {
                    // The page's one clock: the running time, and which shifts are still to come.
                    while !Task.isCancelled {
                        now = nowMillis()
                        try? await Task.sleep(for: .seconds(overview.clockedIn ? 1 : 30))
                    }
                }
                LeaveBalancesSection()
                MyAbsencesSection(canRequest: features.leaveRequests)
                ToDoSection(overview: overview)
            }
    }
}

/// A shift on Home and in the switch sheet, as the platform's Upcoming shifts:
/// the day, its hours under it, and the client on the right.
struct ShiftRowView: View {
    let startsAt: String
    let endsAt: String
    let client: String?

    var body: some View {
        HRRow(title: Fmt.day(HRDays.dayOf(startsAt)), subtitle: Fmt.timeRange(startsAt, endsAt), detail: client)
    }
}

/// The next shift with the clock button; while clocked in, how long, since
/// when, the shift it is on, and Switch shift next to Clock out.
private struct ShiftHero: View {
    let overview: HROverview
    let next: HRUpcomingShift?
    let onShift: HRUpcomingShift?
    let switchable: [HRUpcomingShift]
    let features: HRFeatures
    let now: Double
    @Environment(HRStore.self) private var store
    @Environment(Toaster.self) private var toaster
    @State private var working = false
    @State private var switching = false
    @State private var denied = false
    @State private var locator: ClockLocator?

    var body: some View {
        let since = WeldDate.parse(overview.since).map { $0.timeIntervalSince1970 * 1000 }
        let running = overview.clockedIn && since != nil
        let shown = running ? onShift : next
        VStack(alignment: .leading, spacing: Tokens.Spacing.l) {
            HStack(alignment: .top, spacing: Tokens.Spacing.m) {
                // The shift's client colour, as the platform's schedule; the border colour without a shift.
                RoundedRectangle(cornerRadius: 2)
                    .fill(shown.map { Color(hrRGB: Swatches.shiftColor($0.companyName)) } ?? Tokens.Palette.border)
                    .frame(width: 4)
                VStack(alignment: .leading, spacing: 2) {
                    HStack {
                        Text(title(since: since)).font(.inter(.title3)).monospacedDigit().lineLimit(1)
                            .accessibilityIdentifier("home-hero-title")
                        Spacer()
                        if running {
                            Label(HRStrings.homeSince(time: Fmt.time(overview.since)), systemImage: "clock").font(.inter(.subheadline)).foregroundStyle(.secondary)
                        }
                    }
                    ForEach(lines(running: running), id: \.self) { line in
                        Text(line).font(.inter(.subheadline)).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            if features.selfClockIn || overview.clockedIn {
                HStack {
                    // As the platform's clock button: Clock in in the primary colour, Clock out destructive.
                    Button { clock(overview.clockedIn ? "out" : "in") } label: {
                        Group {
                            if working && !switching { ProgressView() } else {
                                Label(
                                    overview.clockedIn ? HRStrings.homeClockOut : HRStrings.homeClockIn,
                                    systemImage: overview.clockedIn ? "rectangle.portrait.and.arrow.right" : "arrow.right.to.line"
                                )
                            }
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(overview.clockedIn ? Tokens.Status.danger : Tokens.Palette.primary)
                    .controlSize(.large)
                    .disabled(working)
                    .accessibilityIdentifier("home-clock")
                    if overview.clockedIn && features.selfClockIn {
                        Button(HRStrings.homeSwitchShift) { switching = true }
                            .buttonStyle(.bordered)
                            .tint(Tokens.Palette.foreground)
                            .controlSize(.large)
                            .disabled(working)
                            .accessibilityIdentifier("home-switch-shift")
                    }
                }
                if features.clockInRequiresLocation {
                    Label(HRStrings.locationRequired, systemImage: "mappin").font(.inter(.footnote)).foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, Tokens.Spacing.s)
        .sheet(isPresented: $switching) {
            NavigationStack {
                List {
                    Section {
                        Text(HRStrings.homeSwitchHint).font(.inter(.subheadline)).foregroundStyle(.secondary)
                    }
                    Section {
                        if switchable.isEmpty {
                            HRRow(title: HRStrings.homeNoOtherShifts, muted: true)
                        }
                        ForEach(switchable) { shift in
                            Button { clock("switch", shiftId: shift.id) } label: {
                                ShiftRowView(startsAt: shift.startsAt, endsAt: shift.endsAt, client: shift.companyName)
                            }
                            .buttonStyle(.plain)
                            .disabled(working)
                            .accessibilityIdentifier("switch-\(shift.id)")
                        }
                    }
                    if working { ProgressView().frame(maxWidth: .infinity) }
                }
                .navigationTitle(HRStrings.homeSwitchShift)
                .navigationBarTitleDisplayMode(.inline)
            }
            .presentationDetents([.medium])
        }
        .alert(HRStrings.locationDeniedTitle, isPresented: $denied) {
            Button(HRStrings.locationOpenSettings) {
                if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
            }
            Button(CoreStrings.commonClose, role: .cancel) {}
        } message: {
            Text(HRStrings.locationDeniedMessage)
        }
    }

    private func title(since: Double?) -> String {
        if overview.clockedIn, let since { return ShiftMath.timer(now - since) }
        if let next { return Fmt.timeRange(next.startsAt, next.endsAt) }
        return HRStrings.homeNoShiftToday
    }

    /// Clocked in: the shift it is on. Else which day (when not today) and the client; with no shift, today.
    private func lines(running: Bool) -> [String] {
        func client(_ shift: HRUpcomingShift) -> String? {
            guard let name = shift.companyName, !name.isEmpty else { return nil }
            return name
        }
        if running {
            guard let onShift else { return [HRStrings.homeNoShiftToday] }
            return [Fmt.timeRange(onShift.startsAt, onShift.endsAt), client(onShift)].compactMap { $0 }
        }
        guard let next else { return [Fmt.longDay(HRDays.today())] }
        let today = HRDays.today()
        let day = HRDays.dayOf(next.startsAt)
        let when: String? = day == today ? nil : (day == HRDays.add(today, 1) ? CoreStrings.commonTomorrow : Fmt.day(day))
        let line = [when, client(next)].compactMap { $0 }.joined(separator: " · ")
        return line.isEmpty ? [] : [line]
    }

    /// Clock in, out or to another shift; with the phone's position where the workspace requires it.
    private func clock(_ action: String, shiftId: String? = nil) {
        working = true
        Task {
            defer { working = false }
            var fix: HRGeoFix?
            if features.clockInRequiresLocation {
                let locator = ClockLocator()
                self.locator = locator
                switch await locator.locate() {
                case let .found(found): fix = found
                case .denied:
                    denied = true
                    return
                case .unavailable:
                    toaster.show(HRStrings.locationUnavailable)
                    return
                }
            }
            let success: String
            switch action {
            case "in": success = HRStrings.homeClockedIn
            case "out": success = HRStrings.homeClockedOut
            default: success = HRStrings.homeSwitched
            }
            let done = await runWrite(toaster, success: success) {
                try await store.clock(action: action, shiftId: shiftId, fix: fix)
            }
            if done { switching = false }
        }
    }
}

/// The leave balances, as the platform overview's: a leave type's colour dot
/// and name, used / pending / allowance under it, what is left on the right.
private struct LeaveBalancesSection: View {
    @Environment(HRStore.self) private var store
    @Environment(HRNavigator.self) private var nav

    var body: some View {
        let balances = store.leave.data?.balances ?? []
        if !balances.isEmpty {
            Section {
                ForEach(balances) { balance in
                    Button { nav.tab = .absence } label: { BalanceRowView(balance: balance) }
                        .accessibilityIdentifier("balance-\(balance.leaveTypeId)")
                }
            } header: {
                GroupHead(title: HRStrings.absenceBalances, count: balances.count)
            }
        }
    }
}

/// A leave type's balance: its dot and name, used / pending / allowance, and what is left.
struct BalanceRowView: View {
    let balance: HRLeaveBalance

    var body: some View {
        let allowance = balance.allowance.map(Fmt.days) ?? HRStrings.balanceUnlimited
        HRRow(
            title: balance.name,
            subtitle: [
                HRStrings.balanceUsed(days: Fmt.days(balance.used)),
                HRStrings.balancePending(days: Fmt.days(balance.pending)),
                HRStrings.balanceAllowance(days: allowance),
            ].joined(separator: " · "),
            subtitleLines: 2,
            dot: HRDot(color: balance.color)
        ) {
            EmptyView()
        } value: {
            Text(balance.remaining.map(Fmt.daysText) ?? HRStrings.balanceUnlimited).font(.inter(.subheadline, weight: .medium)).monospacedDigit()
        }
    }
}

/// This year's open sick report and the next leave, or a row to add some.
private struct MyAbsencesSection: View {
    let canRequest: Bool
    @Environment(HRStore.self) private var store
    @Environment(HRNavigator.self) private var nav

    var body: some View {
        let today = HRDays.today()
        let year = String(today.prefix(4))
        let current = store.absences.data?.current
        let upcoming = (store.leave.data?.requests ?? [])
            .filter { ($0.status == "approved" || $0.status == "pending") && $0.endDate >= today && $0.startDate.hasPrefix(year) }
            .sorted { $0.startDate < $1.startDate }
            .prefix(3)
        Section {
            if let current {
                Button { nav.open(.sickReport(current.id)) } label: { SickRowView(absence: current) }
            }
            ForEach(Array(upcoming)) { request in
                Button { nav.open(.leave(request.id)) } label: { LeaveRowView(request: request) }
            }
            if current == nil && upcoming.isEmpty {
                Button { if canRequest { nav.present(.leave) } } label: {
                    HRRow(title: HRStrings.homeNoAbsences, muted: true) {
                        EmptyView()
                    } value: {
                        if canRequest { Text(HRStrings.homeAddAbsence).font(.inter(.subheadline, weight: .medium)).foregroundStyle(Tokens.Palette.primary) }
                    }
                }
                .disabled(!canRequest)
                .accessibilityIdentifier("home-add-absence")
            }
        } header: {
            GroupHead(title: HRStrings.homeMyAbsences(year: year))
        }
    }
}

/// What waits for you, as the platform overview's Details rows: open tasks and
/// what to confirm always, unread announcements and open shifts when there are
/// some. A value links to the page behind it.
private struct ToDoSection: View {
    let overview: HROverview
    @Environment(HRNavigator.self) private var nav

    var body: some View {
        Section {
            Button { nav.open(.tasks) } label: {
                HomeFact(symbol: "checklist", label: HRStrings.homeOpenTasksLabel, value: String(overview.openTasks))
            }
            .accessibilityIdentifier("home-tasks")
            Button { nav.open(.reviews) } label: {
                HomeFact(
                    symbol: "text.bubble",
                    label: HRStrings.homeToConfirm,
                    value: overview.toAcknowledge > 0 ? HRStrings.homeToAcknowledge(overview.toAcknowledge) : HRStrings.homeNothingToConfirm,
                    link: overview.toAcknowledge > 0
                )
            }
            .accessibilityIdentifier("home-reviews")
            // The latest evaluation's coloured score with its form and date, and the milestones, as on the platform.
            Button { nav.open(.reviews) } label: {
                HomeFactRow(symbol: "star", label: HRStrings.homeEvaluation) {
                    if let evaluation = overview.latestEvaluation {
                        if let score = evaluation.overallScore { ScoreBadge(score: score) }
                        let about = [evaluation.formName, evaluation.submittedAt.map(Fmt.date)].compactMap { $0 }.joined(separator: " · ")
                        if !about.isEmpty { Text(about).font(.inter(.subheadline)).foregroundStyle(.secondary).lineLimit(1) }
                    } else {
                        Text(HRStrings.homeNoEvaluation).font(.inter(.subheadline)).foregroundStyle(.secondary)
                    }
                }
            }
            .accessibilityIdentifier("home-evaluation")
            if let milestones = overview.milestones {
                Button { nav.open(.reviews) } label: {
                    HomeFactRow(symbol: "flag", label: HRStrings.homeMilestones) {
                        Text(HRStrings.homeMilestonesValue(achieved: String(milestones.achieved), total: String(milestones.achieved + milestones.open)))
                            .font(.inter(.subheadline))
                            .foregroundStyle(Tokens.Palette.primary)
                        if milestones.open > 0 {
                            Text(HRStrings.homeMilestonesOpen(open: String(milestones.open))).font(.inter(.subheadline)).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                }
                .accessibilityIdentifier("home-milestones")
            }
            if overview.unreadAnnouncements > 0 {
                Button { nav.tab = .announcements } label: {
                    HomeFact(symbol: "newspaper", label: HRStrings.announcementsTitle, value: HRStrings.homeUnreadAnnouncements(overview.unreadAnnouncements))
                }
                .accessibilityIdentifier("home-announcements")
            }
            if overview.openShifts > 0 {
                Button { nav.tab = .schedule } label: {
                    HomeFact(symbol: "calendar.badge.plus", label: HRStrings.openShiftsTitle, value: HRStrings.homeOpenShiftsToSignUp(overview.openShifts))
                }
                .accessibilityIdentifier("home-open-shifts")
            }
        } header: {
            GroupHead(title: HRStrings.homeToDo)
        }
    }
}

/// One of the overview's property rows: a muted icon and label, the value as a link to the page behind it.
private struct HomeFact: View {
    let symbol: String
    let label: String
    let value: String
    var link = true

    var body: some View {
        HomeFactRow(symbol: symbol, label: label) {
            Text(value).font(.inter(.subheadline)).foregroundStyle(link ? Tokens.Palette.primary : Tokens.Palette.mutedForeground)
        }
    }
}

/// A property row with any value: a muted icon and label, then the content.
private struct HomeFactRow<Content: View>: View {
    let symbol: String
    let label: String
    @ViewBuilder let content: () -> Content

    var body: some View {
        HStack(spacing: Tokens.Spacing.s) {
            Image(systemName: symbol).font(.system(size: 14)).foregroundStyle(.secondary).frame(width: 18)
            Text(label).font(.inter(.subheadline)).foregroundStyle(.secondary).frame(width: 128, alignment: .leading)
            content()
            Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
    }
}

/// A leave request of the member's own, as the platform's Leave list: the
/// type's colour dot and name, the dates and days under it, the status badge.
struct LeaveRowView: View {
    let request: HRLeaveRequest

    var body: some View {
        let period = "\(Fmt.dateRange(request.startDate, request.endDate)) · \(Fmt.daysText(request.days))"
        HRRow(
            title: request.leaveTypeName ?? HRStrings.absenceLeave,
            subtitle: request.reviewNote.map { "\(period)\n\(HRStrings.timeOffReviewNoteAnonymous(note: $0))" } ?? period,
            subtitleLines: 3,
            dot: HRDot(color: request.leaveTypeColor),
            tag: .status(request.status, Labels.leaveStatus(request.status))
        )
        .accessibilityIdentifier("leave-\(request.id)")
    }
}

/// A sick report, as the platform's Sick reports list: the first sick day, the
/// last one (or "still sick") and the days under it, Sick or Recovered.
struct SickRowView: View {
    let absence: HRAbsence

    var body: some View {
        let first = absence.firstDay == "half" ? "\(Fmt.date(absence.startDate)) · \(HRStrings.sickHalfDay)" : Fmt.date(absence.startDate)
        let last = absence.endDate.map(Fmt.date) ?? HRStrings.sickDetailStillSick
        HRRow(
            title: first,
            subtitle: "\(last) · \(Fmt.daysText(absence.days))",
            tag: .status(absence.status, Labels.absenceStatus(absence.status))
        )
        .accessibilityIdentifier("sick-\(absence.id)")
    }
}
