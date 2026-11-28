import SwiftUI
import WeldCore
import WeldUI

/// What the form is for: a new event (starting on a day the month tab
/// handed over) or an edit.
enum FormMode: Identifiable, Equatable {
    case new(Day?)
    case edit(String)

    var id: String {
        switch self {
        case let .new(day): return "new-\(day?.key ?? "")"
        case let .edit(eventID): return "edit-\(eventID)"
        }
    }
}

/// The event form, in a sheet. Only calendars the person may write to are offered.
struct EventFormView: View {
    let store: CalendarStore
    let mode: FormMode

    @Environment(\.dismiss) private var dismiss
    @State private var original: CalendarEvent?
    @State private var draft: EventDraft?
    @State private var loadError: APIError?
    @State private var readOnly = false
    @State private var showProblems = false
    @State private var saving = false
    /// Why saving failed, shown in the form (a toast would sit under the sheet).
    @State private var failure: String?

    private var calendar: Calendar { CalendarDates.calendar() }

    private var writable: [CalendarInfo] { CalendarAccess.writable(store.calendars.data ?? []) }

    var body: some View {
        NavigationStack {
            Group {
                if readOnly {
                    ContentUnavailableView(
                        CalendarStrings.eventReadOnly,
                        systemImage: "lock",
                        description: Text(CalendarStrings.eventReadOnlyHint)
                    )
                } else if let loadError {
                    LoadErrorView(error: loadError) { await prepare() }
                } else if draft != nil, writable.isEmpty {
                    ContentUnavailableView(CalendarStrings.eventFormNoWritableCalendar, systemImage: "calendar.badge.exclamationmark")
                } else if let binding = Binding($draft) {
                    EventFormFields(
                        draft: binding,
                        calendars: writable,
                        isEdit: original != nil,
                        hadGuests: original?.guests.isEmpty == false,
                        showProblems: showProblems,
                        failure: failure
                    )
                } else {
                    ProgressView()
                }
            }
            .navigationTitle(original == nil ? CalendarStrings.eventFormNewTitle : CalendarStrings.eventFormEditTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(CoreStrings.commonCancel) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(original == nil ? CalendarStrings.eventFormSubmitCreate : CalendarStrings.eventFormSubmitSave) { save() }
                        .disabled(saving || draft == nil || readOnly || writable.isEmpty)
                        .accessibilityIdentifier("event-submit")
                }
            }
        }
        .interactiveDismissDisabled(saving)
        .task { await prepare() }
    }

    /// The calendars, and for an edit the event; then the draft.
    private func prepare() async {
        loadError = nil
        if store.calendars.data == nil { await store.refreshCalendars() }
        guard let calendars = store.calendars.data else {
            loadError = store.calendars.error ?? APIError(status: nil, code: nil)
            return
        }
        switch mode {
        case let .new(day):
            if draft == nil {
                let start = CalendarDates.startFor(day: day, now: Date(), calendar)
                draft = EventDraft.new(calendars: CalendarAccess.writable(calendars), start: start)
            }
        case let .edit(eventID):
            do {
                let event = try await store.event(id: eventID)
                // A link (or a share made view-only meanwhile) can lead here without write access.
                guard CalendarAccess.canEdit(event, calendars) else {
                    readOnly = true
                    return
                }
                original = event
                if draft == nil { draft = EventDraft.of(event) }
            } catch {
                loadError = APIError.from(error)
            }
        }
    }

    private func save() {
        guard let draft else { return }
        guard problems(of: draft).isEmpty else {
            showProblems = true
            return
        }
        saving = true
        failure = nil
        Task {
            do {
                if let original {
                    try await store.update(original, with: draft)
                } else {
                    try await store.create(draft)
                }
                dismiss()
            } catch {
                failure = CalendarText.failure(
                    original == nil ? CalendarStrings.eventFormCreateFailed : CalendarStrings.eventFormUpdateFailed,
                    error
                )
            }
            saving = false
        }
    }
}

/// The form's fields. Dates and times use the system pickers, in the phone's zone.
struct EventFormFields: View {
    @Binding var draft: EventDraft
    let calendars: [CalendarInfo]
    let isEdit: Bool
    let hadGuests: Bool
    let showProblems: Bool
    let failure: String?

    @State private var guestEmail = ""
    @State private var guestProblemShown: GuestProblem?
    @FocusState private var titleFocused: Bool

    private var calendar: Calendar { CalendarDates.calendar() }

    var body: some View {
        let issues = problems(of: draft)
        Form {
            if let failure {
                Section {
                    Text(failure).foregroundStyle(Tokens.Status.danger)
                }
            }

            Section {
                TextField(CalendarStrings.eventFormTitlePlaceholder, text: $draft.title)
                    .focused($titleFocused)
                    .accessibilityIdentifier("event-title")
                if showProblems, issues.titleMissing {
                    Text(CalendarStrings.eventFormTitleRequired).font(.inter(.footnote)).foregroundStyle(Tokens.Status.danger)
                }
                Picker(CalendarStrings.eventFormCalendarLabel, selection: $draft.calendarID) {
                    ForEach(calendars) { option in
                        Text(option.name).tag(option.id)
                    }
                }
                .accessibilityIdentifier("event-calendar")
                Picker(CalendarStrings.eventFormTypeLabel, selection: $draft.type) {
                    ForEach(EventType.allCases) { type in
                        Text(CalendarText.type(type)).tag(type)
                    }
                }
                .accessibilityIdentifier("event-type")
            } header: {
                Text(CalendarStrings.eventFormTitleLabel)
            }

            Section {
                Toggle(CalendarStrings.eventFormAllDayLabel, isOn: Binding(
                    get: { draft.allDay },
                    set: { draft = DraftTimes.allDay(draft, $0, calendar) }
                ))
                .accessibilityIdentifier("event-all-day")
                DatePicker(
                    CalendarStrings.eventFormStartsLabel,
                    selection: Binding(
                        get: { draft.start },
                        set: { draft = DraftTimes.start(draft, to: draft.allDay ? $0 : DraftTimes.wholeMinute($0, calendar)) }
                    ),
                    displayedComponents: draft.allDay ? [.date] : [.date, .hourAndMinute]
                )
                .accessibilityIdentifier("event-start")
                DatePicker(
                    CalendarStrings.eventFormEndsLabel,
                    selection: Binding(
                        get: { draft.end },
                        set: { newEnd in
                            if draft.allDay {
                                draft = DraftTimes.end(draft, to: CalendarDates.endOf(Day(newEnd, calendar: calendar), calendar))
                            } else {
                                draft = DraftTimes.end(draft, to: DraftTimes.wholeMinute(newEnd, calendar))
                            }
                        }
                    ),
                    displayedComponents: draft.allDay ? [.date] : [.date, .hourAndMinute]
                )
                .accessibilityIdentifier("event-end")
                if showProblems, issues.endBeforeStart {
                    Text(CalendarStrings.eventFormEndBeforeStart).font(.inter(.footnote)).foregroundStyle(Tokens.Status.danger)
                }
                // A stored rule a preset writes differently (no `RRULE:` prefix) selects that preset.
                Picker(CalendarStrings.eventFormRepeatLabel, selection: Binding(
                    get: { RepeatPreset.of(draft.recurrenceRule)?.rule ?? draft.recurrenceRule },
                    set: { draft.recurrenceRule = $0 }
                )) {
                    if RepeatPreset.of(draft.recurrenceRule) == nil {
                        Text(CalendarText.repeats(draft.recurrenceRule, calendar) ?? CalendarStrings.repeatKeepCustom)
                            .tag(draft.recurrenceRule)
                    }
                    ForEach(RepeatPreset.allCases) { preset in
                        Text(CalendarText.preset(preset)).tag(preset.rule)
                    }
                }
                .accessibilityIdentifier("event-repeat")
            } footer: {
                Text(CalendarStrings.eventFormTimeZoneNote(zone: TimeZone.current.identifier))
            }

            Section {
                TextField(CalendarStrings.eventFormLocationPlaceholder, text: $draft.location)
                    .accessibilityIdentifier("event-location")
                TextField(CalendarStrings.eventFormMeetingUrlPlaceholder, text: $draft.meetingURL)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityIdentifier("event-meeting-url")
                if showProblems, issues.badMeetingURL {
                    Text(CalendarStrings.eventFormMeetingUrlInvalid).font(.inter(.footnote)).foregroundStyle(Tokens.Status.danger)
                }
            } header: {
                Text(CalendarStrings.eventFormLocationLabel)
            }

            Section {
                Picker(CalendarStrings.eventFormStatusLabel, selection: $draft.status) {
                    ForEach(EventStatus.allCases) { status in
                        Text(CalendarText.status(status)).tag(status)
                    }
                }
                .accessibilityIdentifier("event-status")
                Picker(CalendarStrings.eventFormPriorityLabel, selection: $draft.priority) {
                    ForEach(EventPriority.allCases) { priority in
                        Text(CalendarText.priority(priority)).tag(priority)
                    }
                }
                .accessibilityIdentifier("event-priority")
            }

            Section {
                ForEach(draft.guests) { guest in
                    HStack {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(guest.label).lineLimit(1)
                            if guest.name != nil {
                                Text(guest.email).font(.inter(.footnote)).foregroundStyle(.secondary).lineLimit(1)
                            }
                        }
                        Spacer()
                        if guest.status != nil {
                            StatusBadge(CalendarText.response(guest.response), color: responseColor(guest.response))
                        }
                    }
                    .accessibilityIdentifier("guest-\(guest.email)")
                }
                .onDelete { offsets in draft.guests.remove(atOffsets: offsets) }
                HStack {
                    TextField(CalendarStrings.eventFormAttendeeEmailPlaceholder, text: $guestEmail)
                        .keyboardType(.emailAddress)
                        .textContentType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .onSubmit(addGuest)
                        .onChange(of: guestEmail) { guestProblemShown = nil }
                        .accessibilityIdentifier("attendee-email")
                    Button(CalendarStrings.eventFormAddAttendee, action: addGuest)
                        .disabled(guestEmail.trimmingCharacters(in: .whitespaces).isEmpty)
                        .accessibilityIdentifier("attendee-add")
                }
                if let problem = guestProblemShown {
                    Text(guestProblemText(problem)).font(.inter(.footnote)).foregroundStyle(Tokens.Status.danger)
                }
            } header: {
                Text(CalendarStrings.eventFormAttendeesLabel)
            } footer: {
                Text(CalendarStrings.eventFormAttendeesHint)
            }

            Section(CalendarStrings.eventFormDescriptionLabel) {
                TextField(CalendarStrings.eventFormDescriptionPlaceholder, text: $draft.description, axis: .vertical)
                    .lineLimit(3...8)
                    .accessibilityIdentifier("event-description")
            }

            if isEdit, hadGuests || !draft.guests.isEmpty {
                Section {
                    Toggle(CalendarStrings.eventFormNotifyLabel, isOn: $draft.notifyGuests)
                        .accessibilityIdentifier("event-notify")
                }
            }
        }
        .onAppear { if !isEdit { titleFocused = true } }
    }

    private func addGuest() {
        if let problem = guestProblem(guestEmail, guests: draft.guests) {
            guestProblemShown = problem
            return
        }
        draft.guests.append(Guest(email: guestEmail.trimmingCharacters(in: .whitespaces), name: nil, status: nil, role: nil))
        guestEmail = ""
        guestProblemShown = nil
    }

    private func guestProblemText(_ problem: GuestProblem) -> String {
        switch problem {
        case .invalid: return CalendarStrings.eventFormAttendeeInvalid
        case .duplicate: return CalendarStrings.eventFormAttendeeDuplicate
        case .limit: return CalendarStrings.eventFormAttendeeLimit
        }
    }
}
