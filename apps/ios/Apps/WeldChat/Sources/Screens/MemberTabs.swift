import SwiftUI
import UIKit
import WeldCore
import WeldUI

// MARK: - Overview

/// The member's Overview: one column of property rows (editable for
/// yourself or as an admin, per `canEdit`), then working hours, links and
/// your private note about this person.
struct MemberOverviewTab: View {
    let store: ChatStore
    @Binding var profile: MemberProfileInfo

    @Environment(Toaster.self) private var toaster
    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Spacing.l) {
            VStack(spacing: 0) {
                field(.title, symbol: "briefcase", label: ChatStrings.memberFieldsTitle, value: profile.title)
                field(.bio, symbol: "note.text", label: ChatStrings.memberFieldsBio, value: profile.bio, multiline: true)
                MemberPropertyRow(symbol: "envelope", label: ChatStrings.memberFieldsEmail, value: profile.email, render: { email in
                    AnyView(emailLink(email))
                })
                field(.phone, symbol: "phone", label: ChatStrings.memberFieldsPhone, value: profile.phone, keyboard: .phonePad, render: { phone in
                    AnyView(phoneLink(phone))
                })
                field(.location, symbol: "mappin.and.ellipse", label: ChatStrings.memberFieldsLocation, value: profile.location)
                field(.pronouns, symbol: "face.smiling", label: ChatStrings.memberFieldsPronouns, value: profile.pronouns)
                field(.hoursPerWeek, symbol: "clock", label: ChatStrings.memberFieldsHoursPerWeek, value: profile.hoursPerWeek, keyboard: .decimalPad)
                MemberPropertyRow(symbol: "shield", label: ChatStrings.memberFieldsRole, value: profile.role.isEmpty ? nil : MemberLogic.roleLabel(profile.role))
                MemberPropertyRow(symbol: "globe", label: ChatStrings.memberFieldsTimezone, value: profile.timezone, render: { zone in
                    AnyView(TimelineView(.periodic(from: .now, by: 30)) { context in
                        Text(Self.zoneLine(zone, at: context.date))
                    })
                })
            }

            if let week = MemberScreenRules.schedule(profile.workingHours) {
                VStack(alignment: .leading, spacing: Tokens.Spacing.s) {
                    Text(ChatStrings.memberWorkingHours).font(.inter(.headline))
                    ForEach(week, id: \.day) { entry in
                        HStack(alignment: .top) {
                            Text(MemberLogic.weekdayLabel(entry.day)).frame(width: 110, alignment: .leading)
                            Text(MemberScreenRules.dayHours(entry.hours))
                                .foregroundStyle(entry.hours?.isOpen == true ? Color.primary : Color.secondary)
                            Spacer(minLength: 0)
                        }
                        .font(.inter(.subheadline))
                    }
                }
            }

            if !profile.links.isEmpty {
                VStack(alignment: .leading, spacing: Tokens.Spacing.s) {
                    Text(ChatStrings.memberLinks).font(.inter(.headline))
                    ForEach(profile.links, id: \.self) { link in
                        Button {
                            if let url = URL(string: link.url) { openURL(url) }
                        } label: {
                            Label(link.label, systemImage: "link").foregroundStyle(Tokens.Palette.primary)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }

            MemberNoteView(store: store, userID: profile.userID)
        }
    }

    /// An editable field (when the profile allows it).
    private func field(
        _ kind: ProfileField,
        symbol: String,
        label: String,
        value: String?,
        multiline: Bool = false,
        keyboard: UIKeyboardType = .default,
        render: ((String) -> AnyView)? = nil
    ) -> some View {
        MemberPropertyRow(
            symbol: symbol,
            label: label,
            value: value,
            multiline: multiline,
            keyboard: keyboard,
            editable: profile.canEdit,
            onSave: { next in save(kind, next) },
            render: render
        )
    }

    /// Tap to write, hold to copy.
    private func emailLink(_ email: String) -> some View {
        Button {
            if let url = URL(string: "mailto:\(email)") { openURL(url) }
        } label: {
            Text(email).foregroundStyle(Tokens.Palette.primary).lineLimit(1)
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button {
                UIPasteboard.general.string = email
                toaster.show(ChatStrings.memberEmailCopied)
            } label: {
                Label(ChatStrings.messageActionsCopyText, systemImage: "doc.on.doc")
            }
        }
    }

    private func phoneLink(_ phone: String) -> some View {
        Button {
            let digits = phone.filter { $0.isNumber || $0 == "+" }
            if let url = URL(string: "tel:\(digits)") { openURL(url) }
        } label: {
            Text(phone).foregroundStyle(Tokens.Palette.primary)
        }
        .buttonStyle(.plain)
    }

    /// "Europe/Amsterdam · 14:05 (GMT+1)".
    static func zoneLine(_ zone: String, at date: Date) -> String {
        let offset = MemberLogic.offset(date, timezone: zone)
        let time = MemberLogic.localTime(date, timezone: zone)
        return offset.isEmpty ? "\(zone) · \(time)" : "\(zone) · \(time) (\(offset))"
    }

    private func save(_ field: ProfileField, _ value: String) {
        guard profile.canEdit else { return }
        let userID = profile.userID
        Task {
            do {
                profile = try await store.updateProfile(userID, field: field, value: value)
            } catch {
                toaster.show(ChatStrings.memberProfileSaveFailed)
            }
        }
    }
}

/// One field of a member: the icon and label, the value beside it. Empty
/// values read "Set {label}…"; an editable row turns into a text field on
/// tap and saves when it loses focus (or on return, when single-line).
struct MemberPropertyRow: View {
    let symbol: String
    let label: String
    let value: String?
    var multiline = false
    var keyboard: UIKeyboardType = .default
    var editable = false
    var onSave: ((String) -> Void)?
    var render: ((String) -> AnyView)?

    @State private var editing = false
    @State private var draft = ""
    @FocusState private var focused: Bool

    init(
        symbol: String,
        label: String,
        value: String?,
        multiline: Bool = false,
        keyboard: UIKeyboardType = .default,
        editable: Bool = false,
        onSave: ((String) -> Void)? = nil,
        render: ((String) -> AnyView)? = nil
    ) {
        self.symbol = symbol
        self.label = label
        self.value = value
        self.multiline = multiline
        self.keyboard = keyboard
        self.editable = editable
        self.onSave = onSave
        self.render = render
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Tokens.Spacing.m) {
            Label(label, systemImage: symbol)
                .font(.inter(.subheadline))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .frame(width: 130, alignment: .leading)
            Group {
                if editing {
                    TextField(label, text: $draft, axis: multiline ? .vertical : .horizontal)
                        .lineLimit(multiline ? 1...8 : 1...1)
                        .keyboardType(keyboard)
                        .focused($focused)
                        .submitLabel(.done)
                        .onSubmit { if !multiline { commit() } }
                        .onAppear { focused = true }
                        .accessibilityIdentifier("member-field-input")
                } else if let value, !value.isEmpty {
                    if let render {
                        render(value)
                    } else {
                        Text(value).fixedSize(horizontal: false, vertical: true)
                    }
                } else {
                    Text(ChatStrings.memberSetField(label: label)).foregroundStyle(.tertiary)
                }
            }
            .font(.inter(.subheadline))
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .onTapGesture {
                guard editable, !editing else { return }
                draft = value ?? ""
                editing = true
            }
        }
        .padding(.vertical, 10)
        .overlay(alignment: .bottom) { Divider() }
        .onChange(of: focused) { _, isFocused in
            if !isFocused, editing { commit() }
        }
        .accessibilityElement(children: editing ? .contain : .combine)
        .accessibilityAddTraits(editable && !editing ? .isButton : [])
    }

    private func commit() {
        editing = false
        focused = false
        if let next = MemberScreenRules.commit(draft, previous: value) { onSave?(next) }
    }
}

/// Your own note about this person, saved 600 ms after you stop typing. It
/// is only editable once it loaded, so a failed load can never be saved over.
struct MemberNoteView: View {
    let store: ChatStore
    let userID: String

    @Environment(Toaster.self) private var toaster
    @State private var draft = ""
    @State private var saved = ""
    @State private var loaded = false
    @State private var loadFailed = false
    @State private var pendingSave: Task<Void, Never>?
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Spacing.s) {
            Text(ChatStrings.memberPrivateNotes).font(.inter(.headline))
            if loadFailed {
                HStack {
                    Text(ChatStrings.memberNoteLoadFailed).font(.inter(.subheadline)).foregroundStyle(.secondary)
                    Spacer()
                    Button(CoreStrings.commonTryAgain) { Task { await load() } }
                        .font(.inter(.subheadline))
                }
            } else {
                TextField(ChatStrings.memberNotePlaceholder, text: $draft, axis: .vertical)
                    .lineLimit(4...12)
                    .focused($focused)
                    .disabled(!loaded)
                    .padding(Tokens.Spacing.m)
                    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: Tokens.Radius.medium))
                    .accessibilityIdentifier("member-note")
                if focused {
                    Text(ChatStrings.memberNoteLength(length: String(draft.count), max: String(MemberScreenRules.noteLimit)))
                        .font(.inter(.caption))
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                }
            }
        }
        .task(id: userID) { await load() }
        .onChange(of: draft) { _, text in changed(text) }
        .onDisappear { flush() }
    }

    private func load() async {
        loaded = false
        loadFailed = false
        do {
            let note = try await store.memberNote(userID)
            saved = note
            draft = note
            loaded = true
        } catch {
            loadFailed = true
        }
    }

    private func changed(_ text: String) {
        guard loaded else { return }
        if text.count > MemberScreenRules.noteLimit {
            draft = String(text.prefix(MemberScreenRules.noteLimit))
            return
        }
        guard text != saved else { return }
        pendingSave?.cancel()
        pendingSave = Task {
            try? await Task.sleep(for: .milliseconds(600))
            guard !Task.isCancelled else { return }
            await save(text)
        }
    }

    private func save(_ text: String) async {
        do {
            try await store.saveMemberNote(userID, body: text)
            saved = text
        } catch {
            toaster.show(ChatStrings.memberNoteSaveFailed)
        }
    }

    /// The last words, when the screen closes before the pause ran out.
    private func flush() {
        pendingSave?.cancel()
        pendingSave = nil
        guard loaded, draft != saved else { return }
        let text = draft
        let id = userID
        let store = store
        Task { try? await store.saveMemberNote(id, body: text) }
    }
}

// MARK: - Common

/// What you and this person share: conversations, projects, tasks, CRM
/// opportunities and helpdesk tickets.
struct MemberCommonTab: View {
    let store: ChatStore
    let userID: String

    @Environment(ChatNavigator.self) private var navigator
    @State private var info: CommonConceptsInfo?
    @State private var failed = false

    var body: some View {
        Group {
            if let info {
                if MemberScreenRules.commonCount(info) == 0 {
                    ChatEmptyState(title: ChatStrings.memberCommonEmptyTitle, description: ChatStrings.memberCommonEmptyDescription, symbol: "person.2")
                } else {
                    sections(info)
                }
            } else if failed {
                ChatEmptyState(title: ChatStrings.memberCommonLoadFailedTitle, description: ChatStrings.memberCommonLoadFailedDescription, symbol: "exclamationmark.triangle")
            } else {
                ProgressView().frame(maxWidth: .infinity).padding(.top, Tokens.Spacing.l)
            }
        }
        .task(id: userID) { await load() }
    }

    private func sections(_ info: CommonConceptsInfo) -> some View {
        VStack(alignment: .leading, spacing: Tokens.Spacing.l) {
            section(ChatStrings.memberCommonChannels, count: info.channels.count) {
                ForEach(info.channels) { channel in
                    Button {
                        navigator.openConversation(channelID: channel.id, name: channel.name, type: channel.type)
                    } label: {
                        row(
                            symbol: channel.type == "dm" ? "bubble.left" : (channel.type == "private" ? "lock" : "number"),
                            tint: .secondary,
                            label: MemberScreenRules.commonChannelLabel(channel),
                            hint: ChatStrings.memberCommonMemberCount(channel.memberCount)
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
            section(ChatStrings.memberCommonProjects, count: info.projects.count) {
                ForEach(info.projects) { project in
                    row(symbol: "folder", tint: Color(hex: 0x3B82F6), label: project.name, hint: project.status.map(MemberScreenRules.capitalizeWords))
                }
            }
            section(ChatStrings.memberCommonTasks, count: info.tasks.count) {
                ForEach(info.tasks) { task in
                    row(symbol: "checkmark.square", tint: Color(hex: 0xD97706), label: task.title, hint: MemberScreenRules.capitalizeWords(MemberScreenRules.taskHint(task)))
                }
            }
            section(ChatStrings.memberCommonCrm, count: info.crm.count) {
                ForEach(info.crm) { record in
                    row(symbol: "briefcase", tint: Color(hex: 0x059669), label: record.name, hint: MemberScreenRules.capitalizeWords(record.status ?? record.kind))
                }
            }
            section(ChatStrings.memberCommonHelpdesk, count: info.helpdesk.count) {
                ForEach(info.helpdesk) { ticket in
                    row(symbol: "lifepreserver", tint: Color(hex: 0xE11D48), label: ticket.subject, hint: MemberScreenRules.capitalizeWords(ticket.status))
                }
            }
        }
    }

    @ViewBuilder
    private func section<Content: View>(_ title: String, count: Int, @ViewBuilder content: () -> Content) -> some View {
        if count > 0 {
            VStack(alignment: .leading, spacing: Tokens.Spacing.s) {
                HStack(spacing: 6) {
                    Text(title).font(.inter(.headline))
                    Text(verbatim: "\(count)")
                        .font(.inter(.caption, weight: .semibold))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(Color(.secondarySystemBackground), in: Capsule())
                }
                content()
            }
        }
    }

    private func row(symbol: String, tint: Color, label: String, hint: String?) -> some View {
        HStack(spacing: Tokens.Spacing.m) {
            Image(systemName: symbol)
                .font(.inter(.caption))
                .foregroundStyle(tint)
                .frame(width: 28, height: 28)
                .background(tint.opacity(0.15), in: RoundedRectangle(cornerRadius: Tokens.Radius.small))
            VStack(alignment: .leading, spacing: 1) {
                Text(label).font(.inter(.subheadline)).lineLimit(1)
                if let hint, !hint.isEmpty {
                    Text(hint).font(.inter(.caption)).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
    }

    private func load() async {
        failed = false
        do {
            info = try await store.memberCommon(userID)
        } catch {
            if info == nil { failed = true }
        }
    }
}

// MARK: - Activity

/// The member's timeline: per day, what they did ("Ann created 4 ×
/// Project") with the time, and a card per named record.
struct MemberActivityTab: View {
    let store: ChatStore
    let userID: String
    let memberName: String?

    @State private var days: [MemberLogic.Day]?
    @State private var failed = false

    var body: some View {
        Group {
            if let days {
                if days.isEmpty {
                    ChatEmptyState(title: ChatStrings.memberActivityEmptyTitle, description: ChatStrings.memberActivityEmptyDescription, symbol: "waveform.path.ecg")
                } else {
                    timeline(days)
                }
            } else if failed {
                ChatEmptyState(title: ChatStrings.memberActivityLoadFailedTitle, description: ChatStrings.memberActivityLoadFailedDescription, symbol: "exclamationmark.triangle")
            } else {
                ProgressView().frame(maxWidth: .infinity).padding(.top, Tokens.Spacing.l)
            }
        }
        .task(id: userID) { await load() }
    }

    private func timeline(_ days: [MemberLogic.Day]) -> some View {
        VStack(alignment: .leading, spacing: Tokens.Spacing.l) {
            ForEach(days) { day in
                VStack(alignment: .leading, spacing: Tokens.Spacing.m) {
                    Text(MemberScreenRules.dayLabel(day.date))
                        .font(.inter(.footnote, weight: .semibold))
                        .foregroundStyle(.secondary)
                    ForEach(day.events) { event in eventRow(event) }
                }
            }
        }
    }

    private func eventRow(_ event: MemberLogic.TimelineEvent) -> some View {
        HStack(alignment: .top, spacing: Tokens.Spacing.m) {
            Image(systemName: MemberScreenRules.entitySymbol(event.entityType))
                .font(.inter(.caption2))
                .foregroundStyle(.secondary)
                .frame(width: 24, height: 24)
                .background(Color(.secondarySystemBackground), in: Circle())
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline) {
                    Text(sentence(event)).font(.inter(.subheadline))
                    Spacer(minLength: Tokens.Spacing.s)
                    if let date = WeldDate.parse(event.latest.createdAt) {
                        Text(MemberScreenRules.eventTime(date)).font(.inter(.caption)).foregroundStyle(.secondary)
                    }
                }
                ForEach(MemberScreenRules.cards(event)) { card in
                    HStack(spacing: Tokens.Spacing.s) {
                        Image(systemName: MemberScreenRules.entitySymbol(event.entityType))
                            .font(.inter(.caption))
                            .foregroundStyle(.secondary)
                        Text(card.title).font(.inter(.subheadline)).lineLimit(1)
                        if let count = MemberScreenRules.cardCount(card) {
                            Text(verbatim: "×\(count)")
                                .font(.inter(.caption2, weight: .semibold))
                                .padding(.horizontal, 5)
                                .padding(.vertical, 1)
                                .background(Color(.tertiarySystemFill), in: Capsule())
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(Tokens.Spacing.s)
                    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: Tokens.Radius.small))
                }
            }
        }
    }

    private func sentence(_ event: MemberLogic.TimelineEvent) -> String {
        let text = MemberScreenRules.sentence(event, memberName: memberName)
        guard let repeats = MemberScreenRules.eventRepeats(event) else { return text }
        return "\(text)  ×\(repeats)"
    }

    private func load() async {
        failed = false
        do {
            let entries = try await store.memberActivity(userID)
            days = MemberLogic.timeline(entries)
        } catch {
            if days == nil { failed = true }
        }
    }
}
