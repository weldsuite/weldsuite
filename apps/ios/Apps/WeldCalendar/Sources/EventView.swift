import SwiftUI
import WeldCore
import WeldUI

/// One event: when, where, who, and edit and delete for calendars the person
/// may write to. A view-only calendar's events open here too, with a note
/// saying why there's nothing to change.
struct EventView: View {
    let env: AppEnvironment
    let store: CalendarStore
    let eventID: String
    let onEdit: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @Environment(Toaster.self) private var toaster
    @State private var state = LoadState<CalendarEvent>()
    @State private var confirmDelete = false
    @State private var deleting = false

    private var calendar: Calendar { CalendarDates.calendar() }

    var body: some View {
        let event = state.data
        let editable = event.map { CalendarAccess.canEdit($0, store.calendars.data ?? []) } ?? false
        Group {
            if let event {
                details(event, editable: editable)
            } else if state.error?.status == 404 {
                ContentUnavailableView {
                    Label(CalendarStrings.eventNotFound, systemImage: "calendar.badge.exclamationmark")
                } actions: {
                    Button(CoreStrings.commonTryAgain) { Task { await load() } }
                        .accessibilityIdentifier("retry")
                }
            } else if let error = state.error {
                LoadErrorView(error: error) { await load() }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .navigationTitle(event?.title ?? CalendarStrings.eventDetailTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                if let event, editable {
                    Button { onEdit(event.id) } label: { Image(systemName: "pencil") }
                        .accessibilityLabel(CalendarStrings.eventEdit)
                        .accessibilityIdentifier("event-edit")
                    Button(role: .destructive) { confirmDelete = true } label: { Image(systemName: "trash") }
                        .disabled(deleting)
                        .accessibilityLabel(CoreStrings.commonDelete)
                        .accessibilityIdentifier("event-delete")
                }
            }
        }
        .confirmationDialog(CalendarStrings.eventDeleteTitle, isPresented: $confirmDelete, titleVisibility: .visible) {
            if event?.guests.isEmpty == false {
                Button(CalendarStrings.eventDeleteAndNotify, role: .destructive) { delete(notify: true) }
                    .accessibilityIdentifier("event-delete-notify")
                Button(CalendarStrings.eventDeleteQuietly, role: .destructive) { delete(notify: false) }
                    .accessibilityIdentifier("event-delete-confirm")
            } else {
                Button(CoreStrings.commonDelete, role: .destructive) { delete(notify: false) }
                    .accessibilityIdentifier("event-delete-confirm")
            }
        } message: {
            Text(event?.guests.isEmpty == false ? CalendarStrings.eventDeleteAttendeesMessage : CalendarStrings.eventDeleteMessage)
        }
        .task(id: "\(eventID)-\(store.changes)") { await load() }
        .realtimeRefresh(env, topics: calendarTopics) {
            if !deleting { await load() }
        }
    }

    private func load() async {
        state.loading = true
        state.error = nil
        do {
            state = LoadState(data: try await store.event(id: eventID))
        } catch {
            state = LoadState(data: state.data, error: APIError.from(error))
        }
    }

    private func delete(notify: Bool) {
        deleting = true
        Task {
            do {
                try await store.delete(id: eventID, notifyGuests: notify)
                dismiss()
            } catch {
                deleting = false
                toaster.show(CalendarText.failure(CalendarStrings.eventDeleteFailed, error))
            }
        }
    }

    private func details(_ event: CalendarEvent, editable: Bool) -> some View {
        let calendarName = store.calendars.data?.first { $0.id == event.calendarID }?.name
        let accent = Color(hex: eventColor(event.color, event.type))
        let day = Day(event.start, calendar: calendar)
        let today = Day(Date(), calendar: calendar)
        return List {
            Section {
                HStack(spacing: Tokens.Spacing.s) {
                    if event.isTask {
                        TintChip(text: CalendarStrings.eventTask, hex: taskHex)
                    } else {
                        TintChip(text: CalendarText.type(event.type), hex: typeColor(event.type))
                    }
                    StatePill(event: event)
                    PriorityBadge(priority: event.priority)
                }
                HStack(spacing: Tokens.Spacing.m) {
                    RoundedRectangle(cornerRadius: 2).fill(accent).frame(width: 4)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(CalendarText.dayHeading(day, today: today, calendar)).font(.inter(.title3, weight: .bold))
                        Text([CalendarText.timeRange(event, calendar), CalendarText.duration(event)].compactMap { $0 }.joined(separator: " · "))
                            .font(.inter(.subheadline))
                            .foregroundStyle(.secondary)
                            .accessibilityIdentifier("event-when")
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
            }

            if !editable {
                notice(CalendarStrings.eventReadOnly, CalendarStrings.eventReadOnlyHint)
            }
            if event.autoScheduled {
                notice(CalendarStrings.eventAutoScheduled, CalendarStrings.eventAutoScheduledHint)
            }

            if let description = event.description {
                Section(CalendarStrings.eventDescription) { Text(description) }
            }

            Section(CalendarStrings.eventDetails) {
                LabeledContent(CalendarStrings.eventCalendar, value: calendarName ?? CalendarStrings.commonDash)
                LabeledContent(CalendarStrings.eventWhen, value: CalendarText.weekdayDate(day, calendar))
                if let repeats = CalendarText.repeats(event.recurrenceRule, calendar) {
                    LabeledContent(CalendarStrings.eventRepeats, value: repeats)
                }
                if let location = event.location {
                    LabeledContent(CalendarStrings.eventLocation, value: location)
                }
                if let zone = event.timezone {
                    VStack(alignment: .leading, spacing: 4) {
                        LabeledContent(CalendarStrings.eventTimezone, value: zone)
                        if zone != TimeZone.current.identifier {
                            Text(CalendarStrings.eventTimezoneShown(zone: zone)).font(.inter(.footnote)).foregroundStyle(.secondary)
                        }
                    }
                }
            }

            if let link = event.meetingURL {
                Section(CalendarStrings.eventMeetingLink) {
                    Button {
                        if let url = URL(string: link) { openURL(url) }
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Label(CalendarStrings.eventJoinMeeting, systemImage: "arrow.up.right.square").font(.inter(.body, weight: .semibold))
                            Text(link).font(.inter(.caption)).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                    .accessibilityIdentifier("join-meeting")
                }
            }

            if !event.guests.isEmpty {
                Section {
                    let answers = guestAnswers(event.guests)
                    Text(CalendarStrings.eventAttendeeAnswers(
                        acceptedCount: answers.accepted,
                        tentativeCount: answers.tentative,
                        declinedCount: answers.declined,
                        pendingCount: answers.pending
                    ))
                    .font(.inter(.footnote))
                    .foregroundStyle(.secondary)
                    ForEach(event.guests) { guest in
                        HStack(spacing: Tokens.Spacing.m) {
                            AvatarView(name: guest.label, size: 32)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(guest.label).lineLimit(1)
                                if guest.name != nil {
                                    Text(guest.email).font(.inter(.footnote)).foregroundStyle(.secondary).lineLimit(1)
                                }
                            }
                            Spacer()
                            StatusBadge(CalendarText.response(guest.response), color: responseColor(guest.response))
                        }
                        .accessibilityElement(children: .combine)
                        .accessibilityIdentifier("guest")
                    }
                } header: {
                    Text(CalendarStrings.eventAttendeeCount(event.guests.count))
                }
            }

            if let notes = event.notes {
                Section(CalendarStrings.eventNotes) { Text(notes) }
            }
        }
        .listStyle(.insetGrouped)
    }

    private func notice(_ title: String, _ text: String) -> some View {
        Section {
            Label {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.inter(.subheadline, weight: .semibold))
                    Text(text).font(.inter(.footnote)).foregroundStyle(.secondary)
                }
            } icon: {
                Image(systemName: "info.circle").foregroundStyle(Tokens.Palette.primary)
            }
        }
    }
}
