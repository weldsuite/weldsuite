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

/// The home tab: everything in the next two weeks, by day, under the day's
/// numbers. It reads the range rather than "upcoming" so the meeting you're
/// in and tentative holds show too, and the hidden calendars stay out.
struct AgendaView: View {
    let env: AppEnvironment
    let store: CalendarStore
    let title: String
    let onNew: () -> Void
    let onCalendars: () -> Void

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
        .navigationTitle(title.isEmpty ? CalendarStrings.agendaTitle : title)
        .navigationBarTitleDisplayMode(.inline)
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
        let names = Dictionary(calendars.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
        let sections = EventLists.groupByDay(events, calendar)
        let counts = EventLists.counts(events, today: today, calendar)
        let now = Date()
        let range = CalendarDates.agendaWindow(today: today, calendar)
        return List {
            Section {
                HStack(spacing: Tokens.Spacing.s) {
                    Kpi(label: CalendarStrings.agendaToday, value: counts.today, sub: CalendarStrings.agendaEventCount(counts.today))
                        .accessibilityIdentifier("kpi-today")
                    Kpi(label: CalendarStrings.agendaNext7Days, value: counts.nextSevenDays, sub: CalendarStrings.agendaEventCount(counts.nextSevenDays))
                        .accessibilityIdentifier("kpi-week")
                    Button(action: onCalendars) {
                        Kpi(label: CalendarStrings.tabsCalendars, value: calendars.count, sub: CalendarStrings.agendaCalendarCount(calendars.count))
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("kpi-calendars")
                }
                .listRowInsets(EdgeInsets(top: Tokens.Spacing.s, leading: Tokens.Spacing.l, bottom: Tokens.Spacing.s, trailing: Tokens.Spacing.l))
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
            }
            if sections.isEmpty {
                ContentUnavailableView(
                    CalendarStrings.agendaEmptyTitle,
                    systemImage: "calendar",
                    description: Text(CalendarStrings.agendaEmptyDescription)
                )
                .listRowSeparator(.hidden)
            }
            ForEach(sections) { section in
                Section {
                    ForEach(section.events) { event in
                        NavigationLink(value: Route.event(event.id)) {
                            EventRow(event: event, calendarName: calendars.count > 1 ? names[event.calendarID] : nil, now: now)
                        }
                    }
                } header: {
                    HStack(alignment: .firstTextBaseline) {
                        Text(CalendarText.dayHeading(section.day, today: today, calendar))
                            .font(.inter(.subheadline, weight: .bold))
                            .foregroundStyle(section.day == today ? Tokens.Palette.primary : .primary)
                        Spacer()
                        Text(CalendarStrings.agendaEventCount(section.events.count)).font(.inter(.caption)).foregroundStyle(.secondary)
                    }
                    .textCase(nil)
                }
            }
        }
        .listStyle(.plain)
        .accessibilityIdentifier("agenda-list")
        .refreshable { await reload(range) }
    }
}

/// One of the agenda's numbers.
struct Kpi: View {
    let label: String
    let value: Int
    let sub: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.inter(.caption)).foregroundStyle(.secondary).lineLimit(1)
            Text("\(value)").font(.inter(.title2, weight: .bold))
            Text(sub).font(.inter(.caption2)).foregroundStyle(.secondary).lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Tokens.Spacing.m)
        .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: Tokens.Radius.medium))
        .accessibilityElement(children: .combine)
    }
}
