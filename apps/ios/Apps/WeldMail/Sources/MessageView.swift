import QuickLook
import SwiftUI
import UIKit
import WeldCore
import WeldUI

/// One message, with its conversation under it: cache first (so it opens
/// offline), then the server. Opening it marks it read.
struct MessageView: View {
    let env: AppEnvironment
    let store: MailStore
    let messageID: String

    @Environment(MailNavigator.self) private var nav
    @Environment(MailNotifier.self) private var notifier
    @Environment(\.dismiss) private var dismiss
    @State private var message: MailMessage?
    @State private var thread: [MailMessage] = []
    @State private var bodyLoading = true
    @State private var outcome: Outcome?
    @State private var reload = 0
    @State private var snoozing = false
    @State private var choosingLabels = false
    @State private var reported = false

    /// How opening a message went when there is nothing to show.
    private enum Outcome {
        case gone, failed
    }

    var body: some View {
        Group {
            if let current = message {
                content(current)
            } else if outcome == .gone {
                VStack(spacing: Tokens.Spacing.l) {
                    MailEmptyView(title: MailStrings.messageNotFound, systemImage: "envelope.badge")
                    Button(CoreStrings.commonClose) { dismiss() }.accessibilityIdentifier("message-close")
                }
            } else if outcome == .failed {
                VStack(spacing: Tokens.Spacing.l) {
                    MailEmptyView(title: MailStrings.messageLoadFailed, systemImage: "exclamationmark.triangle")
                    Button(CoreStrings.commonTryAgain) { reload += 1 }
                        .buttonStyle(.borderedProminent)
                        .accessibilityIdentifier("retry")
                    Button(CoreStrings.commonClose) { dismiss() }.accessibilityIdentifier("message-close")
                }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .task(id: reload) { await load() }
        .onAppear { OpenEmail.id = messageID }
        .onDisappear { if OpenEmail.id == messageID { OpenEmail.id = nil } }
    }

    // MARK: Loading

    private func load() async {
        outcome = nil
        let preview = nav.previews[messageID]
        if message == nil, let preview { message = stub(preview) }
        let cached = await store.cachedMessage(messageID)
        if let cached {
            message = cached
            if let list = await store.cachedThread(messageID) { thread = list.filter { $0.id != messageID } }
            bodyLoading = false
        }
        var fetched: MailMessage?
        var gone = false
        for attempt in 0..<3 {
            do {
                fetched = try await store.repository.message(messageID)
                break
            } catch {
                if APIError.from(error).status == 404 {
                    gone = true
                    break
                }
                if attempt < 2 { try? await Task.sleep(for: .milliseconds(300 * (attempt + 1))) }
            }
        }
        if let fetched {
            message = fetched
            bodyLoading = false
            await store.remember(fetched)
            if !fetched.isRead { store.setRead(fetched.id, true) }
        } else if cached == nil && preview == nil {
            outcome = gone ? .gone : .failed
            if gone { await store.refresh() }
        }
        // The conversation is a bonus: it never holds up the message.
        if let list = try? await store.repository.thread(messageID) {
            await store.rememberThread(messageID, list)
            thread = list.filter { $0.id != messageID }
        }
        bodyLoading = false
    }

    /// A message to paint from a notification before the real one loads.
    private func stub(_ preview: MessagePreview) -> MailMessage? {
        if preview.fromName == nil && preview.fromEmail == nil && preview.subject == nil && preview.preview == nil { return nil }
        let now = WeldDate.timestampString(Date())
        return MailMessage(
            id: messageID,
            accountID: "",
            from: MailAddress(preview.fromEmail ?? "", name: preview.fromName),
            subject: preview.subject,
            preview: preview.preview,
            sentDate: now,
            createdAt: now,
            isRead: false
        )
    }

    // MARK: Actions

    private func leave(goNext: Bool, from current: MailMessage) {
        if goNext, let next = MailLogic.nextID(store.visibleIDs, after: current.id) {
            nav.replaceTop(with: .message(next))
        } else {
            dismiss()
        }
    }

    private func reply(_ original: MailMessage, _ mode: ComposeMode) {
        nav.compose(MailLogic.prefill(original, mode: mode, selfAddresses: store.ownAddresses, unknownSender: MailStrings.commonUnknown))
    }

    private func openContact(_ key: String) {
        nav.open(.contact(key))
    }

    // MARK: Content

    private func content(_ current: MailMessage) -> some View {
        let pinned = store.pinned.contains(current.id)
        return ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                MessageHeader(message: current, conversationSize: thread.count + 1, onContact: openContact)
                UnsubscribeChip(store: store, message: current)
                Group {
                    if let html = current.htmlBody, !html.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        EmailWebView(html: html, fontSize: 14, lineHeight: 1.625, initialHeight: 300)
                    } else if bodyLoading && (current.textBody ?? current.preview ?? "").isEmpty {
                        ProgressView().frame(maxWidth: .infinity).padding(32)
                    } else {
                        let text = current.textBody ?? current.preview ?? ""
                        Text(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? MailStrings.commonNoContent : text)
                            .font(.inter(.body))
                            .textSelection(.enabled)
                            .padding(.horizontal, Tokens.Spacing.l)
                    }
                }
                .padding(.vertical, Tokens.Spacing.s)
                if !current.attachments.isEmpty {
                    AttachmentsBlock(env: env, attachments: current.attachments)
                }
                // Earlier messages of the conversation, newest first, collapsed.
                ForEach(Array(thread.reversed())) { older in
                    ThreadMessageView(message: older, onReply: { mode in reply(older, mode) }, onContact: openContact)
                }
                Spacer(minLength: Tokens.Spacing.xl)
            }
        }
        .accessibilityIdentifier("message-screen")
        .safeAreaInset(edge: .bottom) {
            HStack(spacing: Tokens.Spacing.s) {
                Button { reply(current, .reply) } label: {
                    Label(MailStrings.messageReply, systemImage: "arrowshape.turn.up.left").frame(maxWidth: .infinity)
                }
                .accessibilityIdentifier("reply")
                if current.to.count + current.cc.count > 1 {
                    Button { reply(current, .replyAll) } label: {
                        Label(MailStrings.messageReplyAll, systemImage: "arrowshape.turn.up.left.2").lineLimit(1).frame(maxWidth: .infinity)
                    }
                    .accessibilityIdentifier("reply-all")
                }
                Button { reply(current, .forward) } label: {
                    Label(MailStrings.messageForward, systemImage: "arrowshape.turn.up.right").frame(maxWidth: .infinity)
                }
                .accessibilityIdentifier("forward")
            }
            .buttonStyle(.bordered)
            .padding(.horizontal, Tokens.Spacing.l)
            .padding(.vertical, Tokens.Spacing.s)
            .background(.bar)
        }
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button {
                    store.archive(current.id)
                    leave(goNext: true, from: current)
                } label: {
                    Image(systemName: "checkmark")
                }
                .accessibilityLabel(MailStrings.messageArchiveAndNext)
                .accessibilityIdentifier("archive-next")

                Button {
                    let starred = !current.isStarred
                    message?.isStarred = starred
                    store.setStarred(current.id, starred)
                } label: {
                    Image(systemName: current.isStarred ? "star.fill" : "star")
                        .foregroundStyle(current.isStarred ? MailColors.star : Color.accentColor)
                }
                .accessibilityLabel(current.isStarred ? MailStrings.messageUnstar : MailStrings.messageStar)
                .accessibilityIdentifier("message-star")

                Button {
                    store.togglePin(current.id)
                } label: {
                    Image(systemName: pinned ? "pin.fill" : "pin")
                        .foregroundStyle(pinned ? MailColors.pin : Color.accentColor)
                }
                .accessibilityLabel(pinned ? MailStrings.messageUnpin : MailStrings.messagePin)
                .accessibilityIdentifier("message-pin")

                Button {
                    store.archive(current.id)
                    dismiss()
                } label: {
                    Image(systemName: "archivebox")
                }
                .accessibilityLabel(MailStrings.messageArchive)
                .accessibilityIdentifier("message-archive")

                Menu {
                    Button { snoozing = true } label: { Label(MailStrings.messageSnooze, systemImage: "clock") }
                    Button { choosingLabels = true } label: { Label(MailStrings.messageLabels, systemImage: "tag") }
                    Button {
                        store.setRead(current.id, false)
                        dismiss()
                    } label: { Label(MailStrings.messageMarkUnread, systemImage: "envelope.badge") }
                    Button { leave(goNext: true, from: current) } label: { Label(MailStrings.messageNext, systemImage: "chevron.down") }
                    Button(role: .destructive) {
                        store.delete(current.id)
                        dismiss()
                    } label: { Label(MailStrings.messageDelete, systemImage: "trash") }
                        .accessibilityIdentifier("message-delete")
                    Button(role: .destructive) {
                        store.markSpam(current.id)
                        dismiss()
                    } label: { Label(MailStrings.messageMarkSpam, systemImage: "exclamationmark.octagon") }
                    Button {
                        store.markSpam(current.id)
                        reported = true
                    } label: { Label(MailStrings.messageReportPhishing, systemImage: "shield.lefthalf.filled.slash") }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityLabel(MailStrings.messageMore)
                .accessibilityIdentifier("message-more")
            }
        }
        .sheet(isPresented: $snoozing) {
            TimeChoiceSheet(title: MailStrings.snoozeTitle, choices: TimeChoice.snooze(), tint: MailColors.snooze) { at in
                snoozing = false
                store.snooze(current, until: WeldDate.timestampString(at))
                dismiss()
            }
        }
        .sheet(isPresented: $choosingLabels) {
            LabelPickerSheet(labels: store.labels.custom, current: current.labels) { add, remove in
                do {
                    let labels = try await store.repository.changeLabels(current.id, add: add, remove: remove, current: current.labels)
                    message?.labels = labels
                    store.labelsChanged(current.id, labels)
                    choosingLabels = false
                } catch {
                    notifier.show(error)
                }
            }
        }
        .alert(MailStrings.messageReportedTitle, isPresented: $reported) {
            Button(CoreStrings.commonDone) { dismiss() }
        } message: {
            Text(MailStrings.messageReportedMessage)
        }
    }
}

private struct MessageHeader: View {
    let message: MailMessage
    let conversationSize: Int
    let onContact: (String) -> Void

    @State private var details = false

    var body: some View {
        let sender = message.senderName ?? MailStrings.commonNoSender
        let senderEmail = message.from?.email ?? ""
        let recipients = message.to.map(\.label).joined(separator: ", ")
        VStack(alignment: .leading, spacing: Tokens.Spacing.m) {
            HStack(alignment: .top) {
                Text(message.subject.flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 } ?? MailStrings.commonNoSubject)
                    .font(.inter(.title2, weight: .semibold))
                    .accessibilityIdentifier("message-subject")
                Spacer(minLength: 0)
                if conversationSize > 1 {
                    Text("\(conversationSize)")
                        .font(.inter(.caption))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 6))
                        .padding(.top, 6)
                        .accessibilityLabel(MailStrings.messageConversation(conversationSize))
                }
            }
            HStack(spacing: Tokens.Spacing.m) {
                Button {
                    onContact(senderEmail.isEmpty ? sender : senderEmail)
                } label: {
                    SenderAvatar(name: sender)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(MailStrings.messageOpenContact)
                .accessibilityIdentifier("open-contact")
                VStack(alignment: .leading, spacing: 2) {
                    Button {
                        onContact(senderEmail.isEmpty ? sender : senderEmail)
                    } label: {
                        Text(sender).fontWeight(.semibold).lineLimit(1).foregroundStyle(.primary)
                    }
                    .buttonStyle(.plain)
                    Button {
                        details.toggle()
                    } label: {
                        HStack(spacing: 2) {
                            Text(recipients.isEmpty ? MailStrings.messageToMe : MailStrings.messageTo(recipients: recipients))
                                .font(.inter(.footnote))
                                .lineLimit(1)
                            Image(systemName: details ? "chevron.up" : "chevron.down").font(.inter(.caption2))
                        }
                        .foregroundStyle(Color.accentColor)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(details ? MailStrings.messageHideDetails : MailStrings.messageShowDetails)
                    .accessibilityIdentifier("toggle-details")
                }
                Spacer(minLength: 0)
                Text(messageTime(message.listDate)).font(.inter(.caption)).foregroundStyle(.secondary)
            }
            if details {
                VStack(alignment: .leading, spacing: Tokens.Spacing.s) {
                    detail(MailStrings.messageFrom, "\(sender)\n\(senderEmail)")
                    detail(MailStrings.messageToLabel, message.to.map { $0.email.isEmpty ? $0.label : $0.email }.joined(separator: ", "))
                    if !message.cc.isEmpty {
                        detail(MailStrings.messageCc, message.cc.map { $0.email.isEmpty ? $0.label : $0.email }.joined(separator: ", "))
                    }
                    detail(MailStrings.messageDate, fullTime(message.listDate))
                    Label(MailStrings.messageEncryption, systemImage: "lock").font(.inter(.footnote))
                }
                .padding(Tokens.Spacing.m)
                .frame(maxWidth: .infinity, alignment: .leading)
                .overlay(RoundedRectangle(cornerRadius: Tokens.Radius.small).stroke(Color(.separator)))
            }
        }
        .padding(.horizontal, Tokens.Spacing.l)
        .padding(.top, Tokens.Spacing.m)
    }

    private func detail(_ label: String, _ value: String) -> some View {
        HStack(alignment: .top) {
            Text(label).font(.inter(.footnote)).foregroundStyle(.secondary).frame(width: 56, alignment: .leading)
            Text(value).font(.inter(.footnote)).textSelection(.enabled)
        }
    }
}

/// Unsubscribe under the sender of a mailing list's email; nothing for ordinary mail.
private struct UnsubscribeChip: View {
    let store: MailStore
    let message: MailMessage

    @Environment(MailNotifier.self) private var notifier
    @State private var subscription: MailSubscription?
    @State private var confirming = false
    @State private var busy = false

    var body: some View {
        Group {
            if let current = subscription, !current.active || MailLogic.canUnsubscribe(current) {
                Group {
                    if current.active {
                        Button(MailStrings.unsubscribeButton) { confirming = true }
                            .buttonStyle(.bordered)
                            .disabled(busy)
                            .accessibilityLabel(MailStrings.unsubscribeAccessibility(sender: current.senderLabel))
                            .accessibilityIdentifier("unsubscribe")
                    } else {
                        Text(MailStrings.unsubscribeUnsubscribed).font(.inter(.footnote)).foregroundStyle(.secondary)
                    }
                }
                .padding(.horizontal, Tokens.Spacing.l)
                .padding(.vertical, Tokens.Spacing.xs)
                .alert(MailStrings.unsubscribeConfirmTitle(sender: current.senderLabel), isPresented: $confirming) {
                    Button(Unsubscribing.confirmLabel(current)) { unsubscribe(current) }
                        .accessibilityIdentifier("confirm-unsubscribe")
                    Button(CoreStrings.commonCancel, role: .cancel) {}
                } message: {
                    Text(Unsubscribing.message(current))
                }
            }
        }
        .task(id: message.id) {
            subscription = nil
            guard store.sendableAccounts.contains(where: { $0.id == message.accountID }) else { return }
            let list = (try? await store.subscriptionsCached(accountID: message.accountID)) ?? []
            subscription = MailLogic.subscription(in: list, for: message.from?.email)
        }
    }

    private func unsubscribe(_ current: MailSubscription) {
        busy = true
        Task {
            do {
                let result = try await store.repository.unsubscribe(current.id)
                store.forgetSubscriptions(accountID: current.accountID)
                var done = current
                done.active = false
                done.unsubscribedAt = WeldDate.timestampString(Date())
                subscription = done
                Unsubscribing.announce(result, sender: current.senderLabel, notifier: notifier)
            } catch {
                notifier.show(MailStrings.unsubscribeFailed(sender: current.senderLabel))
            }
            busy = false
        }
    }
}

/// The message's files: tapped, one downloads and opens in Quick Look.
private struct AttachmentsBlock: View {
    let env: AppEnvironment
    let attachments: [MailAttachment]

    @Environment(MailNotifier.self) private var notifier
    @State private var opening: String?
    @State private var preview: URL?

    var body: some View {
        VStack(alignment: .leading, spacing: Tokens.Spacing.s) {
            Label(MailStrings.messageAttachments(attachments.count), systemImage: "paperclip").font(.inter(.footnote, weight: .medium))
            ForEach(attachments) { attachment in
                let name = attachment.fileName.isEmpty ? MailStrings.messageAttachment : attachment.fileName
                let color = Color(mailRGB: MailLogic.attachmentColor(MailLogic.attachmentKind(name)))
                Button {
                    open(attachment, name: name)
                } label: {
                    HStack(spacing: Tokens.Spacing.m) {
                        Image(systemName: "doc")
                            .foregroundStyle(color)
                            .frame(width: 36, height: 36)
                            .background(color.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
                        VStack(alignment: .leading, spacing: 2) {
                            Text(name).lineLimit(1).foregroundStyle(.primary)
                            Text([MailLogic.extensionLabel(name), attachment.size > 0 ? MailLogic.fileSize(attachment.size) : ""].filter { !$0.isEmpty }.joined(separator: " · "))
                                .font(.inter(.caption))
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        if opening == attachment.id {
                            ProgressView()
                        } else {
                            Image(systemName: "arrow.down.circle").foregroundStyle(.secondary)
                        }
                    }
                    .padding(Tokens.Spacing.m)
                    .overlay(RoundedRectangle(cornerRadius: Tokens.Radius.medium).stroke(Color(.separator)))
                }
                .buttonStyle(.plain)
                .disabled(opening != nil)
                .accessibilityIdentifier("attachment-\(name)")
            }
        }
        .padding(.horizontal, Tokens.Spacing.l)
        .padding(.vertical, Tokens.Spacing.s)
        .quickLookPreview($preview)
    }

    private func open(_ attachment: MailAttachment, name: String) {
        opening = attachment.id
        Task {
            do {
                preview = try await MailFiles.download(attachment, env: env)
            } catch {
                let status = APIError.from(error).status
                notifier.show(status == 404 || status == 403
                    ? MailStrings.messageAttachmentUnavailable(name: name)
                    : MailStrings.messageDownloadFailed(name: name))
            }
            opening = nil
        }
    }
}

/// An earlier message of the conversation: collapsed to its sender, or open with its own actions.
private struct ThreadMessageView: View {
    let message: MailMessage
    let onReply: (ComposeMode) -> Void
    let onContact: (String) -> Void

    @State private var expanded = false

    var body: some View {
        let sender = message.senderName ?? MailStrings.commonNoSender
        VStack(alignment: .leading, spacing: 0) {
            Divider()
            Button {
                expanded.toggle()
            } label: {
                HStack(spacing: Tokens.Spacing.m) {
                    SenderAvatar(name: sender, size: 32)
                        .onTapGesture { onContact(message.from.map { $0.email.isEmpty ? sender : $0.email } ?? sender) }
                    VStack(alignment: .leading, spacing: 2) {
                        Text(sender).fontWeight(.medium).lineLimit(1).foregroundStyle(.primary)
                        if expanded {
                            let to = message.to.map(\.label).joined(separator: ", ")
                            Text(to.isEmpty ? MailStrings.messageToMe : MailStrings.messageTo(recipients: to))
                                .font(.inter(.footnote))
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        } else {
                            Text(message.preview ?? "").font(.inter(.footnote)).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                    Spacer()
                    Text(rowTime(message.listDate)).font(.inter(.caption)).foregroundStyle(.secondary)
                    Image(systemName: expanded ? "chevron.up" : "chevron.down").font(.inter(.caption))
                }
                .padding(.horizontal, Tokens.Spacing.l)
                .padding(.vertical, Tokens.Spacing.m)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("thread-message")
            if expanded {
                if let html = message.htmlBody, !html.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    EmailWebView(html: html, hideQuotes: true)
                } else {
                    Text(message.textBody ?? message.preview ?? MailStrings.commonNoContent)
                        .textSelection(.enabled)
                        .padding(.horizontal, Tokens.Spacing.l)
                }
                HStack(spacing: Tokens.Spacing.s) {
                    Button(MailStrings.messageReply) { onReply(.reply) }
                    if message.to.count + message.cc.count > 1 {
                        Button(MailStrings.messageReplyAll) { onReply(.replyAll) }
                    }
                    Button(MailStrings.messageForward) { onReply(.forward) }
                }
                .buttonStyle(.bordered)
                .padding(Tokens.Spacing.l)
            }
        }
    }
}
