import SwiftUI
import WeldCore
import WeldUI

/// The events of one window (the agenda's two weeks, the month grid), and how loading them went.
@MainActor
@Observable
final class EventWindow {
    private(set) var state = LoadState<[CalendarEvent]>()
    /// Bumped per request: a slow answer for a month already paged past is dropped.
    @ObservationIgnored private var request = 0

    func load(_ store: CalendarStore, start: Date, end: Date, calendarIDs: String?) async {
        request += 1
        let mine = request
        state.loading = true
        state.error = nil
        do {
            let events = try await store.events(start: start, end: end, calendarIDs: calendarIDs)
            guard mine == request else { return }
            state = LoadState(data: events)
        } catch {
            guard mine == request else { return }
            state = LoadState(data: state.data, error: APIError.from(error))
        }
    }
}

/// What makes a window reload: its bounds, the shown calendars, a change made in the app.
struct WindowKey: Hashable {
    let start: Date
    let end: Date
    let calendarIDs: String?
    let changes: Int
    let known: Bool
}

/// The calendars and a window's events, as a list screen reads them.
struct WindowState {
    let calendars: LoadState<[CalendarInfo]>
    let events: LoadState<[CalendarEvent]>

    var firstLoad: Bool { calendars.isFirstLoad || (calendars.data != nil && events.isFirstLoad) }
    var failure: APIError? {
        guard events.data == nil else { return nil }
        return events.error ?? (calendars.data == nil ? calendars.error : nil)
    }
}

extension CalendarStore {
    /// `calendarIds` for the window: nil until the calendars are known.
    var visibleCalendarIDs: String? {
        calendars.data.flatMap { Visibility.calendarIDsParam($0, hidden: hidden) }
    }

    func windowKey(start: Date, end: Date) -> WindowKey {
        WindowKey(start: start, end: end, calendarIDs: visibleCalendarIDs, changes: changes, known: calendars.data != nil)
    }
}

/// The home tab: the next two weeks as the platform's schedule list, in its
/// groups (today, tomorrow, this week, next week, …). It reads the range
/// rather than "upcoming" so the meeting you're in and tentative holds show
/// too, and the hidden calendars stay out.
struct AgendaView: View {
    let env: AppEnvironment
    let store: CalendarStore
    let onNew: () -> Void

    @State private var window = EventWindow()

    private var calendar: Calendar { CalendarDates.calendar() }

    var body: some View {
        let today = Day(Date(), calendar: calendar)
        let range = CalendarDates.agendaWindow(today: today, calendar)
        let state = WindowState(calendars: store.calendars, events: window.state)
        Group {
            if state.firstLoad {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let failure = state.failure {
                LoadErrorView(error: failure) { await reload(range) }
            } else {
                list(today: today, state: state)
            }
        }
        // The platform's name for this view, left-aligned like its page headers (and the other apps' tabs).
        .navigationTitle(CalendarStrings.agendaTitle)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button(action: onNew) { Image(systemName: "plus") }
                    .accessibilityLabel(CalendarStrings.agendaNewEvent)
                    .accessibilityIdentifier("new-event")
            }
        }
        .task(id: store.windowKey(start: range.start, end: range.end)) {
            if store.calendars.data != nil {
                await window.load(store, start: range.start, end: range.end, calendarIDs: store.visibleCalendarIDs)
            }
        }
        .realtimeRefresh(env, topics: calendarTopics) {
            if store.calendars.data != nil {
                await window.load(store, start: range.start, end: range.end, calendarIDs: store.visibleCalendarIDs)
            }
        }
    }

    private func reload(_ range: (start: Date, end: Date)) async {
        await store.refreshCalendars()
        guard store.calendars.data != nil else { return }
        await window.load(store, start: range.start, end: range.end, calendarIDs: store.visibleCalendarIDs)
    }

    private func list(today: Day, state: WindowState) -> some View {
        let events = state.events.data ?? []
        let calendars = state.calendars.data ?? []
        let colors = Dictionary(calendars.map { ($0.id, $0.color) }, uniquingKeysWith: { first, _ in first })
        let sections = EventLists.scheduleSections(events, today: today, calendar)
        let range = CalendarDates.agendaWindow(today: today, calendar)
        return List {
            if sections.isEmpty {
                CalendarEmptyState(
                    systemImage: "calendar",
                    title: CalendarStrings.agendaEmptyTitle,
                    description: CalendarStrings.agendaEmptyDescription
                )
                .listRowSeparator(.hidden)
            }
            ForEach(sections) { section in
                Section {
                    ForEach(section.events) { event in
                        NavigationLink(value: Route.event(event.id)) {
                            EventRow(
                                event: event,
                                color: Color(hex: eventColor(event.color, event.type, calendarColor: colors[event.calendarID] ?? nil)),
                                // Today, tomorrow and yesterday are named in the heading; the other groups span days.
                                showDate: ![ScheduleGroup.yesterday, .today, .tomorrow].contains(section.group)
                            )
                        }
                        .platformRow()
                    }
                } header: {
                    GroupHeader(label: CalendarText.scheduleGroup(section.group, today: today, calendar), count: section.events.count)
                        .listRowInsets(EdgeInsets())
                }
            }
        }
        .listStyle(.plain)
        .accessibilityIdentifier("agenda-list")
        .refreshable { await reload(range) }
    }
}
