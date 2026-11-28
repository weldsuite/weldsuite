import SwiftUI
import UIKit
import WeldCore
import WeldUI

/// One choice in a "when" sheet.
struct TimeChoice: Identifiable {
    let id: String
    let label: String
    let systemImage: String
    let date: Date

    /// "Snooze until": in an hour, four hours, tomorrow morning, next Monday.
    static func snooze(now: Date = Date()) -> [TimeChoice] {
        MailLogic.snoozePresets(now: now).map { choice in
            switch choice.preset {
            case .inOneHour: return TimeChoice(id: "snooze-1h", label: MailStrings.snoozeInOneHour, systemImage: "clock", date: choice.date)
            case .inFourHours: return TimeChoice(id: "snooze-4h", label: MailStrings.snoozeInFourHours, systemImage: "clock", date: choice.date)
            case .tomorrowMorning: return TimeChoice(id: "snooze-tomorrow", label: MailStrings.snoozeTomorrowMorning, systemImage: "sun.max", date: choice.date)
            case .nextMonday: return TimeChoice(id: "snooze-monday", label: MailStrings.snoozeNextMonday, systemImage: "calendar", date: choice.date)
            }
        }
    }

    /// "Send later" / "Schedule send": the quick choices.
    static func sendLater(now: Date = Date()) -> [TimeChoice] {
        MailLogic.sendLaterPresets(now: now).map { choice in
            switch choice.preset {
            case .inOneHour: return TimeChoice(id: "later-1h", label: MailStrings.sendLaterInOneHour, systemImage: "clock", date: choice.date)
            case .inTwoHours: return TimeChoice(id: "later-2h", label: MailStrings.sendLaterInTwoHours, systemImage: "clock", date: choice.date)
            case .tomorrowMorning: return TimeChoice(id: "later-morning", label: MailStrings.sendLaterTomorrowMorning, systemImage: "cup.and.saucer", date: choice.date)
            case .tomorrowAfternoon: return TimeChoice(id: "later-afternoon", label: MailStrings.sendLaterTomorrowAfternoon, systemImage: "sun.max", date: choice.date)
            }
        }
    }
}

/// A sheet of moments to choose from, and optionally "Pick date & time".
struct TimeChoiceSheet: View {
    let title: String
    let choices: [TimeChoice]
    let tint: Color
    let onChoose: (Date) -> Void
    var onPick: (() -> Void)?

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                ForEach(choices) { choice in
                    Button {
                        onChoose(choice.date)
                    } label: {
                        Label {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(choice.label).foregroundStyle(.primary)
                                Text(momentText(choice.date)).font(.inter(.caption)).foregroundStyle(.secondary)
                            }
                        } icon: {
                            Image(systemName: choice.systemImage).foregroundStyle(tint)
                        }
                    }
                    .accessibilityIdentifier(choice.id)
                }
                if let onPick {
                    Button {
                        onPick()
                    } label: {
                        Label {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(MailStrings.sendLaterPick).foregroundStyle(.primary)
                                Text(MailStrings.sendLaterPickHint).font(.inter(.caption)).foregroundStyle(.secondary)
                            }
                        } icon: {
                            Image(systemName: "calendar.badge.clock").foregroundStyle(tint)
                        }
                    }
                    .accessibilityIdentifier("send-later-pick")
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(CoreStrings.commonCancel) { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

/// A day and a time: the moment a message goes out. A time outside the
/// server's window (the past, or more than a year out) is refused here
/// instead of by the server.
struct DateTimeSheet: View {
    let onConfirm: (Date) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var date: Date = {
        let calendar = Calendar.current
        let tomorrow = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: Date())) ?? Date()
        return calendar.date(bySettingHour: 9, minute: 0, second: 0, of: tomorrow) ?? tomorrow
    }()

    var body: some View {
        let now = Date()
        let moment = MailLogic.wholeMinute(date)
        let valid = MailLogic.isWithinScheduleWindow(moment, now: now)
        let latest = now.addingTimeInterval(TimeInterval(MailLogic.maxScheduleDays) * 86_400)
        NavigationStack {
            Form {
                DatePicker(
                    MailStrings.sendLaterPickTitle,
                    selection: $date,
                    in: Calendar.current.startOfDay(for: now)...latest,
                    displayedComponents: [.date, .hourAndMinute]
                )
                .datePickerStyle(.graphical)
                .accessibilityIdentifier("date-time-picker")
                Section {
                    Text(momentText(moment))
                    if !valid {
                        Text(moment > now ? MailStrings.sendLaterTooFar : MailStrings.sendLaterInPast)
                            .font(.inter(.footnote))
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle(MailStrings.sendLaterPickTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(CoreStrings.commonCancel) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(CoreStrings.commonDone) { onConfirm(moment) }
                        .disabled(!valid)
                        .accessibilityIdentifier("date-time-done")
                }
            }
        }
    }
}

/// The mailbox's own labels, checked where the message has them.
struct LabelPickerSheet: View {
    let labels: [CustomLabel]
    let current: [String]
    let onSave: (_ add: [String], _ remove: [String]) async -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var selected: Set<String> = []
    @State private var saving = false

    var body: some View {
        NavigationStack {
            List {
                if labels.isEmpty {
                    Text(MailStrings.labelPickerEmpty).foregroundStyle(.secondary)
                }
                ForEach(labels) { label in
                    let checked = selected.contains(label.name)
                    Button {
                        if checked { selected.remove(label.name) } else { selected.insert(label.name) }
                    } label: {
                        HStack {
                            Circle().fill(labelTint(label.name, own: label.color)).frame(width: 10, height: 10)
                            Text(label.name).foregroundStyle(.primary)
                            Spacer()
                            if checked { Image(systemName: "checkmark").foregroundStyle(Color.accentColor) }
                        }
                    }
                    .accessibilityIdentifier("label-\(label.name)")
                    .accessibilityAddTraits(checked ? .isSelected : [])
                }
            }
            .navigationTitle(MailStrings.labelPickerTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(CoreStrings.commonCancel) { dismiss() }.disabled(saving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if saving {
                        ProgressView()
                    } else {
                        Button(CoreStrings.commonSave) { save() }
                            .accessibilityIdentifier("labels-save")
                    }
                }
            }
        }
        .onAppear { selected = Set(current) }
        .interactiveDismissDisabled(saving)
    }

    private func save() {
        let add = Array(selected.subtracting(current))
        let remove = current.filter { !selected.contains($0) && !MailLogic.isSystemLabel($0) }
        if add.isEmpty && remove.isEmpty {
            dismiss()
            return
        }
        saving = true
        Task {
            await onSave(add, remove)
            saving = false
        }
    }
}

/// A new label: a name and, optionally, a colour.
struct CreateLabelSheet: View {
    let aiAvailable: Bool
    let onCreate: (_ name: String, _ color: String?) async throws -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var color: String?
    @State private var saving = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                TextField(MailStrings.createLabelNamePlaceholder, text: $name)
                    .accessibilityIdentifier("label-name")
                    .onChange(of: name) { _, value in if value.count > 100 { name = String(value.prefix(100)) } }
                Section(MailStrings.createLabelColor) {
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 4), spacing: Tokens.Spacing.m) {
                        ForEach(MailLogic.labelChoices, id: \.key) { choice in
                            let hex = String(format: "#%06lX", choice.value)
                            let chosen = color == hex
                            Button {
                                color = chosen ? nil : hex
                            } label: {
                                Circle()
                                    .fill(Color(mailRGB: choice.value))
                                    .frame(width: 32, height: 32)
                                    .overlay {
                                        if chosen { Image(systemName: "checkmark").font(.inter(.caption, weight: .bold)).foregroundStyle(.white) }
                                    }
                                    .overlay(Circle().stroke(Color.primary, lineWidth: chosen ? 3 : 0))
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(colorName(choice.key))
                            .accessibilityAddTraits(chosen ? .isSelected : [])
                        }
                    }
                    .padding(.vertical, Tokens.Spacing.s)
                }
                if aiAvailable {
                    Text(MailStrings.createLabelAiNote).font(.inter(.footnote)).foregroundStyle(.secondary)
                }
                if let error {
                    Text(error).font(.inter(.footnote)).foregroundStyle(.red)
                }
            }
            .navigationTitle(MailStrings.createLabelTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(CoreStrings.commonCancel) { dismiss() }.disabled(saving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(MailStrings.createLabelCreate) { create() }
                        .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || saving)
                        .accessibilityIdentifier("label-create")
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func create() {
        saving = true
        error = nil
        Task {
            do {
                try await onCreate(name.trimmingCharacters(in: .whitespaces), color)
                dismiss()
            } catch {
                self.error = APIError.from(error).status == 409 ? MailStrings.createLabelExists : MailStrings.createLabelFailed
            }
            saving = false
        }
    }

    private func colorName(_ key: String) -> String {
        switch key {
        case "red": return MailStrings.colorsRed
        case "orange": return MailStrings.colorsOrange
        case "yellow": return MailStrings.colorsYellow
        case "green": return MailStrings.colorsGreen
        case "teal": return MailStrings.colorsTeal
        case "blue": return MailStrings.colorsBlue
        case "purple": return MailStrings.colorsPurple
        default: return MailStrings.colorsPink
        }
    }
}

/// "Unsubscribe from …?" with what will happen.
enum Unsubscribing {
    static func message(_ subscription: MailSubscription) -> String {
        let sender = subscription.senderLabel
        if subscription.oneClick && subscription.unsubscribeURL != nil { return MailStrings.unsubscribeConfirmOneClick(sender: sender) }
        if subscription.unsubscribeMailto != nil { return MailStrings.unsubscribeConfirmMailto(sender: sender) }
        return MailStrings.unsubscribeConfirmLink(sender: sender)
    }

    static func confirmLabel(_ subscription: MailSubscription) -> String {
        MailLogic.isLinkOnly(subscription) ? MailStrings.unsubscribeOpenPage : MailStrings.unsubscribeButton
    }

    /// Tells how the unsubscribe went, and opens the sender's page when that is still needed.
    @MainActor
    static func announce(_ result: UnsubscribeResult, sender: String, notifier: MailNotifier) {
        switch result.method {
        case .oneClick:
            notifier.show(MailStrings.unsubscribeDoneOneClick(sender: sender))
        case .mailto:
            notifier.show(MailStrings.unsubscribeDoneMailto(sender: sender))
        case .link:
            notifier.show(MailStrings.unsubscribeDoneLink(sender: sender))
            if let url = result.url, EmailHTML.linkAction(url) == .browser { openExternal(url) }
        }
    }
}
