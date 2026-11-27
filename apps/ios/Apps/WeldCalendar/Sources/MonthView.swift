import SwiftUI
import WeldCore
import WeldUI

/// The month grid over the chosen day's events. It asks for the whole grid,
/// not just the month: the first and last rows spill into the neighbouring
/// months, and their squares should show their dots too.
struct MonthView: View {
    let env: AppEnvironment
    let store: CalendarStore
    let onNew: (Day) -> Void

    @State private var window = EventWindow()
    @State private var month: YearMonth
    @State private var selected: Day

    private var calendar: Calendar { CalendarDates.calendar() }

    init(env: AppEnvironment, store: CalendarStore, onNew: @escaping (Day) -> Void) {
        self.env = env
        self.store = store
        self.onNew = onNew
        let today = Day(Date(), calendar: CalendarDates.calendar())
        _month = State(initialValue: YearMonth(today))
        _selected = State(initialValue: today)
    }

    var body: some View {
        let today = Day(Date(), calendar: calendar)
        let range = CalendarDates.monthWindow(month, calendar)
        let state = WindowState(calendars: store.calendars, events: window.state)
        Group {
            if state.firstLoad {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let failure = state.failure {
                LoadErrorView(error: failure) { await reload(range) }
            } else {
                list(today: today, state: state, range: range)
            }
        }
        .navigationTitle(CalendarText.monthTitle(month, calendar))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button { month = month.adding(months: -1) } label: { Image(systemName: "chevron.left") }
                    .accessibilityLabel(CalendarStrings.monthPreviousMonth)
                    .accessibilityIdentifier("month-previous")
                Button { month = month.adding(months: 1) } label: { Image(systemName: "chevron.right") }
                    .accessibilityLabel(CalendarStrings.monthNextMonth)
                    .accessibilityIdentifier("month-next")
                Button { onNew(selected) } label: { Image(systemName: "plus") }
                    .accessibilityLabel(CalendarStrings.agendaNewEvent)
                    .accessibilityIdentifier("month-new-event")
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

    private func list(today: Day, state: WindowState, range: (start: Date, end: Date)) -> some View {
        let events = state.events.data ?? []
        let calendars = state.calendars.data ?? []
        let names = Dictionary(calendars.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
        let dayEvents = EventLists.on(selected, events, calendar)
        let now = Date()
        return List {
            MonthGrid(
                month: month,
                selected: selected,
                today: today,
                dots: EventLists.dots(events, calendar),
                calendar: calendar
            ) { day in
                selected = day
                // A spill-over square moves the grid to its month.
                if YearMonth(day) != month { month = YearMonth(day) }
            }
            .listRowInsets(EdgeInsets(top: Tokens.Spacing.s, leading: Tokens.Spacing.s, bottom: Tokens.Spacing.s, trailing: Tokens.Spacing.s))
            .listRowSeparator(.hidden)

            Section {
                if dayEvents.isEmpty {
                    ContentUnavailableView(
                        CalendarStrings.monthNoEventsTitle,
                        systemImage: "calendar",
                        description: Text(CalendarStrings.monthNoEventsDescription)
                    )
                    .listRowSeparator(.hidden)
                }
                ForEach(dayEvents) { event in
                    NavigationLink(value: Route.event(event.id)) {
                        EventRow(event: event, calendarName: calendars.count > 1 ? names[event.calendarID] : nil, now: now)
                    }
                }
            } header: {
                HStack {
                    Text(CalendarText.dayHeading(selected, today: today, calendar))
                        .font(.headline)
                        .foregroundStyle(.primary)
                    Spacer()
                    if selected != today {
                        Button(CoreStrings.commonToday) {
                            selected = today
                            month = YearMonth(today)
                        }
                        .font(.subheadline.weight(.semibold))
                        .accessibilityIdentifier("month-today")
                    }
                }
                .textCase(nil)
            }
        }
        .listStyle(.plain)
        .refreshable { await reload(range) }
    }
}

/// Monday-first, six rows always, at most three dots a day and a "+n".
struct MonthGrid: View {
    let month: YearMonth
    let selected: Day
    let today: Day
    let dots: [Day: DayDots]
    let calendar: Calendar
    let onSelect: (Day) -> Void

    var body: some View {
        let weeks = CalendarDates.monthMatrix(month, calendar)
        let symbols = calendar.veryShortWeekdaySymbols
        // Monday first: Calendar's symbols start on Sunday.
        let headers = Array(symbols.dropFirst()) + Array(symbols.prefix(1))
        VStack(spacing: 2) {
            HStack(spacing: 0) {
                ForEach(Array(headers.enumerated()), id: \.offset) { _, symbol in
                    Text(symbol.uppercased())
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity)
                }
            }
            .padding(.bottom, 4)
            ForEach(weeks, id: \.first) { week in
                HStack(spacing: 0) {
                    ForEach(week) { day in
                        cell(day)
                    }
                }
            }
        }
        .accessibilityIdentifier("month-grid")
    }

    private func cell(_ day: Day) -> some View {
        let inMonth = YearMonth(day) == month
        let isSelected = day == selected
        let isToday = day == today
        let entry = dots[day]
        return Button { onSelect(day) } label: {
            VStack(spacing: 2) {
                Text("\(day.day)")
                    .font(.system(size: 15, weight: isSelected || isToday ? .bold : .regular))
                    .foregroundStyle(isSelected ? Color.white : isToday ? Tokens.Brand.weldcalendar : inMonth ? Color.primary : Color.secondary)
                    .opacity(!inMonth && !isSelected ? 0.45 : 1)
                    .frame(width: 32, height: 32)
                    .background {
                        if isSelected {
                            Circle().fill(Tokens.Brand.weldcalendar)
                        } else if isToday {
                            Circle().stroke(Tokens.Brand.weldcalendar, lineWidth: 1.5)
                        }
                    }
                HStack(spacing: 3) {
                    ForEach(Array((entry?.colors ?? []).enumerated()), id: \.offset) { _, hex in
                        Circle().fill(Color(hex: hex)).frame(width: 5, height: 5)
                    }
                    if let entry, entry.overflow > 0 {
                        Text("+\(entry.overflow)").font(.system(size: 8, weight: .semibold)).foregroundStyle(.secondary)
                    }
                }
                .frame(height: 8)
                .opacity(inMonth ? 1 : 0.35)
            }
            .frame(maxWidth: .infinity, minHeight: 46)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(day.start(calendar).formatted(.dateTime.weekday(.wide).day().month(.wide)))
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityIdentifier("month-day-\(day.key)")
    }
}
