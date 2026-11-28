import SwiftUI
import WeldCore
import WeldUI

// The platform's mail list (`components/shared/conversation-list`): its row,
// its date-group headers, its badges and its empty state, shared by the
// inbox, search and the message's conversation.

/// The colours the platform's mail screens give their markers (Tailwind).
enum MailColors {
    /// `bg-blue-600`: the unread dot.
    static let unread = Color(mailRGB: 0x2563EB)
    /// `text-yellow-500`: a starred message.
    static let star = Color(mailRGB: 0xEAB308)
    /// `text-blue-500`: a pinned message.
    static let pin = Color(mailRGB: 0x3B82F6)
    /// `text-orange-500`: an important message's flag.
    static let important = Color(mailRGB: 0xF97316)
    /// `text-purple-600`: snoozing, as the platform's "Snoozed until" line.
    static let snooze = Color(mailRGB: 0x9333EA)
    /// `gray-500`: the neutral swipe actions (read, archive).
    static let neutral = Color(mailRGB: 0x6B7280)
}

/// A label's colour: its own, else the platform's colour for its name.
func labelTint(_ name: String, own: String?) -> Color {
    MailLogic.parseHex(own).map { Color(mailRGB: $0) } ?? PlatformColors.label(name)
}

/// A person on a row: their picture, else the first letter of the name, white
/// on the platform's avatar colour for that name (as the platform's mail list).
struct MailAvatar: View {
    let name: String
    var url: String?
    var size: CGFloat = 28

    var body: some View {
        Group {
            if let url, !url.isEmpty, let link = URL(string: url) {
                AsyncImage(url: link) { phase in
                    if let image = phase.image {
                        image.resizable().scaledToFill()
                    } else {
                        initial
                    }
                }
            } else {
                initial
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .accessibilityHidden(true)
    }

    private var initial: some View {
        Text(name.trimmingCharacters(in: .whitespaces).first.map { String($0).uppercased() } ?? "?")
            .font(.inter(size: size * 0.43, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(PlatformColors.avatar(name))
    }
}

/// A custom label on a row: its name in its colour on a light wash of it, `rounded`.
struct LabelChip: View {
    let name: String
    let color: Color

    var body: some View {
        Text(name)
            .font(.inter(.caption, weight: .medium))
            .lineLimit(1)
            .foregroundStyle(color)
            .padding(.horizontal, Tokens.Spacing.s)
            .padding(.vertical, 2)
            .background(color.opacity(0.08), in: RoundedRectangle(cornerRadius: 4))
    }
}

/// The platform's small monospaced count: a group header's size, a conversation's length.
struct CountBadge: View {
    let count: Int
    var height: CGFloat = 16

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: height > 16 ? 6 : 5)
        Text("\(count)")
            .font(.inter(size: 10, weight: .medium).monospacedDigit())
            .foregroundStyle(Tokens.Palette.mutedForeground)
            .padding(.horizontal, 3)
            .frame(minWidth: height, minHeight: height, maxHeight: height)
            .background(Tokens.Palette.muted, in: shape)
            .overlay(shape.stroke(Tokens.Palette.border))
    }
}

/// A date group's header, as the platform's list: a muted band with the
/// group's name and its size, a hairline under it.
struct GroupHeader: View {
    let title: String
    let count: Int

    var body: some View {
        HStack(spacing: Tokens.Spacing.s) {
            Text(title).font(.inter(.caption, weight: .medium)).foregroundStyle(Tokens.Palette.mutedForeground)
            CountBadge(count: count)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Tokens.Spacing.l)
        .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
        .background(Tokens.Palette.muted.opacity(0.5))
        .overlay(alignment: .bottom) { Hairline() }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

/// A one-pixel line in the border colour.
struct Hairline: View {
    @Environment(\.displayScale) private var scale

    var body: some View {
        Rectangle().fill(Tokens.Palette.border).frame(height: 1 / max(scale, 1))
    }
}

/// A list filter, as the platform's `FilterButton`: outlined and muted, tinted with the primary while on.
struct FilterChip: View {
    let title: String
    let selected: Bool
    let action: () -> Void

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Tokens.Radius.medium)
        Button(action: action) {
            Text(title)
                .font(.inter(.subheadline))
                .lineLimit(1)
                .foregroundStyle(selected ? Tokens.Palette.primary : Tokens.Palette.mutedForeground)
                .padding(.horizontal, Tokens.Spacing.m)
                .frame(height: 32)
                .background(selected ? Tokens.Palette.primary.opacity(0.1) : Color.clear, in: shape)
                .overlay(shape.stroke(selected ? Tokens.Palette.primary.opacity(0.4) : Tokens.Palette.border))
                .contentShape(shape)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// Nothing to list: the icon in a muted square, a semibold title, a muted line.
struct MailEmptyView: View {
    let title: String
    var description: String?
    var systemImage = "tray"

    var body: some View {
        VStack(spacing: 0) {
            Image(systemName: systemImage)
                .font(.system(size: 18))
                .foregroundStyle(Tokens.Palette.mutedForeground)
                .frame(width: 44, height: 44)
                .background(Tokens.Palette.muted, in: RoundedRectangle(cornerRadius: Tokens.Radius.large))
            Text(title)
                .font(.inter(.subheadline, weight: .semibold))
                .multilineTextAlignment(.center)
                .padding(.top, Tokens.Spacing.m)
            if let description {
                Text(description)
                    .font(.inter(.subheadline))
                    .foregroundStyle(Tokens.Palette.mutedForeground)
                    .multilineTextAlignment(.center)
                    .padding(.top, Tokens.Spacing.xs)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, Tokens.Spacing.xl)
        .padding(.vertical, 56)
    }
}

/// One email in a list, as the platform's conversation row: the avatar with
/// the unread dot beside it, the sender (or "To:" and the recipients in Sent,
/// Drafts and Scheduled) with the conversation's size, the attachment, pin,
/// important and star markers and the time; the subject, the preview, the
/// labels. `query` is emphasised where it matches (search).
struct MessageRow: View {
    let message: MailMessage
    let pinned: Bool
    var outgoing = false
    let labelColors: [String: String?]
    var query = ""

    var body: some View {
        let unread = !message.isRead
        let muted = Tokens.Palette.mutedForeground
        let name = outgoing
            ? (MailLogic.recipientNames(message.to) ?? MailStrings.inboxNoRecipient)
            : (message.senderName ?? MailStrings.commonUnknown)
        let avatarURL = outgoing ? message.to.first?.avatarURL : message.from?.avatarURL
        let subject = message.subject.flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 } ?? MailStrings.commonNoSubject
        HStack(alignment: .top, spacing: 10) {
            MailAvatar(name: name, url: avatarURL)
                .overlay(alignment: .leading) {
                    if unread {
                        Circle()
                            .fill(MailColors.unread)
                            .frame(width: 6, height: 6)
                            .offset(x: -10)
                            .accessibilityLabel(MailStrings.inboxUnreadDot)
                    }
                }
                .padding(.top, 3)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    HStack(spacing: 6) {
                        senderText(name, unread: unread)
                            .lineLimit(1)
                        if message.threadCount > 1 {
                            CountBadge(count: message.threadCount, height: 18)
                        }
                    }
                    .layoutPriority(1)
                    Spacer(minLength: Tokens.Spacing.s)
                    if message.hasAttachments { marker("paperclip", muted, MailStrings.inboxHasAttachments) }
                    if pinned { marker("pin.fill", MailColors.pin, MailStrings.inboxIsPinned) }
                    if MailLogic.isImportant(message) { marker("flag.fill", MailColors.important, MailStrings.inboxIsImportant) }
                    if message.isStarred { marker("star.fill", MailColors.star, MailStrings.inboxIsStarred) }
                    Text(dateText(message.listDate))
                        .font(.inter(.caption))
                        .foregroundStyle(muted)
                        .fixedSize()
                }
                Text(highlighted(subject, query))
                    .font(.inter(.subheadline, weight: unread ? .medium : .regular))
                    .foregroundStyle(unread ? Tokens.Palette.foreground : muted)
                    .lineLimit(1)
                Text(highlighted(message.preview ?? "", query))
                    .font(.inter(.footnote))
                    .foregroundStyle(muted)
                    .lineLimit(1)
                    .padding(.top, 1)
                let shown = MailLogic.displayLabels(message.labels)
                if !shown.isEmpty {
                    FlowLayout(spacing: Tokens.Spacing.xs) {
                        ForEach(Array(shown.prefix(3)), id: \.self) { label in
                            LabelChip(name: label, color: labelTint(label, own: labelColors[label] ?? nil))
                        }
                        if shown.count > 3 {
                            Text("+\(shown.count - 3)").font(.inter(size: 10)).foregroundStyle(muted)
                        }
                    }
                    .padding(.top, Tokens.Spacing.s)
                }
            }
        }
        .padding(.horizontal, Tokens.Spacing.l)
        .padding(.vertical, Tokens.Spacing.m)
        .contentShape(Rectangle())
    }

    private func senderText(_ name: String, unread: Bool) -> Text {
        let nameText = Text(highlighted(name, query))
            .font(.inter(.subheadline, weight: unread ? .semibold : .medium))
            .foregroundStyle(unread ? Tokens.Palette.foreground : Tokens.Palette.mutedForeground)
        guard outgoing else { return nameText }
        return Text(MailStrings.inboxToPrefix + " ")
            .font(.inter(.subheadline))
            .foregroundStyle(Tokens.Palette.mutedForeground)
            + nameText
    }

    private func marker(_ symbol: String, _ tint: Color, _ label: String) -> some View {
        Image(systemName: symbol)
            .font(.system(size: 11))
            .foregroundStyle(tint)
            .accessibilityLabel(label)
    }
}

/// The text with every match of the query (any case) emphasised.
func highlighted(_ text: String, _ query: String) -> AttributedString {
    var result = AttributedString(text)
    let needle = query.trimmingCharacters(in: .whitespaces)
    guard !needle.isEmpty else { return result }
    var start = result.startIndex
    while start < result.endIndex, let range = result[start...].range(of: needle, options: .caseInsensitive) {
        result[range].inlinePresentationIntent = .stronglyEmphasized
        start = range.upperBound
    }
    return result
}

/// A group's name: Yesterday, a weekday, Last week, 2 weeks ago, a month (the list leaves Today's header out).
func groupTitle(_ group: DateGroup) -> String {
    switch group.kind {
    case .pinned: return MailStrings.inboxPinned
    case .today, .undated: return CoreStrings.commonToday
    case .yesterday: return CoreStrings.commonYesterday
    case .weekday: return capitalizedFirst(group.day?.formatted(.dateTime.weekday(.wide)))
    case .lastWeek: return MailStrings.inboxLastWeek
    case .weeksAgo: return MailStrings.inboxWeeksAgo(group.weeks)
    case .month: return capitalizedFirst(group.day?.formatted(.dateTime.month(.wide)))
    case .monthYear: return capitalizedFirst(group.day?.formatted(.dateTime.month(.wide).year()))
    case .upcoming: return capitalizedFirst(group.day?.formatted(.dateTime.month(.wide).day()))
    }
}

private func capitalizedFirst(_ text: String?) -> String {
    guard let text, let first = text.first else { return "" }
    return first.uppercased() + text.dropFirst()
}

/// A date as the platform's mail screens show it: the time today, else the
/// day ("27 Nov", "Nov 27" in English), with the year once it isn't this
/// year's; `withTime` adds the time to a day (the message's own date).
func dateText(_ date: String, withTime: Bool = false) -> String {
    guard let at = WeldDate.parse(date) else { return "" }
    let time = at.formatted(date: .omitted, time: .shortened)
    let day: String
    switch MailLogic.dateStyle(at) {
    case .time: return time
    case .day: day = at.formatted(.dateTime.month(.abbreviated).day())
    case .dayYear: day = at.formatted(.dateTime.month(.abbreviated).day().year())
    }
    return withTime ? "\(day), \(time)" : day
}
