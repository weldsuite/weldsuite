import Observation
import SwiftUI
import WeldCore
import WeldUI

/// A pushed page of a tab.
enum HRRoute: Hashable {
    case profile, pay, tasks, reviews, directory
    case employee(String)
    case shift(id: String, day: String)
    case shiftRequest(id: String, day: String)
    case openShift(String)
    case leave(String)
    case sickReport(String)
    case expense(String)
    case announcement(String)
}

/// A form in a sheet.
enum HRForm: Identifiable, Hashable {
    case leave
    /// `camera` or `library` starts with the receipt.
    case expense(start: String?)
    case sick
    case shift
    case announcement

    var id: String {
        switch self {
        case .leave: "leave"
        case let .expense(start): "expense-\(start ?? "")"
        case .sick: "sick"
        case .shift: "shift"
        case .announcement: "announcement"
        }
    }
}

/// Which tab is up, each tab's pushed pages, and the form in a sheet.
@MainActor
@Observable
final class HRNavigator {
    var tab: HRTab = .home
    var paths: [HRTab: [HRRoute]] = [:]
    var form: HRForm?

    func open(_ route: HRRoute) {
        paths[tab, default: []].append(route)
    }

    func present(_ form: HRForm) {
        self.form = form
    }

    func path(_ tab: HRTab) -> Binding<[HRRoute]> {
        Binding(get: { self.paths[tab] ?? [] }, set: { self.paths[tab] = $0 })
    }

    /// A tapped push or a `weldhr://` link: the tab it belongs to, then its page.
    func follow(_ target: HRTarget) {
        form = nil
        switch target {
        case .announcements: show(.announcements, nil)
        case let .announcement(id): show(.announcements, .announcement(id))
        case let .leave(id): show(.absence, .leave(id))
        case let .expense(id): show(.expenses, .expense(id))
        case let .sickReport(id): show(.absence, .sickReport(id))
        case .schedule: show(.schedule, nil)
        case .absence: show(.absence, nil)
        case .expenses: show(.expenses, nil)
        case .pay: show(.home, .pay)
        case .tasks: show(.home, .tasks)
        case .reviews: show(.home, .reviews)
        }
    }

    private func show(_ tab: HRTab, _ route: HRRoute?) {
        self.tab = tab
        paths[tab] = route.map { [$0] } ?? []
    }
}

/// The workspace hub's WeldHR topics: every one reloads what is on screen (the Expo app's sync map).
let hrTopics = [
    "hr_employee", "hr_checklist", "hr_attendance", "hr_leave_request", "hr_shift_request", "hr_open_shift",
    "hr_announcement", "hr_declaration", "hr_absence", "hr_coaching_log", "hr_evaluation", "hr_milestone", "hr_payslip",
]

/// WeldHR once signed in, in a workspace and unlocked.
struct ContentView: View {
    let env: AppEnvironment
    let store: HRStore
    let person: Person
    let workspace: WorkspaceRef
    let workspaces: [WorkspaceRef]
    @Binding var appearance: AppAppearance

    @State private var nav = HRNavigator()

    var body: some View {
        let access = store.access.data ?? .noAccess
        let tabs = HRTabs.of(access, loading: store.access.data == nil && store.access.error == nil)
        let ready = SelfState.of(me: store.me, access: store.access).features != nil
        TabView(selection: $nav.tab) {
            stack(.home) { HomeView(workspace: workspace) }
                .tabItem { Label(HRStrings.tabsHome, systemImage: "house") }
                .tag(HRTab.home)
                .accessibilityIdentifier("tab-home")
            if tabs.schedule {
                stack(.schedule) { ScheduleView(workspace: workspace) }
                    .tabItem { Label(HRStrings.tabsSchedule, systemImage: "calendar") }
                    .tag(HRTab.schedule)
                    .accessibilityIdentifier("tab-schedule")
            }
            if tabs.absence {
                stack(.absence) { AbsenceView() }
                    .tabItem { Label(HRStrings.tabsAbsence, systemImage: "calendar.badge.minus") }
                    .tag(HRTab.absence)
                    .badge(access.approveLeave ? store.pendingLeave.data?.count ?? 0 : 0)
                    .accessibilityIdentifier("tab-absence")
            }
            if tabs.expenses {
                stack(.expenses) { ExpensesView() }
                    .tabItem { Label(HRStrings.tabsExpenses, systemImage: "receipt") }
                    .tag(HRTab.expenses)
                    .badge(access.approveExpenses ? store.pendingExpenses.data?.count ?? 0 : 0)
                    .accessibilityIdentifier("tab-expenses")
            }
            if tabs.announcements {
                stack(.announcements) { AnnouncementsView() }
                    .tabItem { Label(HRStrings.tabsAnnouncements, systemImage: "megaphone") }
                    .tag(HRTab.announcements)
                    .badge(ready ? store.announcements.data?.unread ?? 0 : 0)
                    .accessibilityIdentifier("tab-announcements")
            }
        }
        .sheet(item: $nav.form) { form in
            NavigationStack { formView(form) }
                .environment(store)
                .environment(nav)
        }
        .environment(store)
        .environment(nav)
        .task(id: workspace.id) {
            store.use(workspace: workspace.id)
            await store.ensure(.access)
            await store.ensure(.me)
        }
        .task(id: "\(access.approveLeave)-\(access.approveExpenses)-\(ready)") {
            if access.approveLeave { await store.ensure(.pendingLeave) }
            if access.approveExpenses { await store.ensure(.pendingExpenses) }
            if ready { await store.ensure(.announcements) }
        }
        .realtimeRefresh(env, topics: hrTopics) { await store.invalidate() }
        .onChange(of: PushCenter.shared.pendingTap) { _, _ in followTap() }
        .onAppear(perform: followTap)
        .onOpenURL { url in
            // weldhr://sso-callback is the sign-in's; forPath has no page for it.
            if let target = HRRoutes.forPath(url.absoluteString) { nav.follow(target) }
        }
    }

    private func followTap() {
        guard let tap = env.takePushTap(), let target = HRRoutes.forPush(tap.values) else { return }
        nav.follow(target)
    }

    private func stack<Root: View>(_ tab: HRTab, @ViewBuilder root: () -> Root) -> some View {
        NavigationStack(path: nav.path(tab)) {
            root()
                .addMenu(tab)
                .navigationDestination(for: HRRoute.self) { route in destination(route) }
        }
    }

    @ViewBuilder
    private func destination(_ route: HRRoute) -> some View {
        switch route {
        case .profile:
            ProfileView(env: env, person: person, workspace: workspace, workspaces: workspaces, appearance: $appearance)
        case .pay: PayView()
        case .tasks: TasksView()
        case .reviews: ReviewsView()
        case .directory: DirectoryView()
        case let .employee(id): EmployeeView(id: id)
        case let .shift(id, day): ShiftView(id: id, day: day, workspace: workspace.name)
        case let .shiftRequest(id, day): ShiftRequestView(id: id, day: day)
        case let .openShift(id): OpenShiftView(id: id)
        case let .leave(id): LeaveView(id: id)
        case let .sickReport(id): SickReportView(id: id)
        case let .expense(id): ExpenseView(id: id)
        case let .announcement(id): AnnouncementView(id: id)
        }
    }

    @ViewBuilder
    private func formView(_ form: HRForm) -> some View {
        switch form {
        case .leave: LeaveForm()
        case let .expense(start): ExpenseForm(start: start)
        case .sick: SickForm()
        case .shift: ShiftRequestForm()
        case .announcement: AnnouncementForm()
        }
    }
}

/// The "+" on every tab but Home, for a member linked to an employee; what it offers depends on the tab.
private struct AddMenuModifier: ViewModifier {
    let tab: HRTab
    @Environment(HRStore.self) private var store
    @Environment(HRNavigator.self) private var nav

    func body(content: Content) -> some View {
        let features = SelfState.of(me: store.me, access: store.access).features
        let menu = features.flatMap { AddMenus.forTab(tab, features: $0, access: store.access.data ?? .noAccess) }
        content.toolbar {
            if let menu {
                ToolbarItem(placement: .primaryAction) {
                    if menu.direct {
                        Button { run(menu.main) } label: { Image(systemName: "plus") }
                            .accessibilityLabel(HRStrings.a11yAdd)
                            .accessibilityIdentifier("tab-add")
                    } else {
                        Menu {
                            ForEach(menu.entries, id: \.self) { action in
                                Button { run(action) } label: { describe(action) }
                                    .accessibilityIdentifier(tag(action))
                            }
                            Divider()
                            Button { run(menu.main) } label: { describe(menu.main) }
                                .accessibilityIdentifier(tag(menu.main))
                        } label: {
                            Image(systemName: "plus")
                        }
                        .accessibilityLabel(HRStrings.a11yAdd)
                        .accessibilityIdentifier("tab-add")
                    }
                }
            }
        }
    }

    private func run(_ action: AddAction) {
        switch action {
        case .requestLeave: nav.present(.leave)
        case .requestShift: nav.present(.shift)
        case .reportSick: nav.present(.sick)
        case .newExpense: nav.present(.expense(start: nil))
        case .photoReceipt: nav.present(.expense(start: "camera"))
        case .uploadReceipt: nav.present(.expense(start: "library"))
        case .newAnnouncement: nav.present(.announcement)
        }
    }

    private func describe(_ action: AddAction) -> Label<Text, Image> {
        let sick = store.absences.data?.current != nil
        switch action {
        case .requestLeave: return Label(HRStrings.homeRequestTimeOff, systemImage: "calendar.badge.plus")
        case .requestShift: return Label(HRStrings.homeRequestShift, systemImage: "clock.badge")
        case .reportSick: return Label(sick ? HRStrings.homeImBetter : HRStrings.homeReportSick, systemImage: "thermometer.medium")
        case .newExpense: return Label(HRStrings.homeNewExpense, systemImage: "receipt")
        case .photoReceipt: return Label(HRStrings.homePhotoReceipt, systemImage: "camera")
        case .uploadReceipt: return Label(HRStrings.homeUploadReceipt, systemImage: "photo.on.rectangle")
        case .newAnnouncement: return Label(HRStrings.announcementFormTitle, systemImage: "megaphone")
        }
    }

    private func tag(_ action: AddAction) -> String {
        switch action {
        case .requestLeave: "add-leave"
        case .requestShift: "add-shift"
        case .reportSick: "add-sick"
        case .newExpense: "add-expense"
        case .photoReceipt: "add-receipt-photo"
        case .uploadReceipt: "add-receipt-upload"
        case .newAnnouncement: "add-announcement"
        }
    }
}

extension View {
    func addMenu(_ tab: HRTab) -> some View { modifier(AddMenuModifier(tab: tab)) }
}

/// Runs a write: a toast saying how it went, the server's message on failure.
@MainActor
func runWrite(_ toaster: Toaster, success: String?, _ work: () async throws -> Void) async -> Bool {
    do {
        try await work()
        if let success { toaster.show(success) }
        return true
    } catch {
        toaster.show(HRFailure.from(error).text)
        return false
    }
}
