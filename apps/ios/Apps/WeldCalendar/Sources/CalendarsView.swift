import SwiftUI
import WeldCore
import WeldUI

/// The person's calendars and the ones shared with them, as the platform's
/// sidebar lists them: each with a checkbox in its colour that decides
/// whether the agenda and the grid show it. A member who owns none gets the
/// default one made for them.
struct CalendarsView: View {
    let env: AppEnvironment
    let store: CalendarStore

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
                CalendarEmptyState(
                    systemImage: "calendar",
                    title: CalendarStrings.calendarsEmptyTitle,
                    description: CalendarStrings.calendarsEmptyDescription
                )
                .listRowSeparator(.hidden)
            }
            if !sections.own.isEmpty {
                Section {
                    ForEach(sections.own) { calendar in row(calendar) }
                } header: {
                    GroupHeader(label: CalendarStrings.calendarsMine, count: sections.own.count)
                        .listRowInsets(EdgeInsets())
                }
            }
            if !sections.shared.isEmpty {
                Section {
                    ForEach(sections.shared) { calendar in row(calendar) }
                } header: {
                    GroupHeader(label: CalendarStrings.calendarsShared, count: sections.shared.count)
                        .listRowInsets(EdgeInsets())
                }
            }
        }
        .listStyle(.plain)
        .refreshable { await store.refreshCalendars() }
    }

    private func row(_ calendar: CalendarInfo) -> some View {
        let visible = !store.hidden.contains(calendar.id)
        return Button { store.toggleHidden(calendar.id) } label: {
            HStack(spacing: Tokens.Spacing.m) {
                CalendarCheckbox(color: Color(hex: calendar.color), checked: visible)
                Text(calendar.name)
                    .font(.inter(.subheadline, weight: .medium))
                    .foregroundStyle(Tokens.Palette.foreground)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.vertical, 14)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowInsets(EdgeInsets(top: 0, leading: Tokens.Spacing.l, bottom: 0, trailing: Tokens.Spacing.l))
        .listRowSeparatorTint(Tokens.Palette.border)
        .alignmentGuide(.listRowSeparatorLeading) { _ in 0 }
        .accessibilityLabel(calendar.name)
        .accessibilityAddTraits(visible ? [.isButton, .isSelected] : .isButton)
        .accessibilityIdentifier("calendar-visible-\(calendar.id)")
    }
}

/// The platform sidebar's checkbox: the calendar's colour with a white tick when checked, its outline when not.
struct CalendarCheckbox: View {
    let color: Color
    let checked: Bool

    var body: some View {
        ZStack {
            if checked {
                RoundedRectangle(cornerRadius: 4).fill(color)
                Image(systemName: "checkmark").font(.system(size: 11, weight: .bold)).foregroundStyle(.white)
            } else {
                RoundedRectangle(cornerRadius: 4).strokeBorder(color, lineWidth: 1.5)
            }
        }
        .frame(width: 18, height: 18)
        .accessibilityHidden(true)
    }
}

/// The platform's "Create Calendar": a name and one of its ten colours, blue by default.
struct NewCalendarView: View {
    let store: CalendarStore

    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var color = CalendarSwatch.blue
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
                        .accessibilityIdentifier("calendar-name")
                } header: {
                    Text(CalendarStrings.calendarsNameLabel)
                }
                Section(CalendarStrings.calendarsColorLabel) {
                    HStack(spacing: 0) {
                        ForEach(Array(CalendarSwatch.allCases.enumerated()), id: \.offset) { index, option in
                            let chosen = option == color
                            Button { color = option } label: {
                                RoundedRectangle(cornerRadius: Tokens.Radius.medium)
                                    .fill(Color(hex: option.hex))
                                    .overlay(
                                        RoundedRectangle(cornerRadius: Tokens.Radius.medium)
                                            .strokeBorder(chosen ? Tokens.Palette.foreground : .clear, lineWidth: 2)
                                    )
                                    .frame(width: 28, height: 28)
                                    .scaleEffect(chosen ? 1.1 : 1)
                            }
                            .buttonStyle(.plain)
                            .frame(maxWidth: .infinity)
                            .accessibilityLabel(CalendarText.swatch(option))
                            .accessibilityAddTraits(chosen ? .isSelected : [])
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
                    // Without a name there is nothing to create, as on the platform.
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
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }
        saving = true
        failure = nil
        Task {
            do {
                try await store.createCalendar(name: trimmed, description: "", color: color.hex)
                dismiss()
            } catch {
                failure = CalendarText.failure(CalendarStrings.calendarsCreateFailed, error)
            }
            saving = false
        }
    }
}
