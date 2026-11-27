import SwiftUI
import UIKit
import WeldCore
import WeldUI

extension Color {
    /// A colour from `0xRRGGBB`.
    init(mailRGB value: Int) {
        self.init(
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255
        )
    }
}

/// Colours of the mail actions (swipes, header icons), as the Expo app uses them.
enum MailColors {
    static let read = Color(mailRGB: 0x3B82F6)
    static let star = Color(mailRGB: 0xF59E0B)
    static let archive = Color(mailRGB: 0x3B82F6)
    static let snooze = Color(mailRGB: 0xF59E0B)
    static let delete = Color(mailRGB: 0xEF4444)
    static let pin = Color(mailRGB: 0x8B5CF6)
}

/// A short message at the bottom of the screen, with an optional action
/// (Undo, Discard): the core's `Toaster` has no action.
@MainActor
@Observable
final class MailNotifier {
    struct Notice: Identifiable, Equatable {
        let id = UUID()
        let text: String
        let action: String?
    }

    private(set) var notice: Notice?
    @ObservationIgnored private var onAction: (() -> Void)?
    @ObservationIgnored private var hideTask: Task<Void, Never>?

    func show(_ text: String, action: String? = nil, onAction: (() -> Void)? = nil) {
        let next = Notice(text: text, action: action)
        notice = next
        self.onAction = onAction
        hideTask?.cancel()
        hideTask = Task {
            try? await Task.sleep(for: .seconds(action == nil ? 3 : 6))
            if !Task.isCancelled, notice?.id == next.id { notice = nil }
        }
    }

    func show(_ error: Error) {
        show(apiErrorMessage(APIError.from(error)))
    }

    func perform() {
        let action = onAction
        notice = nil
        onAction = nil
        action?()
    }
}

extension View {
    /// Shows the notifier's message over this view, and puts the notifier in the environment.
    func mailNotices(_ notifier: MailNotifier) -> some View {
        environment(notifier)
            .overlay(alignment: .bottom) {
                if let notice = notifier.notice {
                    HStack(spacing: Tokens.Spacing.m) {
                        Text(notice.text)
                            .font(.subheadline)
                            .lineLimit(3)
                        if let action = notice.action {
                            Button(action) { notifier.perform() }
                                .font(.subheadline.weight(.semibold))
                                .accessibilityIdentifier("toast-action")
                        }
                    }
                    .padding(.horizontal, Tokens.Spacing.l)
                    .padding(.vertical, Tokens.Spacing.m)
                    .background(.thinMaterial, in: Capsule())
                    .padding(.horizontal, Tokens.Spacing.l)
                    .padding(.bottom, 90)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .accessibilityIdentifier("toast")
                }
            }
            .animation(.default, value: notifier.notice)
    }
}

/// The sender's initial on a coloured circle.
struct SenderAvatar: View {
    let name: String
    var size: CGFloat = 40

    var body: some View {
        let shown = name.trimmingCharacters(in: .whitespaces)
        Text(shown.first.map { String($0).uppercased() } ?? "?")
            .font(.system(size: size * 0.42, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(Color(mailRGB: MailLogic.avatarColor(shown.isEmpty ? "?" : shown)), in: Circle())
            .accessibilityHidden(true)
    }
}

/// A custom label on a row: its name on its colour, tinted.
struct LabelChip: View {
    let name: String
    let color: Int

    var body: some View {
        let tint = Color(mailRGB: color)
        Text(name)
            .font(.caption2)
            .lineLimit(1)
            .foregroundStyle(tint)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 4))
    }
}

/// The slim bar while the phone is offline.
struct OfflineBanner: View {
    var body: some View {
        HStack(spacing: Tokens.Spacing.s) {
            Image(systemName: "wifi.slash").foregroundStyle(Tokens.Status.warning)
            Text(MailStrings.inboxOffline).font(.footnote).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 6)
        .background(Color(.secondarySystemBackground))
        .accessibilityIdentifier("offline-banner")
    }
}

extension SystemLabel {
    /// A system folder's name.
    var title: String {
        switch self {
        case .inbox: return MailStrings.labelsInbox
        case .promotions: return MailStrings.labelsPromotions
        case .starred: return MailStrings.labelsStarred
        case .sent: return MailStrings.labelsSent
        case .drafts: return MailStrings.labelsDrafts
        case .scheduled: return MailStrings.labelsScheduled
        case .snoozed: return MailStrings.labelsSnoozed
        case .important: return MailStrings.labelsImportant
        case .all: return MailStrings.labelsAll
        case .archive: return MailStrings.labelsArchive
        case .spam: return MailStrings.labelsSpam
        case .trash: return MailStrings.labelsTrash
        }
    }

    var systemImage: String {
        switch self {
        case .inbox: return "tray"
        case .promotions: return "tag"
        case .starred: return "star"
        case .sent: return "paperplane"
        case .drafts: return "doc"
        case .scheduled: return "calendar"
        case .snoozed: return "clock"
        case .important: return "exclamationmark.square"
        case .all: return "envelope"
        case .archive: return "archivebox"
        case .spam: return "exclamationmark.octagon"
        case .trash: return "trash"
        }
    }
}

/// The empty state of a folder: title and description.
func emptyText(_ label: SystemLabel?) -> (title: String, description: String) {
    switch label {
    case .inbox: return (MailStrings.emptyInboxTitle, MailStrings.emptyInboxDescription)
    case .sent: return (MailStrings.emptySentTitle, MailStrings.emptySentDescription)
    case .drafts: return (MailStrings.emptyDraftsTitle, MailStrings.emptyDraftsDescription)
    case .starred: return (MailStrings.emptyStarredTitle, MailStrings.emptyStarredDescription)
    case .trash: return (MailStrings.emptyTrashTitle, MailStrings.emptyTrashDescription)
    case .spam: return (MailStrings.emptySpamTitle, MailStrings.emptySpamDescription)
    case .archive: return (MailStrings.emptyArchiveTitle, MailStrings.emptyArchiveDescription)
    case .all: return (MailStrings.emptyAllTitle, MailStrings.emptyAllDescription)
    case .snoozed: return (MailStrings.emptySnoozedTitle, MailStrings.emptySnoozedDescription)
    case .scheduled: return (MailStrings.emptyScheduledTitle, MailStrings.emptyScheduledDescription)
    case .important: return (MailStrings.emptyImportantTitle, MailStrings.emptyImportantDescription)
    case .promotions, .none: return (MailStrings.emptyOtherTitle, MailStrings.emptyOtherDescription)
    }
}

/// "9:41", or the day: a list row's time.
func rowTime(_ date: String) -> String {
    WeldDate.parse(date).map { WeldDate.short($0) } ?? ""
}

/// "27 Nov, 14:30": the date above a message.
func messageTime(_ date: String) -> String {
    WeldDate.parse(date).map { $0.formatted(.dateTime.day().month(.abbreviated).hour().minute()) } ?? ""
}

/// The full date and time, for the details panel.
func fullTime(_ date: String) -> String {
    WeldDate.parse(date).map { $0.formatted(date: .long, time: .shortened) } ?? ""
}

/// A moment as a person reads it: "Fri 28 Nov, 09:00".
func momentText(_ date: Date) -> String {
    date.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated).hour().minute())
}

/// Hands a link to the system: the browser, the mail app, the dialler.
@MainActor
func openExternal(_ link: String) {
    guard let url = URL(string: link) else { return }
    UIApplication.shared.open(url)
}

/// An empty or "nothing found" message with an icon.
struct MailEmptyView: View {
    let title: String
    var description: String?
    var systemImage = "tray"

    var body: some View {
        ContentUnavailableView {
            Label(title, systemImage: systemImage)
        } description: {
            if let description { Text(description) }
        }
    }
}
