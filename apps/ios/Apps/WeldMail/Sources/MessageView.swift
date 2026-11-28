import QuickLook
import SwiftUI
import UIKit
import WeldCore
import WeldUI

/// One conversation, as the platform's message view: the subject, the earlier
/// messages collapsed to one line (oldest first), the newest open at the
/// bottom with its sender, recipients, body and files, and Reply, Reply all
/// and Forward under it. Cache first (so it opens offline), then the server.
/// Opening it marks it read.
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

    private func star(_ target: MailMessage, _ on: Bool) {
        if target.id == message?.id { message?.isStarred = on }
        if let index = thread.firstIndex(where: { $0.id == target.id }) { thread[index].isStarred = on }
        store.setStarred(target.id, on)
    }

    // MARK: Content

    private func content(_ current: MailMessage) -> some View {
        let pinned = MailLogic.isPinned(current)
        let conversation = MailLogic.conversation(current, others: thread)
        let newest = conversation.last ?? current
        let older = Array(conversation.dropLast())
        let labelColors = Dictionary(store.labels.custom.map { ($0.name, $0.color) }, uniquingKeysWith: { first, _ in first })
        let shown = MailLogic.displayLabels(current.labels)
        return ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                // The subject, with the conversation's size and the message's own labels.
                HStack(alignment: .top, spacing: Tokens.Spacing.s) {
                    Text(current.subject.flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 } ?? MailStrings.commonNoSubject)
                        .font(.inter(.headline))
                        .accessibilityIdentifier("message-subject")
                    Spacer(minLength: 0)
                    if conversation.count > 1 {
                        CountBadge(count: conversation.count, height: 18)
                            .padding(.top, 2)
                            .accessibilityLabel(MailStrings.messageConversation(conversation.count))
                    }
                }
                .padding(.horizontal, Tokens.Spacing.l)
                .padding(.top, Tokens.Spacing.xs)
                .padding(.bottom, Tokens.Spacing.m)
                if !shown.isEmpty {
                    FlowLayout(spacing: 6) {
                        ForEach(shown, id: \.self) { label in
                            LabelChip(name: label, color: labelTint(label, own: labelColors[label] ?? nil))
                        }
                    }
                    .padding(.horizontal, Tokens.Spacing.l)
                    .padding(.bottom, Tokens.Spacing.m)
                }
                Hairline()
                // Earlier messages, oldest first and collapsed to one line.
                ForEach(older) { earlier in
                    ThreadMessageView(
                        message: earlier,
                        selfAddresses: store.ownAddresses,
                        onReply: { mode in reply(earlier, mode) },
                        onStar: { on in star(earlier, on) },
                        onContact: openContact
                    )
                }
                // The newest message, open at the bottom of the conversation.
                NewestHeader(
                    message: newest,
                    selfAddresses: store.ownAddresses,
                    onStar: { star(newest, !newest.isStarred) },
                    onReply: { reply(newest, .reply) },
                    onContact: openContact
                )
                UnsubscribeChip(store: store, message: newest)
                Group {
                    if let html = newest.htmlBody, !html.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        EmailWebView(html: html, fontSize: 14, lineHeight: 1.625, initialHeight: 300)
                    } else if bodyLoading && (newest.textBody ?? newest.preview ?? "").isEmpty {
                        ProgressView().frame(maxWidth: .infinity).padding(32)
                    } else {
                        let text = newest.textBody ?? newest.preview ?? ""
                        let empty = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        Text(empty ? MailStrings.commonNoContent : text)
                            .font(.inter(.subheadline))
                            .lineSpacing(4)
                            .foregroundStyle(empty ? Tokens.Palette.mutedForeground : Tokens.Palette.foreground)
                            .textSelection(.enabled)
                    }
                }
                // The same side padding as the header above it.
                .padding(.horizontal, Tokens.Spacing.l)
                .padding(.top, Tokens.Spacing.s)
                .padding(.bottom, Tokens.Spacing.l)
                if !newest.attachments.isEmpty {
                    AttachmentsBlock(env: env, attachments: newest.attachments)
                }
                Spacer(minLength: Tokens.Spacing.l)
            }
        }
        .accessibilityIdentifier("message-screen")
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 0) {
                Hairline()
                HStack(spacing: Tokens.Spacing.s) {
                    actionButton(MailStrings.messageReply, symbol: "arrowshape.turn.up.left") { reply(newest, .reply) }
                        .accessibilityIdentifier("reply")
                    if newest.to.count + newest.cc.count > 1 {
                        actionButton(MailStrings.messageReplyAll, symbol: "arrowshape.turn.up.left.2") { reply(newest, .replyAll) }
                            .accessibilityIdentifier("reply-all")
                    }
                    actionButton(MailStrings.messageForward, symbol: "arrowshape.turn.up.right") { reply(newest, .forward) }
                        .accessibilityIdentifier("forward")
                }
                .padding(.horizontal, Tokens.Spacing.l)
                .padding(.vertical, Tokens.Spacing.m)
            }
            .background(Tokens.Palette.background)
        }
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button {
                    star(current, !current.isStarred)
                } label: {
                    Image(systemName: current.isStarred ? "star.fill" : "star")
                        .foregroundStyle(current.isStarred ? MailColors.star : Tokens.Palette.foreground)
                }
                .accessibilityLabel(current.isStarred ? MailStrings.messageUnstar : MailStrings.messageStar)
                .accessibilityIdentifier("message-star")

                Button {
                    store.archive(current.id)
                    dismiss()
                } label: {
                    Image(systemName: "archivebox")
                }
                .accessibilityLabel(MailStrings.messageArchive)
                .accessibilityIdentifier("message-archive")

                Button {
                    store.delete(current.id)
                    dismiss()
                } label: {
                    Image(systemName: "trash").foregroundStyle(Tokens.Status.danger)
                }
                .accessibilityLabel(MailStrings.messageDelete)
                .accessibilityIdentifier("message-delete")

                Menu {
                    Button {
                        store.setRead(current.id, false)
                        dismiss()
                    } label: { Label(MailStrings.messageMarkUnread, systemImage: "envelope.badge") }
                    Button {
                        store.archive(current.id)
                        leave(goNext: true, from: current)
                    } label: { Label(MailStrings.messageMarkDone, systemImage: "checkmark") }
                        .accessibilityIdentifier("archive-next")
                    Button {
                        let before = current.labels
                        message?.labels = MailLogic.withPinned(before, on: !pinned)
                        Task {
                            do {
                                let labels = try await store.setPinned(current.id, labels: before, on: !pinned)
                                message?.labels = labels
                            } catch {
                                message?.labels = before
                                notifier.show(error)
                            }
                        }
                    } label: { Label(pinned ? MailStrings.messageUnpin : MailStrings.messagePin, systemImage: pinned ? "pin.slash" : "pin") }
                        .accessibilityIdentifier("message-pin")
                    Button { snoozing = true } label: { Label(MailStrings.messageSnooze, systemImage: "clock") }
                    Button { choosingLabels = true } label: { Label(MailStrings.messageLabelAs, systemImage: "tag") }
                    Button { leave(goNext: true, from: current) } label: { Label(MailStrings.messageNext, systemImage: "chevron.down") }
                    Divider()
                    Button(role: .destructive) {
                        store.markSpam(current.id)
                        dismiss()
                    } label: { Label(MailStrings.messageMarkSpam, systemImage: "exclamationmark.triangle") }
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
    }

    /// Reply, Reply all, Forward: the platform's bordered, muted `rounded-lg` buttons under the message.
    private func actionButton(_ title: String, symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: Tokens.Spacing.s) {
                Image(systemName: symbol).font(.system(size: 14))
                Text(title).font(.inter(.subheadline)).lineLimit(1)
            }
            .foregroundStyle(Tokens.Palette.mutedForeground)
            .frame(maxWidth: .infinity, minHeight: 40)
            .overlay(RoundedRectangle(cornerRadius: Tokens.Radius.large).stroke(Tokens.Palette.border))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// "to Sanne Bakker, me", or "to me" when the message names nobody.
private func toLine(_ message: MailMessage, _ selfAddresses: [String]) -> String {
    let names = MailLogic.recipientsLine(message, selfAddresses: selfAddresses, me: MailStrings.commonMe)
    return names.isEmpty ? MailStrings.messageToMe : MailStrings.messageTo(recipients: names.joined(separator: ", "))
}

/// A small muted icon button beside a message's date: star, reply, more.
private struct SmallIcon: View {
    let symbol: String
    var tint = Tokens.Palette.mutedForeground

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: 15))
            .foregroundStyle(tint)
            .frame(width: 32, height: 32)
            .contentShape(Rectangle())
    }
}

/// The newest message's header: the sender (name, then the address) with who
/// it went to, the date, star and reply. The recipients line opens the list
/// of every recipient, as the platform's recipients popover.
private struct NewestHeader: View {
    let message: MailMessage
    let selfAddresses: [String]
    let onStar: () -> Void
    let onReply: () -> Void
    let onContact: (String) -> Void

    @State private var details = false

    var body: some View {
        let sender = message.senderName ?? MailStrings.commonNoSender
        let senderEmail = message.from?.email ?? ""
        let contactKey = senderEmail.isEmpty ? sender : senderEmail
        let muted = Tokens.Palette.mutedForeground
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: Tokens.Spacing.m) {
                Button {
                    onContact(contactKey)
                } label: {
                    MailAvatar(name: sender, url: message.from?.avatarURL)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(MailStrings.messageOpenContact)
                .accessibilityIdentifier("open-contact")
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 6) {
                        Button {
                            onContact(contactKey)
                        } label: {
                            Text(sender).font(.inter(.subheadline, weight: .semibold)).foregroundStyle(Tokens.Palette.foreground).lineLimit(1)
                        }
                        .buttonStyle(.plain)
                        if !senderEmail.isEmpty && senderEmail != sender {
                            Text("<\(senderEmail)>").font(.inter(.caption)).foregroundStyle(muted).lineLimit(1)
                        }
                    }
                    Button {
                        details.toggle()
                    } label: {
                        HStack(spacing: 2) {
                            Text(toLine(message, selfAddresses)).font(.inter(.footnote)).lineLimit(1)
                            Image(systemName: details ? "chevron.up" : "chevron.down").font(.system(size: 10, weight: .semibold))
                        }
                        .foregroundStyle(muted)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(details ? MailStrings.messageHideDetails : MailStrings.messageShowDetails)
                    .accessibilityIdentifier("toggle-details")
                }
                Spacer(minLength: 0)
                Text(dateText(message.listDate, withTime: true)).font(.inter(.caption)).foregroundStyle(muted).lineLimit(1)
                Button(action: onStar) {
                    SmallIcon(symbol: message.isStarred ? "star.fill" : "star", tint: message.isStarred ? MailColors.star : muted)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(message.isStarred ? MailStrings.messageUnstar : MailStrings.messageStar)
                Button(action: onReply) {
                    SmallIcon(symbol: "arrowshape.turn.up.left")
                }
                .buttonStyle(.plain)
                .accessibilityLabel(MailStrings.messageReply)
            }
            if details {
                RecipientsPanel(message: message, onContact: onContact)
                    .padding(.top, Tokens.Spacing.m)
                    .padding(.trailing, Tokens.Spacing.s)
            }
        }
        .padding(.leading, Tokens.Spacing.l)
        .padding(.trailing, Tokens.Spacing.s)
        .padding(.top, Tokens.Spacing.l)
    }
}

/// Every recipient, To then Cc, as the platform's "Recipients (n)" list.
private struct RecipientsPanel: View {
    let message: MailMessage
    let onContact: (String) -> Void

    var body: some View {
        let all: [(MailAddress, Bool)] = message.to.map { ($0, false) } + message.cc.map { ($0, true) }
        let muted = Tokens.Palette.mutedForeground
        VStack(alignment: .leading, spacing: 0) {
            Text(MailStrings.messageRecipients(all.count))
                .font(.inter(.caption, weight: .medium))
                .foregroundStyle(muted)
                .padding(.horizontal, Tokens.Spacing.m)
                .padding(.vertical, Tokens.Spacing.s)
            Hairline()
            ForEach(Array(all.enumerated()), id: \.offset) { _, entry in
                let address = entry.0
                let isCc = entry.1
                let name = address.name.flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 } ?? MailLogic.displayName(address.email)
                Button {
                    onContact(address.email.isEmpty ? name : address.email)
                } label: {
                    HStack(spacing: Tokens.Spacing.m) {
                        MailAvatar(name: name, url: address.avatarURL)
                        VStack(alignment: .leading, spacing: 0) {
                            Text(name).font(.inter(.subheadline, weight: .medium)).foregroundStyle(Tokens.Palette.foreground).lineLimit(1)
                            HStack(spacing: Tokens.Spacing.xs) {
                                Text(address.email).font(.inter(.caption)).foregroundStyle(muted).lineLimit(1)
                                if isCc {
                                    Text(MailStrings.composeCc.uppercased())
                                        .font(.inter(size: 10))
                                        .foregroundStyle(muted)
                                        .padding(.horizontal, 4)
                                        .overlay(RoundedRectangle(cornerRadius: 4).stroke(Tokens.Palette.border))
                                }
                            }
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, Tokens.Spacing.m)
                    .padding(.vertical, 6)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.bottom, Tokens.Spacing.xs)
        .overlay(RoundedRectangle(cornerRadius: Tokens.Radius.medium).stroke(Tokens.Palette.border))
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
                        Button {
                            confirming = true
                        } label: {
                            Text(MailStrings.unsubscribeButton)
                                .font(.inter(.caption, weight: .medium))
                                .foregroundStyle(Tokens.Palette.foreground)
                                .padding(.horizontal, 10)
                                .frame(height: 28)
                                .overlay(RoundedRectangle(cornerRadius: Tokens.Radius.medium).stroke(Tokens.Palette.input))
                        }
                        .buttonStyle(.plain)
                        .disabled(busy)
                        .accessibilityLabel(MailStrings.unsubscribeAccessibility(sender: current.senderLabel))
                        .accessibilityIdentifier("unsubscribe")
                    } else {
                        Text(MailStrings.unsubscribeUnsubscribed).font(.inter(.footnote)).foregroundStyle(Tokens.Palette.mutedForeground)
                    }
                }
                // Under the sender's name, as the platform puts it beside the recipients.
                .padding(.leading, Tokens.Spacing.l + 40)
                .padding(.top, Tokens.Spacing.xs)
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

/// A file's icon by its kind, as the platform's attachment chips (`lib/attachment-icon.ts`).
private func attachmentSymbol(_ kind: AttachmentKind) -> String {
    switch kind {
    case .image: return "photo"
    case .doc: return "doc.text"
    case .sheet: return "tablecells"
    case .slides: return "rectangle.on.rectangle"
    case .archive: return "doc.zipper"
    case .video: return "film"
    case .audio: return "music.note"
    case .pdf, .file: return "doc"
    }
}

/// The message's files as the platform's outlined chips: icon, name, size. Tapped, one downloads and opens in Quick Look.
private struct AttachmentsBlock: View {
    let env: AppEnvironment
    let attachments: [MailAttachment]

    @Environment(MailNotifier.self) private var notifier
    @State private var opening: String?
    @State private var preview: URL?

    var body: some View {
        FlowLayout(spacing: Tokens.Spacing.s) {
            ForEach(attachments) { attachment in
                let name = attachment.fileName.isEmpty ? MailStrings.messageAttachment : attachment.fileName
                Button {
                    open(attachment, name: name)
                } label: {
                    HStack(spacing: Tokens.Spacing.s) {
                        if opening == attachment.id {
                            ProgressView().controlSize(.small)
                        } else {
                            Image(systemName: attachmentSymbol(MailLogic.attachmentKind(name))).font(.system(size: 14))
                        }
                        Text(name).font(.inter(.subheadline)).lineLimit(1).frame(maxWidth: 200, alignment: .leading)
                        if attachment.size > 0 {
                            Text(MailLogic.fileSize(attachment.size)).font(.inter(.caption)).foregroundStyle(Tokens.Palette.mutedForeground)
                        }
                    }
                    .foregroundStyle(Tokens.Palette.foreground)
                    .padding(.horizontal, Tokens.Spacing.m)
                    .padding(.vertical, 6)
                    .overlay(RoundedRectangle(cornerRadius: Tokens.Radius.medium).stroke(Tokens.Palette.border))
                    .contentShape(Rectangle())
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

/// An earlier message of the conversation, as the platform's: collapsed, one
/// line (avatar, sender, snippet, date, star); open, the sender's address,
/// who it went to, reply and more, and the body.
private struct ThreadMessageView: View {
    let message: MailMessage
    let selfAddresses: [String]
    let onReply: (ComposeMode) -> Void
    let onStar: (Bool) -> Void
    let onContact: (String) -> Void

    @State private var expanded = false

    var body: some View {
        let sender = message.senderName ?? MailStrings.commonNoSender
        let senderEmail = message.from?.email ?? ""
        let muted = Tokens.Palette.mutedForeground
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: expanded ? .center : .top, spacing: Tokens.Spacing.m) {
                MailAvatar(name: sender, url: message.from?.avatarURL)
                    .padding(.top, expanded ? 0 : 2)
                    .onTapGesture { onContact(senderEmail.isEmpty ? sender : senderEmail) }
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 6) {
                        Text(sender).font(.inter(.subheadline, weight: .semibold)).foregroundStyle(Tokens.Palette.foreground).lineLimit(1)
                        if expanded && !senderEmail.isEmpty && senderEmail != sender {
                            Text("<\(senderEmail)>").font(.inter(.caption)).foregroundStyle(muted).lineLimit(1)
                        }
                    }
                    Text(expanded ? toLine(message, selfAddresses) : (message.preview ?? ""))
                        .font(.inter(.footnote))
                        .foregroundStyle(muted)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                Text(dateText(message.listDate, withTime: true)).font(.inter(.caption)).foregroundStyle(muted).lineLimit(1)
                Button {
                    onStar(!message.isStarred)
                } label: {
                    SmallIcon(symbol: message.isStarred ? "star.fill" : "star", tint: message.isStarred ? MailColors.star : muted)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(message.isStarred ? MailStrings.messageUnstar : MailStrings.messageStar)
                if expanded {
                    Button {
                        onReply(.reply)
                    } label: {
                        SmallIcon(symbol: "arrowshape.turn.up.left")
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(MailStrings.messageReply)
                    Menu {
                        Button { onReply(.reply) } label: { Label(MailStrings.messageReply, systemImage: "arrowshape.turn.up.left") }
                        if message.to.count + message.cc.count > 1 {
                            Button { onReply(.replyAll) } label: { Label(MailStrings.messageReplyAll, systemImage: "arrowshape.turn.up.left.2") }
                        }
                        Button { onReply(.forward) } label: { Label(MailStrings.messageForward, systemImage: "arrowshape.turn.up.right") }
                    } label: {
                        SmallIcon(symbol: "ellipsis")
                    }
                    .accessibilityLabel(MailStrings.messageMore)
                }
            }
            .padding(.leading, Tokens.Spacing.l)
            .padding(.trailing, Tokens.Spacing.s)
            .padding(.vertical, Tokens.Spacing.m)
            .contentShape(Rectangle())
            .onTapGesture { expanded.toggle() }
            .accessibilityIdentifier("thread-message")
            if expanded {
                Group {
                    if let html = message.htmlBody, !html.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        EmailWebView(html: html, fontSize: 14, lineHeight: 1.625, hideQuotes: true)
                    } else {
                        Text(message.textBody ?? message.preview ?? MailStrings.commonNoContent)
                            .font(.inter(.subheadline))
                            .lineSpacing(4)
                            .textSelection(.enabled)
                    }
                }
                .padding(.horizontal, Tokens.Spacing.l)
                .padding(.bottom, Tokens.Spacing.l)
            }
            Hairline()
        }
    }
}
