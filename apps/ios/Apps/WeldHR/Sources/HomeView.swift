import SwiftUI
import UIKit
import WeldCore
import WeldUI

/// Home: the workspace at the top (tap for the profile), the next shift with
/// the clock button right on the page, then My schedule, My absences and
/// what is waiting to be done.
struct HomeView: View {
    let workspace: WorkspaceRef
    @Environment(HRStore.self) private var store
    @Environment(HRNavigator.self) private var nav

    var body: some View {
        let state = SelfState.of(me: store.me, access: store.access)
        List {
            Section {
                Button { nav.open(.profile) } label: {
                    HStack(spacing: Tokens.Spacing.m) {
                        PersonAvatar(name: workspace.name, size: 32)
                        VStack(alignment: .leading) {
                            Text(workspace.name).font(.headline).foregroundStyle(.primary)
                            Text(HRStrings.homeProfileAndSettings).font(.footnote).foregroundStyle(.secondary)
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
        .navigationTitle(HRStrings.tabsHome)
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
                        ShiftHero(overview: overview, next: next, onShift: onShift, switchable: switchable, features: features, workspace: workspace, now: now)
                    }
                }
                Section(HRStrings.homeMySchedule) {
                    if shifts.isEmpty {
                        Button { nav.tab = .schedule } label: {
                            HRRow(title: HRStrings.homeNoShifts, muted: true) { IconTile(symbol: "clock") }
                        }
                    } else {
                        ForEach(shifts.prefix(3)) { shift in
                            Button { nav.open(.shift(id: shift.id, day: HRDays.dayOf(shift.startsAt))) } label: {
                                ShiftRowView(startsAt: shift.startsAt, endsAt: shift.endsAt, place: shift.companyName, workspace: workspace)
                            }
                            .accessibilityIdentifier("home-shift-\(shift.id)")
                        }
                    }
                }
                .task(id: overview.clockedIn) {
                    // The page's one clock: the running time, and which shifts are still to come.
                    while !Task.isCancelled {
                        now = nowMillis()
                        try? await Task.sleep(for: .seconds(overview.clockedIn ? 1 : 30))
                    }
                }
                MyAbsencesSection(canRequest: features.leaveRequests)
                ToDoSection(overview: overview)
            }
    }
}

/// A shift on Home and in the switch sheet: its day, its hours, and where.
struct ShiftRowView: View {
    let startsAt: String
    let endsAt: String
    let place: String?
    let workspace: String?

    var body: some View {
        HRRow(title: Fmt.timeRange(startsAt, endsAt), subtitle: [place, workspace].compactMap { $0 }.joined(separator: " • ")) {
            HStack(spacing: Tokens.Spacing.s) {
                ShiftBar(key: place ?? workspace)
                DateTile(day: HRDays.dayOf(startsAt))
            }
        }
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
    let workspace: String
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
                RoundedRectangle(cornerRadius: 3)
                    .fill(shown.map { Color(hrRGB: Swatches.shiftColor($0.companyName ?? workspace)) } ?? Color(.systemGray4))
                    .frame(width: 5)
                VStack(alignment: .leading, spacing: 2) {
                    HStack {
                        Text(title(since: since)).font(.title2.weight(.bold)).monospacedDigit().lineLimit(1)
                            .accessibilityIdentifier("home-hero-title")
                        Spacer()
                        if running {
                            Label(HRStrings.homeSince(time: Fmt.time(overview.since)), systemImage: "clock").font(.subheadline).foregroundStyle(.secondary)
                        }
                    }
                    ForEach(lines(running: running), id: \.self) { line in
                        Text(line).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            if features.selfClockIn || overview.clockedIn {
                HStack {
                    Button { clock(overview.clockedIn ? "out" : "in") } label: {
                        Group {
                            if working && !switching { ProgressView() } else {
                                Text(overview.clockedIn ? HRStrings.homeClockOut : HRStrings.homeClockIn)
                            }
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .disabled(working)
                    .accessibilityIdentifier("home-clock")
                    if overview.clockedIn && features.selfClockIn {
                        Button(HRStrings.homeSwitchShift) { switching = true }
                            .buttonStyle(.bordered)
                            .controlSize(.large)
                            .disabled(working)
                            .accessibilityIdentifier("home-switch-shift")
                    }
                }
                if features.clockInRequiresLocation {
                    Label(HRStrings.locationRequired, systemImage: "mappin").font(.footnote).foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, Tokens.Spacing.s)
        .sheet(isPresented: $switching) {
            NavigationStack {
                List {
                    Section {
                        Text(HRStrings.homeSwitchHint).font(.subheadline).foregroundStyle(.secondary)
                    }
                    Section {
                        if switchable.isEmpty {
                            HRRow(title: HRStrings.homeNoOtherShifts, muted: true) { IconTile(symbol: "clock") }
                        }
                        ForEach(switchable) { shift in
                            Button { clock("switch", shiftId: shift.id) } label: {
                                ShiftRowView(startsAt: shift.startsAt, endsAt: shift.endsAt, place: shift.companyName, workspace: workspace)
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

    /// Clocked in: the shift it is on. Else which day (when not today) and where; with no shift, today.
    private func lines(running: Bool) -> [String] {
        func place(_ shift: HRUpcomingShift) -> String? {
            let text = [workspace, shift.companyName].compactMap { $0 }.joined(separator: " | ")
            return text.isEmpty ? nil : text
        }
        if running {
            guard let onShift else { return [HRStrings.homeNoShiftToday] }
            return [Fmt.timeRange(onShift.startsAt, onShift.endsAt), place(onShift)].compactMap { $0 }
        }
        guard let next else { return [Fmt.longDay(HRDays.today())] }
        let today = HRDays.today()
        let day = HRDays.dayOf(next.startsAt)
        let when: String? = day == today ? nil : (day == HRDays.add(today, 1) ? CoreStrings.commonTomorrow : Fmt.day(day))
        let line = [when, place(next)].compactMap { $0 }.joined(separator: " · ")
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
        Section(HRStrings.homeMyAbsences(year: year)) {
            if let current {
                Button { nav.open(.sickReport(current.id)) } label: { SickRowView(absence: current) }
            }
            ForEach(Array(upcoming)) { request in
                Button { nav.open(.leave(request.id)) } label: { LeaveRowView(request: request) }
            }
            if current == nil && upcoming.isEmpty {
                Button { if canRequest { nav.present(.leave) } } label: {
                    HRRow(title: HRStrings.homeNoAbsences, value: canRequest ? HRStrings.homeAddAbsence : nil, muted: true) {
                        IconTile(symbol: "calendar.badge.plus")
                    }
                }
                .disabled(!canRequest)
                .accessibilityIdentifier("home-add-absence")
            }
        }
    }
}

/// Unread announcements, open shifts, open tasks and reviews to read, when there are any.
private struct ToDoSection: View {
    let overview: HROverview
    @Environment(HRNavigator.self) private var nav

    var body: some View {
        if overview.openTasks > 0 || overview.toAcknowledge > 0 || overview.openShifts > 0 || overview.unreadAnnouncements > 0 {
            Section(HRStrings.homeToDo) {
                if overview.unreadAnnouncements > 0 {
                    Button { nav.tab = .announcements } label: {
                        HRRow(title: HRStrings.announcementsTitle, subtitle: HRStrings.homeUnreadAnnouncements(overview.unreadAnnouncements)) { IconTile(symbol: "megaphone") }
                    }
                    .accessibilityIdentifier("home-announcements")
                }
                if overview.openShifts > 0 {
                    Button { nav.tab = .schedule } label: {
                        HRRow(title: HRStrings.openShiftsTitle, subtitle: HRStrings.homeOpenShiftsToSignUp(overview.openShifts)) { IconTile(symbol: "calendar.badge.plus") }
                    }
                    .accessibilityIdentifier("home-open-shifts")
                }
                if overview.openTasks > 0 {
                    Button { nav.open(.tasks) } label: {
                        HRRow(title: HRStrings.meTasks, subtitle: HRStrings.homeOpenTasks(overview.openTasks)) { IconTile(symbol: "checklist") }
                    }
                    .accessibilityIdentifier("home-tasks")
                }
                if overview.toAcknowledge > 0 {
                    Button { nav.open(.reviews) } label: {
                        HRRow(title: HRStrings.meReviews, subtitle: HRStrings.homeToAcknowledge(overview.toAcknowledge)) { IconTile(symbol: "text.bubble") }
                    }
                    .accessibilityIdentifier("home-reviews")
                }
            }
        }
    }
}

/// A leave request of the member's own, its status in colour.
struct LeaveRowView: View {
    let request: HRLeaveRequest

    var body: some View {
        let status = Labels.leaveStatus(request.status)
        let subtitle = request.reviewNote.map { "\(status) • \(HRStrings.timeOffReviewNoteAnonymous(note: $0))" } ?? status
        HRRow(
            title: request.leaveTypeName ?? HRStrings.absenceLeave,
            subtitle: subtitle,
            subtitleColor: statusColor(request.status),
            subtitleLines: 2,
            value: Fmt.span(request.startDate, request.endDate),
            detail: Fmt.daysText(request.days),
            muted: request.status == "cancelled"
        ) { LeaveTypeTile(color: request.leaveTypeColor) }
            .accessibilityIdentifier("leave-\(request.id)")
    }
}

/// A sick report: running or recovered.
struct SickRowView: View {
    let absence: HRAbsence

    var body: some View {
        let ongoing = absence.status == "ongoing"
        HRRow(
            title: HRStrings.absenceSick,
            subtitle: ongoing ? HRStrings.absenceOngoing : HRStrings.absenceRecovered,
            subtitleColor: ongoing ? Tokens.Status.danger : .secondary,
            value: ongoing || absence.endDate == nil ? "\(Fmt.shortDate(absence.startDate))\(Fmt.range)…" : Fmt.span(absence.startDate, absence.endDate ?? absence.startDate),
            detail: Fmt.daysText(absence.days)
        ) { SickTile() }
            .accessibilityIdentifier("sick-\(absence.id)")
    }
}
