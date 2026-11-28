import SwiftUI
import WeldCore
import WeldUI

/// The channel's name; one the app doesn't know shows as the server sends it.
func channelName(_ channel: DeskChannel, value: String) -> String {
    switch channel {
    case .messenger: DeskStrings.channelMessenger
    case .email: DeskStrings.channelEmail
    case .phone: DeskStrings.channelPhone
    case .whatsapp: DeskStrings.channelWhatsapp
    case .sms: DeskStrings.channelSms
    case .api: DeskStrings.channelApi
    case .portal: DeskStrings.channelPortal
    case .other: value
    }
}

/// An SLA target's name: first response, next response, resolution.
func slaMetricName(_ metric: String?) -> String {
    switch metric {
    case "first_response": DeskStrings.slaFirstResponse
    case "next_response": DeskStrings.slaNextResponse
    case "resolution": DeskStrings.slaResolution
    default: "SLA"
    }
}

func slaText(_ label: DeskLogic.SlaLabel) -> String {
    switch label {
    case let .dueIn(metric, time): DeskStrings.slaDueIn(metric: slaMetricName(metric), time: time)
    case let .overdue(metric, time): DeskStrings.slaOverdue(metric: slaMetricName(metric), time: time)
    case .breached: DeskStrings.slaBreached
    case .paused: DeskStrings.slaPaused
    case .achieved: DeskStrings.slaAchieved
    }
}

/// urgent, high, medium, low in the platform's words; another value as it is.
func priorityName(_ priority: String) -> String {
    switch priority {
    case "urgent": DeskStrings.priorityUrgent
    case "high": DeskStrings.priorityHigh
    case "medium": DeskStrings.priorityMedium
    case "low": DeskStrings.priorityLow
    default: priority
    }
}

/// The header's SLA chip (the platform's `DeskSlaBadge`): a clock and the countdown on the tone's tint.
struct SlaChip: View {
    let display: DeskLogic.SlaDisplay

    var body: some View {
        let colors = DeskColors.slaChip(display.tone)
        HStack(spacing: Tokens.Spacing.xs) {
            Image(systemName: "clock")
                .font(.system(size: 10, weight: .medium))
                .accessibilityHidden(true)
            Text(slaText(display.label))
                .font(.inter(.caption, weight: .medium))
                .lineLimit(1)
        }
        .foregroundStyle(colors.text)
        .padding(.horizontal, Tokens.Spacing.s)
        .padding(.vertical, 2)
        .background(colors.background, in: Capsule())
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("sla-badge")
    }
}

/// "Online": the visitor has the widget open on this conversation.
struct OnlineIndicator: View {
    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(DeskColors.onlineDot).frame(width: 8, height: 8)
            Text(DeskStrings.conversationOnline)
                .font(.inter(.caption, weight: .medium))
                .foregroundStyle(DeskColors.onlineText)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("visitor-online")
    }
}

/// The line between two days of the timeline, with the day in the middle.
struct DaySeparator: View {
    let day: Date

    var body: some View {
        HStack(spacing: Tokens.Spacing.m) {
            Rectangle().fill(Tokens.Palette.border.opacity(0.7)).frame(height: 1)
            Text(day.formatted(date: .long, time: .omitted))
                .font(.inter(.caption, weight: .medium))
                .foregroundStyle(Tokens.Palette.mutedForeground)
                .fixedSize()
            Rectangle().fill(Tokens.Palette.border.opacity(0.7)).frame(height: 1)
        }
        .padding(.horizontal, Tokens.Spacing.l)
        .padding(.vertical, Tokens.Spacing.m)
    }
}

/// Who wrote what, for the timeline: the roster, the customer's name, and "Someone" for the rest.
struct TimelineNames {
    let members: [DeskMember]?
    let visitor: String

    func member(_ userID: String?) -> DeskMember? {
        guard let userID else { return nil }
        return members?.first { $0.userID == userID }
    }

    func name(_ userID: String?) -> String? {
        member(userID)?.name
    }
}

/// One timeline entry: an event line ("Ann closed this conversation · 14:02"),
/// or a message bubble with its author's avatar beside it, the customer's on
/// the left and the team's on the right, as on the platform.
struct MessageRow: View {
    let message: DeskMessage
    let names: TimelineNames
    let now: Date
    let onOpenFailed: () -> Void

    var body: some View {
        if message.kind == .event {
            EventRow(message: message, names: names)
        } else {
            MessageBubble(message: message, names: names, now: now, onOpenFailed: onOpenFailed)
        }
    }
}

private struct EventRow: View {
    let message: DeskMessage
    let names: TimelineNames

    var body: some View {
        let sentences = eventSentences(message, names: names)
        if !sentences.isEmpty {
            VStack(spacing: 2) {
                ForEach(Array(sentences.enumerated()), id: \.offset) { _, sentence in
                    HStack(alignment: .firstTextBaseline, spacing: Tokens.Spacing.xs) {
                        if isInternal {
                            Image(systemName: "lock")
                                .font(.system(size: 9, weight: .medium))
                                .accessibilityHidden(true)
                        }
                        Text(time.map { "\(sentence) · \($0)" } ?? sentence)
                            .font(.inter(.caption))
                            .multilineTextAlignment(.center)
                    }
                    .foregroundStyle(color)
                }
                if message.eventType == "rated", let comment = message.details.ratingComment, !comment.trimmingCharacters(in: .whitespaces).isEmpty {
                    Text("“\(comment)”")
                        .font(.inter(.caption).italic())
                        .foregroundStyle(Tokens.Palette.foreground.opacity(0.8))
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 448)
                        .padding(.top, Tokens.Spacing.xs)
                        .accessibilityIdentifier("rating-comment")
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, Tokens.Spacing.l)
            .padding(.vertical, Tokens.Spacing.s)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("event-\(message.id)")
        }
    }

    private var isInternal: Bool { DeskLogic.internalEvents.contains(message.eventType ?? "") }

    private var color: Color {
        switch message.eventType {
        case "sla_warning": DeskColors.slaWarningLine
        case "sla_breached": DeskColors.slaBreachedLine
        default: Tokens.Palette.mutedForeground
        }
    }

    private var time: String? {
        guard let date = message.createdAt else { return nil }
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm"
        return formatter.string(from: date)
    }
}

/// An event's line (several for a change of several fields), as the
/// platform's `messages-timeline.tsx` words it. The actor is the teammate
/// who did it, by name from the roster.
func eventSentences(_ message: DeskMessage, names: TimelineNames) -> [String] {
    let details = message.details
    let actor = names.name(message.authorID) ?? DeskStrings.timelineSomeone
    func named(_ userID: String?) -> String { names.name(userID) ?? userID ?? "" }
    let number = details.linkedNumber ?? "?"
    let toParent = details.linkRole == "parent"
    let step = details.stepName.flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 }
        ?? DeskStrings.timelineStep(number: String((details.stepIndex ?? 0) + 1))
    func withComment(_ sentence: String) -> String {
        guard let comment = details.comment, !comment.trimmingCharacters(in: .whitespaces).isEmpty else { return sentence }
        return DeskStrings.timelineWithComment(sentence: sentence, comment: comment)
    }
    let single: String?
    switch message.eventType {
    case "attributes_changed":
        return details.changes.flatMap { changeSentences($0, actor: actor) }
    case "rated":
        single = DeskStrings.timelineRated(actor: names.visitor, rating: message.rating.map { String($0) } ?? "?")
    case "closed":
        single = DeskStrings.timelineClosed(actor: actor)
    case "reopened":
        single = DeskStrings.timelineReopened(actor: actor)
    case "unassigned":
        single = DeskStrings.timelineUnassigned(actor: actor)
    case "assigned":
        single = details.auto
            ? DeskStrings.timelineAutoAssigned(target: named(details.assigneeID))
            : DeskStrings.timelineAssigned(actor: actor, target: named(details.assigneeID))
    case "escalated":
        let reason: String
        switch details.condition {
        case "no_response": reason = DeskStrings.timelineReasonNoResponse
        case "sla_breach": reason = DeskStrings.timelineReasonSlaBreach
        default: reason = DeskStrings.timelineReasonUnassigned
        }
        if details.assigneeID != nil {
            single = DeskStrings.timelineEscalatedTo(target: named(details.assigneeID), reason: reason)
        } else if details.toTeamID != nil {
            single = DeskStrings.timelineEscalatedToNextTeam(reason: reason)
        } else {
            single = DeskStrings.timelineEscalatedNoTarget(reason: reason)
        }
    case "sla_warning":
        single = DeskStrings.timelineSlaWarning(metric: slaMetricName(details.metric))
    case "sla_breached":
        single = DeskStrings.timelineSlaBreached(metric: slaMetricName(details.metric))
    case "linked":
        single = toParent ? DeskStrings.timelineLinkedToParent(actor: actor, number: number) : DeskStrings.timelineLinkedChild(actor: actor, number: number)
    case "unlinked":
        single = toParent ? DeskStrings.timelineUnlinkedFromParent(actor: actor, number: number) : DeskStrings.timelineUnlinkedChild(actor: actor, number: number)
    case "merged_into":
        single = DeskStrings.timelineMergedInto(actor: actor, number: number)
    case "merged_from":
        single = DeskStrings.timelineMergedFrom(actor: actor, number: number)
    case "incident_marked":
        single = DeskStrings.timelineIncidentMarked(actor: actor)
    case "incident_unmarked":
        single = DeskStrings.timelineIncidentUnmarked(actor: actor)
    case "problem_linked":
        single = DeskStrings.timelineProblemLinked(actor: actor, number: details.problemNumber ?? "?")
    case "problem_unlinked":
        single = DeskStrings.timelineProblemUnlinked(actor: actor, number: details.problemNumber ?? "?")
    case "approval_requested":
        if let approver = details.approverID {
            single = DeskStrings.timelineApprovalRequested(approver: named(approver), step: step)
        } else {
            single = DeskStrings.timelineApprovalRequestedNobody(step: step)
        }
    case "approval_approved":
        single = withComment(DeskStrings.timelineApprovalApproved(actor: actor, step: step))
    case "approval_rejected":
        single = withComment(DeskStrings.timelineApprovalRejected(actor: actor, step: step))
    case "fulfilment_started":
        single = details.taskCount == 1 ? DeskStrings.timelineFulfilmentStartedOne : DeskStrings.timelineFulfilmentStartedOther(count: details.taskCount)
    default:
        single = nil
    }
    if let single { return [single] }
    if let body = message.body, !body.trimmingCharacters(in: .whitespaces).isEmpty { return [body] }
    return [DeskStrings.timelineGeneric(actor: actor, event: message.eventType ?? "event")]
}

/// One line per field an `attributes_changed` event changed.
private func changeSentences(_ change: AttributeChange, actor: String) -> [String] {
    let cleared = DeskLogic.isCleared(change.to)
    func shown(_ value: ChangeValue) -> String {
        switch value {
        case .empty: ""
        case let .text(text): text
        case let .items(items): items.joined(separator: ", ")
        case let .flag(on): on ? DeskStrings.timelineYes : DeskStrings.timelineNo
        }
    }
    func level(_ value: ChangeValue) -> String {
        guard case let .text(text) = value else { return shown(value) }
        switch text {
        case "low": return DeskStrings.timelineLevelLow
        case "medium": return DeskStrings.timelineLevelMedium
        case "high": return DeskStrings.timelineLevelHigh
        default: return text
        }
    }
    func priority(_ value: ChangeValue) -> String {
        guard case let .text(text) = value else { return shown(value) }
        return priorityName(text)
    }
    switch change.field {
    case "ticketType":
        return [cleared ? DeskStrings.timelineTypeCleared(actor: actor) : DeskStrings.timelineTypeSet(actor: actor, value: shown(change.to))]
    case "team":
        return [cleared ? DeskStrings.timelineTeamCleared(actor: actor) : DeskStrings.timelineTeamSet(actor: actor, value: shown(change.to))]
    case "priority":
        return [cleared ? DeskStrings.timelinePriorityCleared(actor: actor) : DeskStrings.timelinePrioritySet(actor: actor, value: priority(change.to))]
    case "tags":
        let diff = DeskLogic.tagDiff(change)
        var lines: [String] = []
        if !diff.added.isEmpty { lines.append(DeskStrings.timelineTagsAdded(actor: actor, value: diff.added.joined(separator: ", "))) }
        if !diff.removed.isEmpty { lines.append(DeskStrings.timelineTagsRemoved(actor: actor, value: diff.removed.joined(separator: ", "))) }
        return lines
    case "impact":
        return [cleared ? DeskStrings.timelineImpactCleared(actor: actor) : DeskStrings.timelineImpactSet(actor: actor, value: level(change.to))]
    case "urgency":
        return [cleared ? DeskStrings.timelineUrgencyCleared(actor: actor) : DeskStrings.timelineUrgencySet(actor: actor, value: level(change.to))]
    case "customField":
        let field = change.label ?? change.key ?? ""
        return [cleared ? DeskStrings.timelineFieldCleared(actor: actor, field: field) : DeskStrings.timelineFieldSet(actor: actor, field: field, value: shown(change.to))]
    default:
        return []
    }
}

/// How long ago, short: "Now", "4min", "2h", "3d", then the day.
func agoText(_ date: Date, now: Date) -> String {
    switch DeskLogic.ago(date, now: now) {
    case .now: DeskStrings.conversationTimeNow
    case let .minutes(n): DeskStrings.conversationTimeMinutes(n: String(n))
    case let .hours(n): DeskStrings.conversationTimeHours(n: String(n))
    case let .days(n): DeskStrings.conversationTimeDays(n: String(n))
    case let .on(day): day.formatted(.dateTime.day().month(.abbreviated))
    }
}

/// A message: the customer's grey bubble on the left, the team's indigo one on the right, a note in amber.
private struct MessageBubble: View {
    let message: DeskMessage
    let names: TimelineNames
    let now: Date
    let onOpenFailed: () -> Void

    private var isVisitor: Bool { message.authorType == .visitor }
    private var isBot: Bool { message.authorType == .bot }
    private var isNote: Bool { message.kind == .note }
    private var member: DeskMember? { isVisitor ? nil : names.member(message.authorID) }

    private var label: String {
        if isVisitor { return names.visitor }
        if isBot { return DeskStrings.conversationAi }
        return member?.name ?? DeskStrings.conversationAgent
    }

    var body: some View {
        // The spacer keeps a bubble to about 70% of the width, as on the platform.
        HStack(alignment: .bottom, spacing: Tokens.Spacing.s) {
            if isVisitor {
                InitialAvatar(name: label, size: 24)
            } else {
                Spacer(minLength: 56)
            }
            bubble
            if isVisitor {
                Spacer(minLength: 56)
            } else {
                InitialAvatar(name: label, url: member?.picture.flatMap(URL.init(string:)), size: 24, bot: isBot)
            }
        }
        .padding(.horizontal, Tokens.Spacing.l)
        .padding(.top, Tokens.Spacing.m)
    }

    private var bubble: some View {
        VStack(alignment: isVisitor ? .leading : .trailing, spacing: 0) {
            if let body = message.body, !body.isEmpty {
                Text(body)
                    .font(.inter(.subheadline))
                    .lineSpacing(4)
                    .foregroundStyle(textColor)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !message.attachments.isEmpty {
                VStack(alignment: .leading, spacing: Tokens.Spacing.xs) {
                    ForEach(message.attachments, id: \.self) { attachment in
                        AttachmentView(attachment: attachment, textColor: textColor, onOpenFailed: onOpenFailed)
                    }
                }
                .padding(.top, message.body?.isEmpty == false ? Tokens.Spacing.s : 0)
            }
            HStack(spacing: Tokens.Spacing.xs) {
                if isNote {
                    Image(systemName: "lock")
                        .font(.system(size: 9, weight: .medium))
                        .accessibilityHidden(true)
                    Text(DeskStrings.conversationInternalNote)
                    Text("·")
                }
                if let date = message.createdAt {
                    Text(agoText(date, now: now))
                }
            }
            .font(.inter(.caption2))
            .foregroundStyle(metaColor)
            .padding(.top, Tokens.Spacing.xs)
        }
        .padding(.horizontal, 14)
        .padding(.top, 10)
        .padding(.bottom, Tokens.Spacing.s)
        .background(background, in: RoundedRectangle(cornerRadius: Tokens.Radius.xlarge))
        .overlay {
            if isNote {
                RoundedRectangle(cornerRadius: Tokens.Radius.xlarge).stroke(DeskColors.noteBorder, lineWidth: 1)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("message-\(message.id)")
    }

    private var background: Color {
        if isNote { return DeskColors.noteBubble }
        return isVisitor ? Tokens.Palette.muted : DeskColors.agentBubble
    }

    private var textColor: Color {
        if isNote { return DeskColors.noteText }
        return isVisitor ? Tokens.Palette.foreground : DeskColors.agentText
    }

    private var metaColor: Color {
        if isNote { return DeskColors.noteMeta }
        return isVisitor ? Tokens.Palette.mutedForeground : DeskColors.agentMeta
    }
}

/// The visitor is typing: three dots in a grey bubble, and who.
struct TypingBubble: View {
    let name: String

    var body: some View {
        HStack(alignment: .top, spacing: Tokens.Spacing.s) {
            Color.clear.frame(width: 24, height: 1)
            VStack(alignment: .leading, spacing: Tokens.Spacing.xs) {
                HStack(spacing: Tokens.Spacing.xs) {
                    ForEach(0..<3, id: \.self) { _ in
                        Circle().fill(Tokens.Palette.mutedForeground.opacity(0.6)).frame(width: 6, height: 6)
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, Tokens.Spacing.m)
                .background(Tokens.Palette.muted, in: RoundedRectangle(cornerRadius: Tokens.Radius.xlarge))
                Text(DeskStrings.conversationTyping(name: name))
                    .font(.inter(.caption2))
                    .foregroundStyle(Tokens.Palette.mutedForeground)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Tokens.Spacing.l)
        .padding(.top, Tokens.Spacing.xs)
        .padding(.bottom, Tokens.Spacing.s)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("typing")
    }
}

/// An image as a thumbnail, any other file as a link with its size; both open in the browser.
private struct AttachmentView: View {
    let attachment: DeskAttachment
    let textColor: Color
    let onOpenFailed: () -> Void
    @Environment(\.openURL) private var openURL

    private var name: String {
        if let name = attachment.name, !name.isEmpty { return name }
        return DeskStrings.conversationAttachment
    }

    /// At most 192 high (`max-h-48`), in the picture's own proportions when known.
    private var imageSize: CGSize {
        var ratio = 1.0
        if let width = attachment.width, let height = attachment.height, width > 0, height > 0 { ratio = width / height }
        let height = min(192, 220 / ratio)
        return CGSize(width: height * ratio, height: height)
    }

    var body: some View {
        let url = DeskLogic.openableURL(attachment.url)
        if DeskLogic.isImage(attachment.contentType), let url {
            Button {
                open(url)
            } label: {
                AsyncImage(url: url) { phase in
                    if let image = phase.image {
                        image.resizable().scaledToFill()
                    } else {
                        Tokens.Palette.muted
                    }
                }
                .frame(width: imageSize.width, height: imageSize.height)
                .clipShape(RoundedRectangle(cornerRadius: Tokens.Radius.large))
            }
            .buttonStyle(.plain)
            .accessibilityLabel(name)
            .accessibilityIdentifier("attachment-image")
        } else {
            Button {
                if let url { open(url) } else { onOpenFailed() }
            } label: {
                HStack(spacing: Tokens.Spacing.xs) {
                    Image(systemName: "paperclip")
                        .font(.system(size: 10))
                        .accessibilityHidden(true)
                    Text(name)
                        .underline()
                        .lineLimit(1)
                    let size = DeskLogic.formatFileSize(attachment.size)
                    if !size.isEmpty {
                        Text("· \(size)").opacity(0.7)
                    }
                }
                .font(.inter(.caption))
                .foregroundStyle(textColor)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(name)
            .accessibilityIdentifier("attachment-file")
        }
    }

    private func open(_ url: URL) {
        openURL(url) { accepted in
            if !accepted { onOpenFailed() }
        }
    }
}

/// What couldn't load, in the platform's words ("Failed to load
/// conversations"), why, and a way to try again: the warning on a red-tinted
/// square, as the platform's list shows a failed load.
struct DeskLoadErrorView: View {
    let title: String
    let error: APIError?
    let retry: () async -> Void

    var body: some View {
        DeskEmptyStateView(
            systemImage: error?.isNetwork == true ? "wifi.slash" : "exclamationmark.triangle",
            title: title,
            description: apiErrorMessage(error),
            iconTint: Tokens.Status.danger,
            iconBackground: Tokens.Status.danger.opacity(0.12)
        ) {
            Button(CoreStrings.commonTryAgain) { Task { await retry() } }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("retry")
        }
    }
}
