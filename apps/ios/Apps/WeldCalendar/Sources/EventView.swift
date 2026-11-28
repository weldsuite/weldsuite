import SwiftUI
import WeldCore
import WeldUI

/// One event, as the platform's event panel shows it: the colour and the
/// title, the description, then the details (type, calendar, when, priority,
/// status, location, meeting, attendees, created). Edit and delete for
/// calendars the person may write to; a view-only calendar's events open here
/// too, with a note saying why there's nothing to change.
struct EventView: View {
    let env: AppEnvironment
    let store: CalendarStore
    let eventID: String
    let onEdit: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @Environment(Toaster.self) private var toaster
    @Environment(\.displayScale) private var displayScale
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
        .navigationTitle(CalendarStrings.eventDetailTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                if let event, editable {
                    Button { onEdit(event.id) } label: { Image(systemName: "pencil") }
                        .accessibilityLabel(CalendarStrings.eventEdit)
                        .accessibilityIdentifier("event-edit")
                    Button(role: .destructive) { confirmDelete = true } label: {
                        Image(systemName: "trash").foregroundStyle(Tokens.Status.danger)
                    }
                    .disabled(deleting)
                    .accessibilityLabel(CalendarStrings.eventDelete)
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
                Button(CalendarStrings.eventDelete, role: .destructive) { delete(notify: false) }
                    .accessibilityIdentifier("event-delete-confirm")
            }
        } message: {
            Text(event?.guests.isEmpty == false
                ? CalendarStrings.eventDeleteAttendeesMessage
                : CalendarStrings.eventDeleteMessage(title: event?.title ?? ""))
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
        let info = store.calendars.data?.first { $0.id == event.calendarID }
        let color = Color(hex: eventColor(event.color, event.type, calendarColor: info?.color))
        // An empty field invites a value where it can be changed, as the platform's panel does.
        let edit: (() -> Void)? = editable ? { onEdit(event.id) } : nil
        return ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .top, spacing: Tokens.Spacing.s) {
                    RoundedRectangle(cornerRadius: 4).fill(color).frame(width: 12, height: 12).padding(.top, 5)
                    Text(event.title)
                        .font(.inter(.headline))
                        .foregroundStyle(Tokens.Palette.foreground)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.horizontal, Tokens.Spacing.l)
                .padding(.top, Tokens.Spacing.s)

                if event.description != nil || editable {
                    let text = Text(event.description ?? CalendarStrings.eventAddDescription)
                        .font(.inter(.subheadline))
                        .foregroundStyle(Tokens.Palette.mutedForeground)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, Tokens.Spacing.l)
                        .padding(.vertical, Tokens.Spacing.s)
                    if event.description == nil, let edit {
                        Button(action: edit) { text }.buttonStyle(.plain)
                    } else {
                        text
                    }
                }

                if !editable {
                    notice("lock", CalendarStrings.eventReadOnly, CalendarStrings.eventReadOnlyHint)
                }
                if event.autoScheduled {
                    notice("sparkles", CalendarStrings.eventAutoScheduled, CalendarStrings.eventAutoScheduledHint)
                }

                detailsTab

                VStack(alignment: .leading, spacing: Tokens.Spacing.xs) {
                    field("smallcircle.filled.circle", CalendarStrings.eventType) {
                        TintBadge(text: CalendarText.eventType(event), color: color)
                    }
                    field("calendar", CalendarStrings.eventCalendar) {
                        if let info {
                            HStack(spacing: Tokens.Spacing.s) {
                                ColorDot(hex: info.color)
                                Text(info.name).font(.inter(.subheadline))
                            }
                        } else {
                            empty(CalendarStrings.commonDash)
                        }
                    }
                    field("clock", CalendarStrings.eventWhen, onTap: edit) {
                        Text(CalendarText.when(event, calendar))
                            .font(.inter(.subheadline))
                            .accessibilityIdentifier("event-when")
                    }
                    if let repeats = CalendarText.repeats(event.recurrenceRule, calendar) {
                        field("repeat", CalendarStrings.eventRepeats, onTap: edit) {
                            Text(repeats).font(.inter(.subheadline))
                        }
                    }
                    field("flag", CalendarStrings.eventPriority, onTap: event.priority == nil ? edit : nil) {
                        if let priority = event.priority {
                            MutedBadge(text: CalendarText.priority(priority))
                        } else {
                            empty(editable ? CalendarStrings.eventSetPriority : CalendarStrings.commonDash)
                        }
                    }
                    field("smallcircle.filled.circle", CalendarStrings.eventStatus) {
                        MutedBadge(text: CalendarText.status(event.status ?? .confirmed))
                    }
                    field("mappin.and.ellipse", CalendarStrings.eventLocation, onTap: event.location == nil ? edit : nil) {
                        if let location = event.location {
                            Text(location).font(.inter(.subheadline))
                        } else {
                            empty(editable ? CalendarStrings.eventSetLocation : CalendarStrings.commonDash)
                        }
                    }
                    field("video", CalendarStrings.eventMeeting) {
                        if let link = event.meetingURL {
                            Button {
                                if let url = URL(string: link) { openURL(url) }
                            } label: {
                                Text(link)
                                    .font(.inter(.subheadline))
                                    .foregroundStyle(Tokens.Palette.primary)
                                    .lineLimit(1)
                                    .truncationMode(.tail)
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("join-meeting")
                        } else {
                            empty(CalendarStrings.commonDash)
                        }
                    }
                    field("person.2", CalendarStrings.eventAttendees, onTap: event.guests.isEmpty ? edit : nil) {
                        if event.guests.isEmpty {
                            empty(editable ? CalendarStrings.eventAddAttendees : CalendarStrings.commonDash)
                        } else {
                            VStack(alignment: .leading, spacing: Tokens.Spacing.xs) {
                                ForEach(event.guests) { guest in
                                    HStack(spacing: Tokens.Spacing.s) {
                                        AttendeeAvatar(email: guest.email, name: guest.name)
                                        Text(guest.label)
                                            .font(.inter(.subheadline))
                                            .foregroundStyle(Tokens.Palette.mutedForeground)
                                            .lineLimit(1)
                                        if guest.status != nil {
                                            StatusBadge(CalendarText.response(guest.response), color: responseColor(guest.response))
                                        }
                                    }
                                    .accessibilityElement(children: .combine)
                                    .accessibilityIdentifier("guest")
                                }
                            }
                        }
                    }
                    field("clock", CalendarStrings.eventCreated) {
                        if let created = event.createdAt {
                            Text(CalendarText.created(created)).font(.inter(.subheadline))
                        } else {
                            empty(CalendarStrings.commonDash)
                        }
                    }
                }
                .padding(Tokens.Spacing.l)
            }
            .padding(.bottom, Tokens.Spacing.xl)
        }
        .background(Tokens.Palette.background)
    }

    /// The panel's single "Details" tab: its label over a 2pt line, on a hairline across.
    private var detailsTab: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(spacing: 0) {
                Text(CalendarStrings.eventDetails)
                    .font(.inter(.subheadline, weight: .medium))
                    .foregroundStyle(Tokens.Palette.foreground)
                    .padding(.horizontal, Tokens.Spacing.xs)
                    .padding(.vertical, Tokens.Spacing.s)
                Rectangle().fill(Tokens.Palette.foreground).frame(height: 2)
            }
            .fixedSize()
            .padding(.leading, Tokens.Spacing.l)
            Rectangle().fill(Tokens.Palette.border).frame(height: 1 / displayScale)
        }
        .padding(.top, Tokens.Spacing.s)
        .accessibilityAddTraits(.isHeader)
    }

    /// A row of the panel's details: the icon and label in a fixed column, the
    /// value beside it. `onTap` opens the form, where the value is changed.
    private func field<Value: View>(
        _ icon: String,
        _ label: String,
        onTap: (() -> Void)? = nil,
        @ViewBuilder value: () -> Value
    ) -> some View {
        let row = HStack(alignment: .top, spacing: Tokens.Spacing.m) {
            HStack(spacing: Tokens.Spacing.s) {
                Image(systemName: icon)
                    .font(.system(size: 14))
                    .foregroundStyle(Tokens.Palette.mutedForeground)
                    .frame(width: 16)
                Text(label)
                    .font(.inter(.subheadline))
                    .foregroundStyle(Tokens.Palette.mutedForeground)
                    .lineLimit(1)
            }
            .frame(width: 128, alignment: .leading)
            .frame(minHeight: 28)
            value()
                .frame(maxWidth: .infinity, minHeight: 28, alignment: .leading)
        }
        .padding(.vertical, Tokens.Spacing.xs)
        .contentShape(Rectangle())
        return Group {
            if let onTap {
                Button(action: onTap) { row }.buttonStyle(.plain)
            } else {
                row
            }
        }
    }

    private func empty(_ text: String) -> some View {
        Text(text).font(.inter(.subheadline)).foregroundStyle(Tokens.Palette.mutedForeground)
    }

    /// A note under the title: view only, scheduled automatically.
    private func notice(_ icon: String, _ title: String, _ text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Tokens.Spacing.s) {
            Image(systemName: icon).font(.system(size: 12))
            Text("\(title) · \(text)").font(.inter(.caption))
        }
        .foregroundStyle(Tokens.Palette.mutedForeground)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, Tokens.Spacing.l)
        .padding(.vertical, Tokens.Spacing.xs)
    }
}
