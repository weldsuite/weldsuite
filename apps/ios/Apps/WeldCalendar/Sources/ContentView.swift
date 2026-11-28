import SwiftUI
import WeldCore
import WeldUI

/// A screen pushed on a tab's stack.
enum Route: Hashable {
    case event(String)
}

/// WeldCalendar once signed in, in a workspace and unlocked.
struct ContentView: View {
    let env: AppEnvironment
    let store: CalendarStore
    let person: Person
    let workspace: WorkspaceRef
    let workspaces: [WorkspaceRef]
    @Binding var appearance: AppAppearance
    /// A `weldcalendar://` link the app hasn't opened yet.
    @Binding var link: CalendarLink?

    @State private var tab: AppTab = .agenda
    @State private var agendaPath: [Route] = []
    @State private var monthPath: [Route] = []
    @State private var form: FormMode?

    var body: some View {
        TabView(selection: $tab) {
            NavigationStack(path: $agendaPath) {
                AgendaView(
                    env: env,
                    store: store,
                    onNew: { form = .new(nil) }
                )
                .navigationDestination(for: Route.self, destination: destination)
            }
            .tabItem { Label(CalendarStrings.tabsAgenda, systemImage: "list.bullet.rectangle") }
            .tag(AppTab.agenda)
            .accessibilityIdentifier("tab-agenda")

            NavigationStack(path: $monthPath) {
                MonthView(env: env, store: store) { day in form = .new(day) }
                    .navigationDestination(for: Route.self, destination: destination)
            }
            .tabItem { Label(CalendarStrings.tabsMonth, systemImage: "calendar") }
            .tag(AppTab.month)
            .accessibilityIdentifier("tab-month")

            NavigationStack {
                CalendarsView(env: env, store: store)
            }
            .tabItem { Label(CalendarStrings.tabsCalendars, systemImage: "square.stack") }
            .tag(AppTab.calendars)
            .accessibilityIdentifier("tab-calendars")

            NavigationStack {
                SettingsView(env: env, person: person, workspace: workspace, workspaces: workspaces, appearance: $appearance)
            }
            .tabItem { Label(CalendarStrings.tabsMore, systemImage: "ellipsis.circle") }
            .tag(AppTab.more)
            .accessibilityIdentifier("tab-more")
        }
        .sheet(item: $form) { mode in
            EventFormView(store: store, mode: mode)
        }
        .task(id: workspace.id) {
            store.use(workspace: workspace.id)
            await store.refreshCalendars()
        }
        .realtimeRefresh(env, topics: calendarTopics) { await store.refreshCalendars() }
        // A tapped notification opens its event, as the Expo app's handler did.
        .onChange(of: PushCenter.shared.pendingTap, initial: true) {
            guard let tap = env.takePushTap(), let eventID = eventIDFromPush(tap.values) else { return }
            open(.event(eventID))
        }
        .onChange(of: link, initial: true) {
            guard let target = link else { return }
            link = nil
            open(target)
        }
    }

    private func destination(_ route: Route) -> some View {
        switch route {
        case let .event(eventID):
            return EventView(env: env, store: store, eventID: eventID) { form = .edit($0) }
        }
    }

    private func open(_ target: CalendarLink) {
        switch target {
        case let .event(eventID):
            form = nil
            tab = .agenda
            agendaPath.append(.event(eventID))
        case let .editEvent(eventID):
            form = .edit(eventID)
        case let .newEvent(day):
            form = .new(day)
        case let .tab(target):
            tab = target
        }
    }
}
