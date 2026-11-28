import SwiftUI
import WeldCore
import WeldUI

/// The person's calendars and the ones shared with them, each with a switch
/// that decides whether the agenda and the grid show it. A member who owns
/// none gets the default one made for them.
struct CalendarsView: View {
    let env: AppEnvironment
    let store: CalendarStore
    let workspaceName: String

    @Environment(Toaster.self) private var toaster
    @State private var creating = false

    var body: some View {
        let state = store.calendars
        Group {
            if state.isFirstLoad {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let calendars = state.data {
                list(calendars)
            } else {
                LoadErrorView(error: state.error) { await store.refreshCalendars() }
            }
        }
        .navigationTitle(CalendarStrings.calendarsTitle)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { creating = true } label: { Image(systemName: "plus") }
                    .accessibilityLabel(CalendarStrings.calendarsNewCalendar)
                    .accessibilityIdentifier("new-calendar")
            }
        }
        .sheet(isPresented: $creating) {
            NewCalendarView(store: store)
        }
        .task(id: state.data != nil) {
            if state.data != nil, !(await store.ensureDefaultIfNeeded()) {
                toaster.show(CalendarStrings.calendarsEnsureFailed)
            }
        }
        // ContentView refreshes the calendars on the hub's events for every tab.
    }

    private func list(_ calendars: [CalendarInfo]) -> some View {
        let sections = CalendarAccess.sections(calendars)
        return List {
            if calendars.isEmpty {
                ContentUnavailableView(
                    CalendarStrings.calendarsEmptyTitle,
                    systemImage: "calendar",
                    description: Text(CalendarStrings.calendarsEmptyDescription)
                )
            }
            if !sections.own.isEmpty {
                Section(workspaceName.isEmpty ? CalendarStrings.calendarsWorkspace : workspaceName) {
                    ForEach(sections.own) { calendar in row(calendar) }
                }
            }
            if !sections.shared.isEmpty {
                Section(CalendarStrings.calendarsShared) {
                    ForEach(sections.shared) { calendar in row(calendar) }
                }
            }
            if !calendars.isEmpty {
                Section {
                } footer: {
                    Text(CalendarStrings.calendarsVisibilityHint)
                }
            }
        }
        .refreshable { await store.refreshCalendars() }
    }

    private func row(_ calendar: CalendarInfo) -> some View {
        let subtitle = calendar.isOwn
            ? (calendar.description ?? CalendarText.permission(.manage))
            : CalendarText.permission(calendar.permission)
        return Toggle(isOn: Binding(
            get: { !store.hidden.contains(calendar.id) },
            set: { _ in store.toggleHidden(calendar.id) }
        )) {
            HStack(spacing: Tokens.Spacing.m) {
                ColorDot(hex: calendar.color, size: 16)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: Tokens.Spacing.s) {
                        Text(calendar.name).lineLimit(1)
                        if calendar.isDefault {
                            StatusBadge(CalendarStrings.calendarsDefaultBadge, color: .secondary)
                        }
                    }
                    Text(subtitle).font(.inter(.footnote)).foregroundStyle(.secondary).lineLimit(1)
                }
            }
        }
        .accessibilityLabel(CalendarStrings.calendarsShow(name: calendar.name))
        .accessibilityIdentifier("calendar-visible-\(calendar.id)")
    }
}

/// A new calendar: a name, an optional description and one of the palette's colours.
struct NewCalendarView: View {
    let store: CalendarStore

    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var description = ""
    @State private var color = calendarColors[0]
    @State private var nameError = false
    @State private var saving = false
    /// Why creating failed, shown in the sheet (a toast would sit under it).
    @State private var failure: String?
    @FocusState private var nameFocused: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(CalendarStrings.calendarsNamePlaceholder, text: $name)
                        .focused($nameFocused)
                        .onChange(of: name) { nameError = false }
                        .accessibilityIdentifier("calendar-name")
                } header: {
                    Text(CalendarStrings.calendarsNameLabel)
                } footer: {
                    if nameError { Text(CalendarStrings.calendarsNameRequired).foregroundStyle(Tokens.Status.danger) }
                }
                Section(CalendarStrings.calendarsDescriptionLabel) {
                    TextField(CalendarStrings.calendarsDescriptionPlaceholder, text: $description)
                        .accessibilityIdentifier("calendar-description")
                }
                Section(CalendarStrings.calendarsColorLabel) {
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 6), spacing: 12) {
                        ForEach(Array(calendarColors.enumerated()), id: \.offset) { index, option in
                            Button { color = option } label: {
                                ZStack {
                                    Circle().fill(Color(hex: option)).frame(width: 34, height: 34)
                                    if option == color {
                                        Image(systemName: "checkmark").font(.inter(.footnote, weight: .bold)).foregroundStyle(.white)
                                    }
                                }
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(CalendarStrings.calendarsColorOption(number: String(index + 1)))
                            .accessibilityAddTraits(option == color ? .isSelected : [])
                            .accessibilityIdentifier("calendar-color-\(index)")
                        }
                    }
                    .padding(.vertical, 4)
                }
                if let failure {
                    Section {
                        Text(failure).foregroundStyle(Tokens.Status.danger)
                    }
                }
            }
            .navigationTitle(CalendarStrings.calendarsNewCalendar)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(CoreStrings.commonCancel) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(CalendarStrings.commonCreate) { create() }
                        .disabled(saving || name.trimmingCharacters(in: .whitespaces).isEmpty)
                        .accessibilityIdentifier("create-calendar")
                }
            }
            .onAppear { nameFocused = true }
        }
        .presentationDetents([.medium, .large])
    }

    private func create() {
        guard !name.trimmingCharacters(in: .whitespaces).isEmpty else {
            nameError = true
            return
        }
        saving = true
        failure = nil
        Task {
            do {
                try await store.createCalendar(name: name, description: description, color: color)
                dismiss()
            } catch {
                failure = CalendarText.failure(CalendarStrings.calendarsCreateFailed, error)
            }
            saving = false
        }
    }
}
