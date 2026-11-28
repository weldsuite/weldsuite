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

struct ChannelBadge: View {
    let channel: DeskChannel
    let value: String

    var body: some View {
        StatusBadge(channelName(channel, value: value), color: .secondary)
    }
}

struct StateBadge: View {
    let state: ConversationState

    var body: some View {
        switch state {
        case .open: StatusBadge(DeskStrings.inboxOpen, color: Tokens.Palette.primary)
        case .closed: StatusBadge(DeskStrings.inboxClosed, color: .secondary)
        }
    }
}

/// One timeline entry: an event line, or a bubble (the agent's on the right).
struct MessageRow: View {
    let message: DeskMessage
    let onOpenFailed: () -> Void

    var body: some View {
        if message.kind == .event {
            VStack(spacing: 2) {
                Text(eventLabel).font(.inter(.caption, weight: .medium)).foregroundStyle(.secondary)
                if let date = message.createdAt {
                    Text(WeldDate.short(date)).font(.inter(.caption2)).foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, Tokens.Spacing.s)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("event-\(message.id)")
        } else {
            bubble
        }
    }

    private var fromAgent: Bool { message.authorType == .agent || message.authorType == .bot }
    private var isNote: Bool { message.kind == .note }
    private var onBrand: Bool { fromAgent && !isNote }

    private var bubble: some View {
        HStack {
            if fromAgent { Spacer(minLength: 48) }
            VStack(alignment: .leading, spacing: 2) {
                Text(isNote ? "\(authorLabel) · \(DeskStrings.conversationNote)" : authorLabel)
                    .font(.inter(.caption2, weight: .semibold))
                    .foregroundStyle(onBrand ? Color.white.opacity(0.8) : Color.secondary)
                if let body = message.body, !body.isEmpty {
                    Text(body).foregroundStyle(onBrand ? Color.white : Color.primary)
                } else if message.attachments.isEmpty {
                    Text(DeskStrings.commonDash).foregroundStyle(onBrand ? Color.white : Color.primary)
                }
                ForEach(message.attachments, id: \.self) { attachment in
                    AttachmentView(attachment: attachment, onBrand: onBrand, onOpenFailed: onOpenFailed)
                }
                if let date = message.createdAt {
                    Text(WeldDate.short(date))
                        .font(.inter(.caption2))
                        .foregroundStyle(onBrand ? Color.white.opacity(0.7) : Color.secondary)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, Tokens.Spacing.m)
            .padding(.vertical, Tokens.Spacing.s)
            .background(background, in: RoundedRectangle(cornerRadius: Tokens.Radius.large))
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("message-\(message.id)")
            if !fromAgent { Spacer(minLength: 48) }
        }
    }

    private var background: Color {
        if isNote { return Tokens.Status.warning.opacity(0.15) }
        return fromAgent ? Tokens.Palette.primary : Color(.secondarySystemBackground)
    }

    private var authorLabel: String {
        switch message.authorType {
        case .visitor: DeskStrings.conversationVisitor
        case .bot: DeskStrings.conversationBot
        case .system: DeskStrings.conversationSystem
        case .agent: DeskStrings.conversationAgent
        }
    }

    private var eventLabel: String {
        switch message.eventType {
        case "closed": return DeskStrings.conversationClosedEvent
        case "reopened": return DeskStrings.conversationReopenedEvent
        case "assigned": return DeskStrings.conversationAssignedEvent
        case "unassigned": return DeskStrings.conversationUnassignedEvent
        case "rated": return DeskStrings.conversationRatedEvent(rating: message.rating.map { String($0) } ?? "?")
        default:
            if let body = message.body, !body.trimmingCharacters(in: .whitespaces).isEmpty { return body }
            return DeskStrings.conversationSystem
        }
    }
}

/// An image as a thumbnail, any other file as a row with its size; both open in the browser.
private struct AttachmentView: View {
    let attachment: DeskAttachment
    let onBrand: Bool
    let onOpenFailed: () -> Void
    @Environment(\.openURL) private var openURL

    private var name: String {
        if let name = attachment.name, !name.isEmpty { return name }
        return DeskStrings.conversationAttachment
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
                        Color(.tertiarySystemFill)
                    }
                }
                .frame(width: 160, height: 160)
                .clipShape(RoundedRectangle(cornerRadius: Tokens.Radius.medium))
            }
            .buttonStyle(.plain)
            .accessibilityLabel(name)
            .accessibilityIdentifier("attachment-image")
        } else {
            Button {
                if let url { open(url) } else { onOpenFailed() }
            } label: {
                HStack(spacing: Tokens.Spacing.s) {
                    Image(systemName: "doc.text").accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(name).font(.inter(.subheadline, weight: .medium)).lineLimit(1)
                        let size = DeskLogic.formatFileSize(attachment.size)
                        if !size.isEmpty {
                            Text(size).font(.inter(.caption2)).opacity(0.75)
                        }
                    }
                }
                .foregroundStyle(onBrand ? Color.white : Color.primary)
                .padding(.horizontal, 10)
                .padding(.vertical, Tokens.Spacing.s)
                .frame(minWidth: 160, alignment: .leading)
                .background(onBrand ? Color.white.opacity(0.18) : Color(.systemBackground), in: RoundedRectangle(cornerRadius: Tokens.Radius.medium))
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

/// What couldn't load, in WeldDesk's words ("Could not load conversations."),
/// why, and a way to try again: the core's `LoadErrorView` with the app's own title.
struct DeskLoadErrorView: View {
    let title: String
    let error: APIError?
    let retry: () async -> Void

    var body: some View {
        ContentUnavailableView {
            Label(title, systemImage: error?.isNetwork == true ? "wifi.slash" : "exclamationmark.triangle")
        } description: {
            Text(apiErrorMessage(error))
        } actions: {
            Button(CoreStrings.commonTryAgain) { Task { await retry() } }
                .accessibilityIdentifier("retry")
        }
    }
}
