import SwiftUI
import WeldCore
import WeldUI

/// The month as the platform's phone month view draws it, over the chosen
/// day's events. It asks for the whole six-week grid, with a day of slack.
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
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button(CoreStrings.commonToday) {
                    month = YearMonth(today)
                    selected = today
                }
                .foregroundStyle(Tokens.Palette.foreground)
                .accessibilityIdentifier("month-today")
            }
            ToolbarItemGroup(placement: .primaryAction) {
                Button { show(month.adding(months: -1), today: today) } label: { Image(systemName: "chevron.left") }
                    .accessibilityLabel(CalendarStrings.monthPreviousMonth)
                    .accessibilityIdentifier("month-previous")
                Button { show(month.adding(months: 1), today: today) } label: { Image(systemName: "chevron.right") }
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

    /// Paging moves the selection into the new month: today there, else its first day.
    private func show(_ next: YearMonth, today: Day) {
        month = next
        selected = YearMonth(today) == next ? today : next.firstDay
    }

    private func reload(_ range: (start: Date, end: Date)) async {
        await store.refreshCalendars()
        guard store.calendars.data != nil else { return }
        await window.load(store, start: range.start, end: range.end, calendarIDs: store.visibleCalendarIDs)
    }

    private func list(today: Day, state: WindowState, range: (start: Date, end: Date)) -> some View {
        let events = state.events.data ?? []
        let calendars = state.calendars.data ?? []
        let colors = Dictionary(calendars.map { ($0.id, $0.color) }, uniquingKeysWith: { first, _ in first })
        let dayEvents = EventLists.on(selected, events, calendar)
        return List {
            MonthGrid(
                month: month,
                selected: selected,
                today: today,
                counts: EventLists.dayCounts(events, calendar),
                calendar: calendar
            ) { day in selected = day }
            .listRowInsets(EdgeInsets())
            .listRowSeparator(.hidden)

            Section {
                if dayEvents.isEmpty {
                    CalendarEmptyState(
                        systemImage: "calendar",
                        title: CalendarStrings.monthNoEventsTitle,
                        description: CalendarStrings.monthNoEventsDescription
                    )
                    .listRowSeparator(.hidden)
                }
                ForEach(dayEvents) { event in
                    NavigationLink(value: Route.event(event.id)) {
                        EventRow(
                            event: event,
                            color: Color(hex: eventColor(event.color, event.type, calendarColor: colors[event.calendarID] ?? nil)),
                            // The heading names the day.
                            showDate: false
                        )
                    }
                    .platformRow()
                }
            } header: {
                GroupHeader(label: CalendarText.dayLabel(selected, today: today, calendar), count: dayEvents.count)
                    .listRowInsets(EdgeInsets())
            }
        }
        .listStyle(.plain)
        .refreshable { await reload(range) }
    }
}

/// Monday-first weeks of `month`, as the platform's phone month: the
/// neighbouring months' days left blank, today in the platform's blue, the
/// selected day filled (blue when it's today), and a muted dot under a day
/// with events.
struct MonthGrid: View {
    let month: YearMonth
    let selected: Day
    let today: Day
    let counts: [Day: Int]
    let calendar: Calendar
    let onSelect: (Day) -> Void

    @Environment(\.displayScale) private var displayScale

    var body: some View {
        let weeks = CalendarDates.monthMatrix(month, calendar).filter { week in week.contains { YearMonth($0) == month } }
        let symbols = calendar.veryShortWeekdaySymbols
        // Monday first: Calendar's symbols start on Sunday.
        let headers = Array(symbols.dropFirst()) + Array(symbols.prefix(1))
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                ForEach(Array(headers.enumerated()), id: \.offset) { _, symbol in
                    Text(symbol.uppercased())
                        .font(.inter(.caption2, weight: .medium))
                        .foregroundStyle(Tokens.Palette.mutedForeground)
                        .frame(maxWidth: .infinity)
                }
            }
            .padding(.vertical, Tokens.Spacing.s)
            Rectangle().fill(Tokens.Palette.border).frame(height: 1 / displayScale)
            VStack(spacing: 0) {
                ForEach(weeks, id: \.first) { week in
                    HStack(spacing: 0) {
                        ForEach(week) { day in
                            if YearMonth(day) == month {
                                cell(day)
                            } else {
                                Color.clear.frame(maxWidth: .infinity).frame(height: 48)
                            }
                        }
                    }
                }
            }
            .padding(.vertical, Tokens.Spacing.xs)
        }
        .accessibilityIdentifier("month-grid")
    }

    private func cell(_ day: Day) -> some View {
        let isSelected = day == selected
        let isToday = day == today
        let count = counts[day] ?? 0
        let date = day.start(calendar).formatted(.dateTime.weekday(.wide).day().month(.wide))
        let fill: Color = isSelected ? (isToday ? .todayBlue : Tokens.Palette.foreground) : .clear
        let text: Color = isSelected ? (isToday ? .white : Tokens.Palette.background) : (isToday ? .todayBlue : Tokens.Palette.foreground)
        return Button { onSelect(day) } label: {
            ZStack(alignment: .top) {
                Text("\(day.day)")
                    .font(.inter(size: 14, weight: isToday && !isSelected ? .semibold : .regular))
                    .foregroundStyle(text)
                    .frame(width: 32, height: 32)
                    .background(fill, in: Circle())
                    .padding(.top, 6)
                if count > 0 {
                    Circle()
                        .fill(Tokens.Palette.mutedForeground)
                        .frame(width: 4, height: 4)
                        .frame(maxHeight: .infinity, alignment: .bottom)
                        .padding(.bottom, 4)
                }
            }
            .frame(maxWidth: .infinity)
            .frame(height: 48)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(count > 0 ? "\(date), \(CalendarStrings.agendaEventCount(count))" : date)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityIdentifier("month-day-\(day.key)")
    }
}
