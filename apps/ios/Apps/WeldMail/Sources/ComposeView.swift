import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers
import WeldCore
import WeldUI

/// A new message, a reply or a forward: recipients with suggestions from the
/// contacts, a rich-text body, attachments from photos, the camera or files,
/// sending now, later or at a set time. Offline, it waits in the outbox;
/// closed with content, it is kept as a draft.
struct ComposeView: View {
    let env: AppEnvironment
    let store: MailStore
    let prefill: ComposePrefill

    private enum Field: Hashable {
        case to, cc, bcc, subject
    }

    /// Which "when" sheet is open: "Send later" sends on choosing, "Schedule send" only sets the time.
    private enum WhenSheet: String, Identifiable {
        case sendLater, schedule
        var id: String { rawValue }
    }

    private struct AlertContent: Identifiable {
        let id = UUID()
        let title: String
        let message: String
    }

    /// A send waiting for "Send anyway" (no body).
    private struct PendingSend: Identifiable {
        let id = UUID()
        let at: Date?
    }

    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @Environment(MailNotifier.self) private var notifier
    @FocusState private var focus: Field?

    @State private var from: MailAccount?
    @State private var to: [String]
    @State private var cc: [String]
    @State private var bcc: [String] = []
    @State private var typedTo = ""
    @State private var typedCc = ""
    @State private var typedBcc = ""
    @State private var showCcBcc: Bool
    @State private var subject: String
    @State private var editor = RichEditorModel()
    @State private var files: [PickedFile] = []
    @State private var scheduledAt: Date?
    @State private var sending = false
    @State private var recipientMissing = false
    @State private var suggestions: [MailContact] = []
    @State private var whenSheet: WhenSheet?
    @State private var pickingDate: WhenSheet?
    /// What a "when" sheet chose, acted on once the sheet is gone.
    @State private var chosen: (sheet: WhenSheet, at: Date?)?
    @State private var showQuote = false
    @State private var alert: AlertContent?
    @State private var confirmEmpty: PendingSend?
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var pickingPhotos = false
    @State private var importingFiles = false
    @State private var takingPhoto = false

    init(env: AppEnvironment, store: MailStore, prefill: ComposePrefill) {
        self.env = env
        self.store = store
        self.prefill = prefill
        _to = State(initialValue: prefill.to)
        _cc = State(initialValue: prefill.cc)
        _showCcBcc = State(initialValue: !prefill.cc.isEmpty)
        _subject = State(initialValue: prefill.subject)
    }

    // MARK: Derived

    private var allTo: [String] { MailLogic.withPending(to, typed: typedTo) }
    private var allCc: [String] { MailLogic.withPending(cc, typed: typedCc) }
    private var allBcc: [String] { MailLogic.withPending(bcc, typed: typedBcc) }
    private var hasRecipient: Bool { !to.isEmpty || !typedTo.trimmingCharacters(in: .whitespaces).isEmpty }

    private var hasContent: Bool {
        hasRecipient
            || !subject.trimmingCharacters(in: .whitespaces).isEmpty
            || !editor.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var quoteLabel: String { prefill.mode == .forward ? MailStrings.composeForwardedMessage : MailStrings.composeOriginalMessage }
    private var quoteFrom: String { MailStrings.composeQuotedFrom(from: prefill.quotedFrom) }
    private var quoteSubject: String { MailStrings.composeQuotedSubject(subject: prefill.quotedSubject) }
    private var quotedSuffix: String { MailLogic.quotedSuffix(prefill, label: quoteLabel, from: quoteFrom, subject: quoteSubject) }

    private var title: String {
        switch prefill.mode {
        case .new: return MailStrings.composeNewTitle
        case .reply: return MailStrings.composeReplyTitle
        case .replyAll: return MailStrings.composeReplyAllTitle
        case .forward: return MailStrings.composeForwardTitle
        }
    }

    /// What is being typed into the recipient field in focus.
    private var query: String {
        switch focus {
        case .to: return typedTo
        case .cc: return typedCc
        case .bcc: return typedBcc
        default: return ""
        }
    }

    // MARK: Body

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    recipientRow(.to, label: MailStrings.composeTo, chips: $to, typed: $typedTo, invalid: recipientMissing) {
                        Button {
                            showCcBcc.toggle()
                        } label: {
                            Image(systemName: showCcBcc ? "chevron.up" : "chevron.down")
                        }
                        .accessibilityLabel(showCcBcc ? MailStrings.composeHideCcBcc : MailStrings.composeShowCcBcc)
                        .accessibilityIdentifier("compose-cc-toggle")
                    }
                    if recipientMissing {
                        Text(MailStrings.composeRecipientRequired)
                            .font(.inter(.footnote))
                            .foregroundStyle(.red)
                            .padding(.horizontal, Tokens.Spacing.l)
                    }
                    if focus == .to { suggestionList(.to) }
                    if showCcBcc {
                        recipientRow(.cc, label: MailStrings.composeCc, chips: $cc, typed: $typedCc, invalid: false) { EmptyView() }
                        if focus == .cc { suggestionList(.cc) }
                        recipientRow(.bcc, label: MailStrings.composeBcc, chips: $bcc, typed: $typedBcc, invalid: false) { EmptyView() }
                        if focus == .bcc { suggestionList(.bcc) }
                    }
                    if query.trimmingCharacters(in: .whitespaces).isEmpty {
                        details
                    }
                }
            }
            .scrollDismissesKeyboard(.interactively)
            .safeAreaInset(edge: .bottom) { formatBar }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { composeToolbar }
        }
        .interactiveDismissDisabled(hasContent || sending)
        .task {
            if from == nil {
                let accounts = store.sendableAccounts
                from = accounts.first { $0.id == prefill.accountID }
                    ?? store.selectedAccount.flatMap { $0.inActiveWorkspace ? $0 : nil }
                    ?? accounts.first
            }
            // Recent contacts at once; matches as an address is typed.
            suggestions = (try? await store.repository.people(search: nil)) ?? []
        }
        .task(id: query) {
            let text = query.trimmingCharacters(in: .whitespaces)
            guard !text.isEmpty else { return }
            try? await Task.sleep(for: .milliseconds(200))
            guard !Task.isCancelled else { return }
            if let found = try? await store.repository.people(search: text) { suggestions = found }
        }
        .onChange(of: hasRecipient) { _, value in if value { recipientMissing = false } }
        .sheet(item: $whenSheet, onDismiss: afterWhenSheet) { sheet in
            TimeChoiceSheet(
                title: sheet == .sendLater ? MailStrings.sendLaterSendLaterTitle : MailStrings.sendLaterScheduleTitle,
                choices: TimeChoice.sendLater(),
                tint: .accentColor,
                onChoose: { at in
                    chosen = (sheet, at)
                    whenSheet = nil
                },
                onPick: {
                    chosen = (sheet, nil)
                    whenSheet = nil
                }
            )
        }
        .sheet(item: $pickingDate, onDismiss: afterWhenSheet) { sheet in
            DateTimeSheet { at in
                chosen = (sheet, at)
                pickingDate = nil
            }
        }
        .alert(alert?.title ?? "", isPresented: Binding(get: { alert != nil }, set: { if !$0 { alert = nil } }), presenting: alert) { _ in
            Button(CoreStrings.commonDone) { alert = nil }
        } message: { content in
            Text(content.message)
        }
        .alert(MailStrings.composeSendWithoutBodyTitle, isPresented: Binding(get: { confirmEmpty != nil }, set: { if !$0 { confirmEmpty = nil } })) {
            Button(MailStrings.composeSendAnyway) {
                let pending = confirmEmpty
                confirmEmpty = nil
                if let pending { perform(at: pending.at) }
            }
            .accessibilityIdentifier("send-anyway")
            Button(CoreStrings.commonCancel, role: .cancel) { confirmEmpty = nil }
        } message: {
            Text(MailStrings.composeSendWithoutBodyMessage)
        }
        .photosPicker(isPresented: $pickingPhotos, selection: $photoItems, matching: .any(of: [.images, .videos]))
        .onChange(of: photoItems) { _, items in
            guard !items.isEmpty else { return }
            photoItems = []
            Task {
                for (index, item) in items.enumerated() {
                    if let data = try? await item.loadTransferable(type: Data.self),
                       let file = MailFiles.write(data, type: item.supportedContentTypes.first, index: index + 1) {
                        files.append(file)
                    }
                }
            }
        }
        .fileImporter(isPresented: $importingFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            if case let .success(urls) = result {
                files.append(contentsOf: urls.compactMap(MailFiles.copy))
            }
        }
        .fullScreenCover(isPresented: $takingPhoto) {
            CameraPicker { data in
                takingPhoto = false
                if let data, let file = MailFiles.write(data, type: .jpeg) { files.append(file) }
            }
            .ignoresSafeArea()
        }
    }

    // MARK: Pieces

    @ToolbarContentBuilder
    private var composeToolbar: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            Button {
                close()
            } label: {
                Image(systemName: "xmark")
            }
            .disabled(sending)
            .accessibilityLabel(MailStrings.composeClose)
            .accessibilityIdentifier("compose-close")
        }
        ToolbarItem(placement: .principal) {
            Menu {
                ForEach(store.sendableAccounts) { account in
                    Button(account.email) { from = account }
                }
            } label: {
                VStack(spacing: 0) {
                    Text(title).font(.inter(.headline)).foregroundStyle(.primary)
                    if let from {
                        HStack(spacing: 2) {
                            Text(from.email).font(.inter(.caption)).lineLimit(1)
                            if store.sendableAccounts.count > 1 { Image(systemName: "chevron.down").font(.inter(.caption2)) }
                        }
                        .foregroundStyle(.secondary)
                    }
                }
            }
            .disabled(store.sendableAccounts.count < 2)
            .accessibilityLabel(MailStrings.composeFrom)
            .accessibilityIdentifier("compose-from")
        }
        ToolbarItem(placement: .confirmationAction) {
            if sending {
                ProgressView()
            } else {
                Button {
                    submit(at: scheduledAt)
                } label: {
                    Image(systemName: "paperplane.fill")
                }
                .tint(hasRecipient ? Color.accentColor : Color.secondary)
                .accessibilityLabel(MailStrings.composeSend)
                .accessibilityIdentifier("compose-send")
            }
        }
    }

    private func recipientRow<Trailing: View>(
        _ field: Field,
        label: String,
        chips: Binding<[String]>,
        typed: Binding<String>,
        invalid: Bool,
        @ViewBuilder trailing: () -> Trailing
    ) -> some View {
        VStack(spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: Tokens.Spacing.s) {
                Text(label).foregroundStyle(invalid ? Color.red : Color.secondary)
                FlowLayout(spacing: Tokens.Spacing.xs) {
                    ForEach(Array(chips.wrappedValue.enumerated()), id: \.offset) { index, email in
                        Button {
                            if index < chips.wrappedValue.count { chips.wrappedValue.remove(at: index) }
                        } label: {
                            HStack(spacing: 4) {
                                Text(email).lineLimit(1)
                                Image(systemName: "xmark").font(.inter(.caption2))
                            }
                            .font(.inter(.subheadline))
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(Color(.secondarySystemBackground), in: Capsule())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(MailStrings.composeRemoveRecipient(email: email))
                    }
                    TextField("", text: typed)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .textContentType(.emailAddress)
                        .submitLabel(.next)
                        .focused($focus, equals: field)
                        .frame(minWidth: 120)
                        .onSubmit { commit(typed: typed, chips: chips) }
                        .onChange(of: typed.wrappedValue) { _, value in
                            if let committed = MailLogic.committedAddress(value) {
                                chips.wrappedValue.append(committed)
                                typed.wrappedValue = ""
                            }
                        }
                        .accessibilityIdentifier("compose-\(fieldName(field))")
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                trailing()
            }
            .padding(.horizontal, Tokens.Spacing.l)
            .padding(.vertical, Tokens.Spacing.m)
            Divider()
        }
    }

    private func fieldName(_ field: Field) -> String {
        switch field {
        case .to: return "to"
        case .cc: return "cc"
        case .bcc: return "bcc"
        case .subject: return "subject"
        }
    }

    private func commit(typed: Binding<String>, chips: Binding<[String]>) {
        let value = typed.wrappedValue.trimmingCharacters(in: .whitespaces)
        guard !value.isEmpty else { return }
        chips.wrappedValue.append(contentsOf: MailLogic.splitAddresses(value))
        typed.wrappedValue = ""
    }

    private func choose(_ email: String, for field: Field) {
        switch field {
        case .to:
            to.append(email)
            typedTo = ""
        case .cc:
            cc.append(email)
            typedCc = ""
        case .bcc:
            bcc.append(email)
            typedBcc = ""
        case .subject:
            break
        }
        focus = nil
    }

    @ViewBuilder
    private func suggestionList(_ field: Field) -> some View {
        let text = query.trimmingCharacters(in: .whitespaces)
        if !text.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(suggestions.filter { !($0.email ?? "").isEmpty }) { person in
                    let email = person.email ?? ""
                    Button {
                        choose(email, for: field)
                    } label: {
                        HStack(spacing: Tokens.Spacing.m) {
                            SenderAvatar(name: person.name ?? email, size: 32)
                            VStack(alignment: .leading) {
                                Text(person.name ?? email).lineLimit(1).foregroundStyle(.primary)
                                if person.name != nil { Text(email).font(.inter(.caption)).foregroundStyle(.secondary).lineLimit(1) }
                            }
                            Spacer()
                        }
                        .padding(.horizontal, Tokens.Spacing.l)
                        .padding(.vertical, Tokens.Spacing.s)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                Button {
                    choose(text, for: field)
                } label: {
                    Label(MailStrings.composeAddContact(email: text), systemImage: "plus")
                        .padding(.horizontal, Tokens.Spacing.l)
                        .padding(.vertical, Tokens.Spacing.s)
                }
                .accessibilityIdentifier("compose-add-typed")
                Divider()
            }
            .accessibilityIdentifier("compose-suggestions")
        }
    }

    private var details: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(MailStrings.composeSubject).foregroundStyle(.secondary)
                TextField("", text: $subject)
                    .focused($focus, equals: .subject)
                    .accessibilityIdentifier("compose-subject")
            }
            .padding(.horizontal, Tokens.Spacing.l)
            .padding(.vertical, Tokens.Spacing.m)
            Divider()
            if let scheduledAt {
                Button {
                    self.scheduledAt = nil
                } label: {
                    Label(MailStrings.sendLaterScheduledFor(time: momentText(scheduledAt)), systemImage: "xmark.circle.fill")
                        .font(.inter(.subheadline))
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(Color.accentColor.opacity(0.12), in: Capsule())
                }
                .accessibilityLabel(MailStrings.sendLaterClear)
                .accessibilityIdentifier("compose-scheduled")
                .padding(.horizontal, Tokens.Spacing.l)
                .padding(.top, Tokens.Spacing.s)
            }
            if !files.isEmpty {
                FlowLayout(spacing: Tokens.Spacing.s) {
                    ForEach(files) { file in
                        Button {
                            files.removeAll { $0.id == file.id }
                        } label: {
                            HStack(spacing: 4) {
                                Image(systemName: "paperclip")
                                Text(file.name).lineLimit(1).frame(maxWidth: 200)
                                Image(systemName: "xmark").font(.inter(.caption2))
                            }
                            .font(.inter(.subheadline))
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(Color(.secondarySystemBackground), in: Capsule())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(MailStrings.composeRemoveAttachment(name: file.name))
                    }
                }
                .padding(.horizontal, Tokens.Spacing.l)
                .padding(.vertical, Tokens.Spacing.s)
            }
            RichEditor(model: editor, placeholder: MailStrings.composeBodyPlaceholder, dark: colorScheme == .dark)
                .frame(minHeight: 260)
                .padding(.horizontal, Tokens.Spacing.l)
                .accessibilityIdentifier("compose-body")
            if prefill.mode != .new && !prefill.quotedBody.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                VStack(alignment: .leading, spacing: Tokens.Spacing.xs) {
                    Button {
                        showQuote.toggle()
                    } label: {
                        Image(systemName: "ellipsis").padding(8).background(Color(.secondarySystemBackground), in: Capsule())
                    }
                    .accessibilityLabel(MailStrings.composeShowQuoted)
                    .accessibilityIdentifier("compose-show-quote")
                    if showQuote {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("---------- \(quoteLabel) ---------").font(.inter(.caption))
                            Text(quoteFrom).font(.inter(.footnote))
                            Text(MailStrings.composeQuotedDate(date: fullTime(prefill.quotedDate))).font(.inter(.footnote))
                            Text(quoteSubject).font(.inter(.footnote))
                            Text(prefill.quotedBody).font(.inter(.footnote)).padding(.top, Tokens.Spacing.s)
                        }
                        .padding(Tokens.Spacing.m)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: Tokens.Radius.small))
                    }
                }
                .padding(Tokens.Spacing.l)
            }
        }
    }

    private var formatBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Tokens.Spacing.xs) {
                formatButton("bold", on: editor.bold, label: MailStrings.composeBold, command: "bold")
                formatButton("italic", on: editor.italic, label: MailStrings.composeItalic, command: "italic")
                formatButton("underline", on: editor.underline, label: MailStrings.composeUnderline, command: "underline")
                formatButton("list.bullet", on: editor.bullets, label: MailStrings.composeBulletList, command: "insertUnorderedList")
                formatButton("list.number", on: editor.numbers, label: MailStrings.composeNumberedList, command: "insertOrderedList")
                Menu {
                    Button { pickingPhotos = true } label: { Label(MailStrings.composePhotoLibrary, systemImage: "photo.on.rectangle") }
                    if UIImagePickerController.isSourceTypeAvailable(.camera) {
                        Button { takingPhoto = true } label: { Label(MailStrings.composeTakePhoto, systemImage: "camera") }
                    }
                    Button { importingFiles = true } label: { Label(MailStrings.composeChooseFile, systemImage: "folder") }
                } label: {
                    Image(systemName: "paperclip").frame(width: 40, height: 40)
                }
                .disabled(sending)
                .accessibilityLabel(MailStrings.composeAddAttachment)
                .accessibilityIdentifier("compose-attach")
                Button {
                    openWhen(.schedule)
                } label: {
                    Image(systemName: "clock")
                        .foregroundStyle(scheduledAt != nil ? Color.accentColor : Color.secondary)
                        .frame(width: 40, height: 40)
                }
                .disabled(sending)
                .accessibilityLabel(MailStrings.composeSchedule)
                .accessibilityIdentifier("compose-schedule")
                Button {
                    openWhen(.sendLater)
                } label: {
                    Image(systemName: "calendar.badge.clock").frame(width: 40, height: 40)
                }
                .disabled(sending)
                .accessibilityLabel(MailStrings.composeSendLater)
                .accessibilityIdentifier("compose-send-later")
                if env.isAvailable("mail-ai") {
                    Button {
                        notifier.show(MailStrings.composeAiUnavailable)
                    } label: {
                        Image(systemName: "sparkles").foregroundStyle(MailColors.pin).frame(width: 40, height: 40)
                    }
                    .accessibilityLabel(MailStrings.composeAi)
                }
            }
            .padding(.horizontal, Tokens.Spacing.s)
        }
        .padding(.vertical, Tokens.Spacing.xs)
        .background(.bar)
    }

    private func formatButton(_ symbol: String, on: Bool, label: String, command: String) -> some View {
        Button {
            editor.format(command)
        } label: {
            Image(systemName: symbol)
                .foregroundStyle(on ? Color.accentColor : Color.secondary)
                .frame(width: 40, height: 40)
                .background(on ? Color.accentColor.opacity(0.12) : Color.clear, in: RoundedRectangle(cornerRadius: 8))
        }
        .accessibilityLabel(label)
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    // MARK: Actions

    private func openWhen(_ sheet: WhenSheet) {
        if from == nil {
            alert = AlertContent(title: MailStrings.composeSendFailedTitle, message: MailStrings.composeNoAccount)
        } else if !hasRecipient {
            recipientMissing = true
        } else {
            whenSheet = sheet
        }
    }

    /// A "when" sheet closed: send, set the time, or open the date picker.
    private func afterWhenSheet() {
        guard let choice = chosen else { return }
        chosen = nil
        guard let at = choice.at else {
            pickingDate = choice.sheet
            return
        }
        if choice.sheet == .sendLater {
            submit(at: at)
        } else {
            scheduledAt = at
        }
    }

    private func close() {
        let account = from
        let keep = hasContent
        let draft = account.map {
            MailStore.DraftContent(
                accountID: $0.id,
                to: allTo,
                cc: allCc,
                bcc: allBcc,
                subject: subject,
                body: editor.html.isEmpty ? editor.text : editor.html,
                html: !editor.html.isEmpty
            )
        }
        dismiss()
        guard keep, let draft else { return }
        store.saveDraft(draft)
        Self.announceDraftSaved(store: store, notifier: notifier)
    }

    /// "Draft saved", with Discard; then "Draft discarded", with Undo.
    private static func announceDraftSaved(store: MailStore, notifier: MailNotifier) {
        notifier.show(MailStrings.inboxDraftSaved, action: MailStrings.commonDiscard) {
            Task {
                await store.discardDraft()
                notifier.show(MailStrings.inboxDraftDiscarded, action: MailStrings.commonUndo) {
                    store.restoreDraft()
                    announceDraftSaved(store: store, notifier: notifier)
                }
            }
        }
    }

    /// Checks the send can go, then sends (or asks first when there is no body).
    private func submit(at: Date?) {
        guard from != nil else {
            alert = AlertContent(title: MailStrings.composeSendFailedTitle, message: MailStrings.composeNoAccount)
            return
        }
        guard hasRecipient else {
            recipientMissing = true
            return
        }
        if at != nil && !files.isEmpty {
            alert = AlertContent(
                title: MailStrings.composeAttachmentsNotSupportedTitle,
                message: at == scheduledAt ? MailStrings.composeAttachmentsScheduledSend : MailStrings.composeAttachmentsScheduledLater
            )
            return
        }
        if MailLogic.hasNoBody(text: editor.text, quotedSuffix: quotedSuffix, attachmentCount: files.count) {
            confirmEmpty = PendingSend(at: at)
        } else {
            perform(at: at)
        }
    }

    private func perform(at: Date?) {
        guard let account = from else { return }
        sending = true
        let html = !editor.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || editor.html.lowercased().contains("<img") ? editor.html : ""
        Task {
            defer { sending = false }
            do {
                if let at {
                    let payload = MailLogic.sendPayload(
                        to: allTo, cc: allCc, bcc: allBcc, subject: subject, text: editor.text, html: html,
                        quotedSuffix: quotedSuffix, attachments: [], idempotencyKey: nil,
                        inReplyTo: prefill.inReplyTo, references: prefill.references, noSubject: MailStrings.commonNoSubject
                    )
                    let trimmed = subject.trimmingCharacters(in: .whitespacesAndNewlines)
                    try await store.repository.schedule(SchedulePayload(
                        accountID: account.id,
                        to: payload.to,
                        cc: payload.cc,
                        bcc: payload.bcc,
                        subject: trimmed.isEmpty ? nil : trimmed,
                        body: payload.body,
                        htmlBody: payload.htmlBody,
                        scheduledFor: WeldDate.timestampString(at),
                        inReplyTo: payload.inReplyTo,
                        references: payload.references
                    ))
                    dismiss()
                    notifier.show(MailStrings.composeScheduled(time: momentText(at)))
                    return
                }
                var uploaded: [UploadedAttachment] = []
                for file in files {
                    do {
                        uploaded.append(try await MailFiles.upload(file, env: env))
                    } catch {
                        alert = AlertContent(title: MailStrings.composeSendFailedTitle, message: MailStrings.composeUploadFailed(name: file.name))
                        return
                    }
                }
                let payload = MailLogic.sendPayload(
                    to: allTo, cc: allCc, bcc: allBcc, subject: subject, text: editor.text, html: html,
                    quotedSuffix: quotedSuffix, attachments: uploaded,
                    idempotencyKey: MailLogic.idempotencyKey(nowMillis: Int64(Date().timeIntervalSince1970 * 1000)) { Int.random(in: 0..<$0) },
                    inReplyTo: prefill.inReplyTo, references: prefill.references, noSubject: MailStrings.commonNoSubject
                )
                do {
                    try await store.repository.send(accountID: account.id, payload: payload)
                    dismiss()
                    notifier.show(MailStrings.composeSent)
                } catch let failure as SendFailure where failure.isNetwork {
                    // Offline: it goes out when the phone is back online, once (its key).
                    store.queueSend(accountID: account.id, payload: payload)
                    dismiss()
                    notifier.show(MailStrings.composeQueued)
                }
            } catch {
                fail(error, fallback: at != nil ? MailStrings.composeScheduleFailed : MailStrings.composeSendFailed)
            }
        }
    }

    private func fail(_ error: Error, fallback: String) {
        let failure = error as? SendFailure
        if let failure, let described = SendErrors.describe(code: failure.code, details: failure.details) {
            alert = AlertContent(title: described.title, message: described.message)
            return
        }
        let status = failure?.status ?? APIError.from(error).status
        var serverMessage: String?
        if let status, (400..<500).contains(status), failure?.code != nil { serverMessage = failure?.message }
        alert = AlertContent(title: MailStrings.composeSendFailedTitle, message: serverMessage ?? fallback)
    }
}

/// The camera, for a photo to attach.
struct CameraPicker: UIViewControllerRepresentable {
    let onDone: (Data?) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onDone: onDone) }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let onDone: (Data?) -> Void

        init(onDone: @escaping (Data?) -> Void) {
            self.onDone = onDone
        }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            let image = info[.originalImage] as? UIImage
            onDone(image?.jpegData(compressionQuality: 0.85))
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            onDone(nil)
        }
    }
}
