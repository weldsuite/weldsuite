import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers
import WeldCore
import WeldUI

/// A new message, a reply or a forward: recipients with suggestions from the
/// contacts, a rich-text body, attachments from photos, the camera or files,
/// sending now or at a set time. Offline, it waits in the outbox;
/// closed with content, it is kept as a draft.
struct ComposeView: View {
    let env: AppEnvironment
    let store: MailStore
    let prefill: ComposePrefill

    private enum Field: Hashable {
        case to, cc, bcc, subject
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
    @State private var showCc: Bool
    @State private var showBcc = false
    @State private var formatting = false
    @State private var subject: String
    @State private var editor = RichEditorModel()
    @State private var files: [PickedFile] = []
    @State private var scheduledAt: Date?
    @State private var sending = false
    @State private var recipientMissing = false
    @State private var suggestions: [MailContact] = []
    @State private var choosingTime = false
    @State private var pickingDate = false
    /// What the time sheet chose, acted on once the sheet is gone.
    @State private var chosenTime: Date?
    @State private var wantsPicker = false
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
        _showCc = State(initialValue: !prefill.cc.isEmpty)
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
                    fromRow
                    recipientRow(.to, label: MailStrings.composeTo, chips: $to, typed: $typedTo, invalid: recipientMissing) {
                        HStack(spacing: 0) {
                            if !showCc {
                                Button {
                                    showCc = true
                                } label: {
                                    Text(MailStrings.composeCc).font(.inter(.subheadline)).foregroundStyle(Tokens.Palette.mutedForeground)
                                        .padding(.horizontal, Tokens.Spacing.s)
                                        .frame(height: 32)
                                }
                                .buttonStyle(.plain)
                                .accessibilityIdentifier("compose-cc-toggle")
                            }
                            if !showBcc {
                                Button {
                                    showBcc = true
                                } label: {
                                    Text(MailStrings.composeBcc).font(.inter(.subheadline)).foregroundStyle(Tokens.Palette.mutedForeground)
                                        .padding(.horizontal, Tokens.Spacing.s)
                                        .frame(height: 32)
                                }
                                .buttonStyle(.plain)
                                .accessibilityIdentifier("compose-bcc-toggle")
                            }
                        }
                    }
                    if recipientMissing {
                        Text(MailStrings.composeRecipientRequired)
                            .font(.inter(.footnote))
                            .foregroundStyle(Tokens.Status.danger)
                            .padding(.leading, Tokens.Spacing.l + fieldLabelWidth)
                            .padding(.bottom, Tokens.Spacing.xs)
                    }
                    if focus == .to { suggestionList(.to) }
                    if showCc {
                        recipientRow(.cc, label: MailStrings.composeCc, chips: $cc, typed: $typedCc, invalid: false) { EmptyView() }
                        if focus == .cc { suggestionList(.cc) }
                    }
                    if showBcc {
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
        .sheet(isPresented: $choosingTime, onDismiss: afterTimeSheet) {
            TimeChoiceSheet(
                title: MailStrings.sendLaterScheduleTitle,
                choices: TimeChoice.sendLater(),
                tint: Tokens.Palette.primary,
                onChoose: { at in
                    chosenTime = at
                    choosingTime = false
                },
                onPick: {
                    wantsPicker = true
                    choosingTime = false
                }
            )
        }
        .sheet(isPresented: $pickingDate) {
            DateTimeSheet { at in
                scheduledAt = at
                pickingDate = false
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
            Text(title).font(.inter(.headline))
        }
    }

    /// The platform's field-label column (`w-[72px]`), so From, To and Subject line up.
    private let fieldLabelWidth: CGFloat = 72

    /// A compose field: its muted label in the label column, then the value.
    private func fieldRow<Content: View>(_ label: String, invalid: Bool = false, @ViewBuilder content: () -> Content) -> some View {
        HStack(alignment: .center, spacing: 0) {
            Text(label)
                .font(.inter(.subheadline))
                .foregroundStyle(invalid ? Tokens.Status.danger : Tokens.Palette.mutedForeground)
                .frame(width: fieldLabelWidth, alignment: .leading)
            content()
        }
        .frame(minHeight: 40)
        .padding(.leading, Tokens.Spacing.l)
        .padding(.trailing, Tokens.Spacing.s)
    }

    /// "From": the sending account's initial and name; a picker when there is more than one.
    private var fromRow: some View {
        fieldRow(MailStrings.composeFrom) {
            Menu {
                ForEach(store.sendableAccounts) { account in
                    Button {
                        from = account
                    } label: {
                        if account.displayName.isEmpty || account.displayName == account.email {
                            Text(account.email)
                        } else {
                            Text("\(account.displayName)\n\(account.email)")
                        }
                    }
                }
            } label: {
                HStack(spacing: 6) {
                    if let from {
                        let name = from.displayName.isEmpty ? from.email : from.displayName
                        // The same single-initial avatar as the inbox rows, in the platform colour for the name.
                        MailAvatar(name: name, size: 20)
                        Text(name).font(.inter(.subheadline, weight: .medium)).foregroundStyle(Tokens.Palette.foreground).lineLimit(1)
                    }
                    if store.sendableAccounts.count > 1 {
                        Image(systemName: "chevron.down").font(.system(size: 10, weight: .semibold)).foregroundStyle(Tokens.Palette.mutedForeground)
                    }
                }
                .padding(.vertical, Tokens.Spacing.xs)
            }
            .disabled(store.sendableAccounts.count < 2)
            .accessibilityLabel(MailStrings.composeFrom)
            .accessibilityIdentifier("compose-from")
            Spacer(minLength: 0)
        }
    }

    /// A recipient, as the platform's: a small person icon and the address, in a `rounded-md` outline; tapped, it goes.
    private func recipientToken(_ email: String, remove: @escaping () -> Void) -> some View {
        Button(action: remove) {
            HStack(spacing: 6) {
                Image(systemName: "person.fill")
                    .font(.system(size: 8))
                    .foregroundStyle(Tokens.Palette.mutedForeground)
                    .frame(width: 16, height: 16)
                    .background(Tokens.Palette.muted, in: Circle())
                Text(email).font(.inter(.subheadline)).foregroundStyle(Tokens.Palette.foreground).lineLimit(1)
                Image(systemName: "xmark").font(.system(size: 9, weight: .semibold)).foregroundStyle(Tokens.Palette.mutedForeground)
            }
            .padding(.leading, Tokens.Spacing.xs)
            .padding(.trailing, 6)
            .frame(height: 28)
            .overlay(RoundedRectangle(cornerRadius: Tokens.Radius.medium).stroke(Tokens.Palette.border))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(MailStrings.composeRemoveRecipient(email: email))
    }

    private func recipientRow<Trailing: View>(
        _ field: Field,
        label: String,
        chips: Binding<[String]>,
        typed: Binding<String>,
        invalid: Bool,
        @ViewBuilder trailing: () -> Trailing
    ) -> some View {
        fieldRow(label, invalid: invalid) {
            FlowLayout(spacing: Tokens.Spacing.xs) {
                ForEach(Array(chips.wrappedValue.enumerated()), id: \.offset) { index, email in
                    recipientToken(email) {
                        if index < chips.wrappedValue.count { chips.wrappedValue.remove(at: index) }
                    }
                }
                TextField("", text: typed)
                    .font(.inter(.subheadline))
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .textContentType(.emailAddress)
                    .submitLabel(.next)
                    .focused($focus, equals: field)
                    .frame(minWidth: 120, minHeight: 28)
                    .onSubmit { commit(typed: typed, chips: chips) }
                    .onChange(of: typed.wrappedValue) { _, value in
                        if let committed = MailLogic.committedAddress(value) {
                            chips.wrappedValue.append(committed)
                            typed.wrappedValue = ""
                        }
                    }
                    .accessibilityIdentifier("compose-\(fieldName(field))")
            }
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            trailing()
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
                Hairline()
                ForEach(suggestions.filter { !($0.email ?? "").isEmpty }) { person in
                    let email = person.email ?? ""
                    Button {
                        choose(email, for: field)
                    } label: {
                        HStack(spacing: Tokens.Spacing.m) {
                            MailAvatar(name: person.name ?? email)
                            VStack(alignment: .leading, spacing: 0) {
                                Text(person.name ?? email).font(.inter(.subheadline, weight: .medium)).lineLimit(1).foregroundStyle(Tokens.Palette.foreground)
                                if person.name != nil {
                                    Text(email).font(.inter(.caption)).foregroundStyle(Tokens.Palette.mutedForeground).lineLimit(1)
                                }
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
                    HStack(spacing: Tokens.Spacing.m) {
                        Image(systemName: "plus").foregroundStyle(Tokens.Palette.mutedForeground)
                        Text(MailStrings.composeAddContact(email: text)).font(.inter(.subheadline)).foregroundStyle(Tokens.Palette.foreground)
                        Spacer()
                    }
                    .padding(.horizontal, Tokens.Spacing.l)
                    .padding(.vertical, 10)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("compose-add-typed")
                Hairline()
            }
            .accessibilityIdentifier("compose-suggestions")
        }
    }

    private var details: some View {
        VStack(alignment: .leading, spacing: 0) {
            fieldRow(MailStrings.composeSubject) {
                TextField("", text: $subject)
                    .font(.inter(.subheadline))
                    .focused($focus, equals: .subject)
                    .accessibilityIdentifier("compose-subject")
            }
            if let scheduledAt {
                HStack(spacing: 6) {
                    Image(systemName: "clock").font(.system(size: 12))
                    Text(MailStrings.sendLaterScheduledFor(time: momentText(scheduledAt))).font(.inter(.caption))
                    Button {
                        self.scheduledAt = nil
                    } label: {
                        Image(systemName: "xmark").font(.system(size: 10, weight: .semibold)).frame(width: 28, height: 28)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(MailStrings.sendLaterClear)
                }
                .foregroundStyle(Tokens.Palette.mutedForeground)
                .padding(.horizontal, Tokens.Spacing.l)
                .accessibilityIdentifier("compose-scheduled")
            }
            if !files.isEmpty {
                // The platform's attachments box: a muted panel with the count and each file.
                VStack(alignment: .leading, spacing: Tokens.Spacing.s) {
                    Label(MailStrings.messageAttachments(files.count), systemImage: "paperclip")
                        .font(.inter(.subheadline, weight: .medium))
                    FlowLayout(spacing: Tokens.Spacing.s) {
                        ForEach(files) { file in
                            Button {
                                files.removeAll { $0.id == file.id }
                            } label: {
                                HStack(spacing: 6) {
                                    Text(file.name).font(.inter(.caption)).lineLimit(1).frame(maxWidth: 180)
                                    Image(systemName: "xmark").font(.system(size: 9, weight: .semibold)).foregroundStyle(Tokens.Palette.mutedForeground)
                                }
                                .foregroundStyle(Tokens.Palette.foreground)
                                .padding(.horizontal, Tokens.Spacing.s)
                                .frame(height: 30)
                                .background(Tokens.Palette.background, in: RoundedRectangle(cornerRadius: Tokens.Radius.medium))
                                .overlay(RoundedRectangle(cornerRadius: Tokens.Radius.medium).stroke(Tokens.Palette.border))
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(MailStrings.composeRemoveAttachment(name: file.name))
                        }
                    }
                }
                .padding(Tokens.Spacing.m)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Tokens.Palette.muted.opacity(0.5), in: RoundedRectangle(cornerRadius: Tokens.Radius.large))
                .overlay(RoundedRectangle(cornerRadius: Tokens.Radius.large).stroke(Tokens.Palette.border))
                .padding(.horizontal, Tokens.Spacing.l)
                .padding(.vertical, Tokens.Spacing.s)
            }
            RichEditor(model: editor, placeholder: MailStrings.composeBodyPlaceholder, dark: colorScheme == .dark)
                .frame(minHeight: 260)
                .padding(.horizontal, Tokens.Spacing.l)
                .padding(.top, Tokens.Spacing.s)
                .accessibilityIdentifier("compose-body")
            if prefill.mode != .new && !prefill.quotedBody.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                VStack(alignment: .leading, spacing: Tokens.Spacing.s) {
                    // The platform's "···" toggle for the quoted text.
                    Button {
                        showQuote.toggle()
                    } label: {
                        Image(systemName: "ellipsis")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(Tokens.Palette.mutedForeground)
                            .frame(width: 32, height: 20)
                            .background(Tokens.Palette.muted, in: RoundedRectangle(cornerRadius: Tokens.Radius.medium))
                            .overlay(RoundedRectangle(cornerRadius: Tokens.Radius.medium).stroke(Tokens.Palette.border))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(MailStrings.composeShowQuoted)
                    .accessibilityIdentifier("compose-show-quote")
                    if showQuote {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("---------- \(quoteLabel) ---------").font(.inter(.caption)).foregroundStyle(Tokens.Palette.mutedForeground)
                            Text(quoteFrom).font(.inter(.caption)).foregroundStyle(Tokens.Palette.mutedForeground)
                            Text(MailStrings.composeQuotedDate(date: fullTime(prefill.quotedDate))).font(.inter(.caption)).foregroundStyle(Tokens.Palette.mutedForeground)
                            Text(quoteSubject).font(.inter(.caption)).foregroundStyle(Tokens.Palette.mutedForeground)
                            Text(prefill.quotedBody).font(.inter(.subheadline)).padding(.top, Tokens.Spacing.s)
                        }
                        .padding(Tokens.Spacing.m)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .overlay(RoundedRectangle(cornerRadius: Tokens.Radius.medium).stroke(Tokens.Palette.border))
                    }
                }
                .padding(.horizontal, Tokens.Spacing.l)
                .padding(.vertical, Tokens.Spacing.s)
            }
        }
    }

    /// The platform's compose footer: the tools on the left, Send (or Schedule at the chosen time) on the right.
    private var formatBar: some View {
        VStack(spacing: 0) {
            Hairline()
            if formatting {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 2) {
                        formatButton("bold", on: editor.bold, label: MailStrings.composeBold, command: "bold")
                        formatButton("italic", on: editor.italic, label: MailStrings.composeItalic, command: "italic")
                        formatButton("underline", on: editor.underline, label: MailStrings.composeUnderline, command: "underline")
                        formatButton("list.bullet", on: editor.bullets, label: MailStrings.composeBulletList, command: "insertUnorderedList")
                        formatButton("list.number", on: editor.numbers, label: MailStrings.composeNumberedList, command: "insertOrderedList")
                    }
                    .padding(Tokens.Spacing.xs)
                    .background(Tokens.Palette.muted.opacity(0.6), in: RoundedRectangle(cornerRadius: Tokens.Radius.large))
                }
                .padding(.horizontal, Tokens.Spacing.m)
                .padding(.top, Tokens.Spacing.s)
            }
            HStack(spacing: 2) {
                toolButton("textformat", label: MailStrings.composeFormatting, on: formatting) { formatting.toggle() }
                    .accessibilityIdentifier("compose-formatting")
                Menu {
                    Button { pickingPhotos = true } label: { Label(MailStrings.composePhotoLibrary, systemImage: "photo.on.rectangle") }
                    if UIImagePickerController.isSourceTypeAvailable(.camera) {
                        Button { takingPhoto = true } label: { Label(MailStrings.composeTakePhoto, systemImage: "camera") }
                    }
                    Button { importingFiles = true } label: { Label(MailStrings.composeChooseFile, systemImage: "folder") }
                } label: {
                    toolIcon("paperclip", on: false)
                }
                .disabled(sending)
                .accessibilityLabel(MailStrings.composeAddAttachment)
                .accessibilityIdentifier("compose-attach")
                toolButton("clock", label: MailStrings.composeSchedule, on: scheduledAt != nil) { openSchedule() }
                    .disabled(sending)
                    .accessibilityIdentifier("compose-schedule")
                if env.isAvailable("mail-ai") {
                    toolButton("sparkles", label: MailStrings.composeAi, on: false) { notifier.show(MailStrings.composeAiUnavailable) }
                }
                Spacer(minLength: Tokens.Spacing.s)
                Button {
                    submit(at: scheduledAt)
                } label: {
                    HStack(spacing: Tokens.Spacing.s) {
                        if sending { ProgressView().controlSize(.small).tint(Tokens.Palette.primaryForeground) }
                        Text(scheduledAt.map { MailStrings.composeScheduleFor(time: momentText($0)) } ?? MailStrings.composeSend)
                            .font(.inter(.subheadline, weight: .medium))
                            .lineLimit(1)
                    }
                    .foregroundStyle(Tokens.Palette.primaryForeground)
                    .padding(.horizontal, Tokens.Spacing.m)
                    .frame(height: 36)
                    .background(Tokens.Palette.primary, in: RoundedRectangle(cornerRadius: Tokens.Radius.medium))
                }
                .buttonStyle(.plain)
                .disabled(sending)
                .accessibilityIdentifier("compose-send")
            }
            .padding(.horizontal, Tokens.Spacing.m)
            .padding(.vertical, Tokens.Spacing.s)
        }
        .background(Tokens.Palette.background)
    }

    /// A footer tool, as the platform's: a muted icon, on a muted square while its panel or setting is on.
    private func toolIcon(_ symbol: String, on: Bool) -> some View {
        Image(systemName: symbol)
            .font(.system(size: 16))
            .foregroundStyle(on ? Tokens.Palette.foreground : Tokens.Palette.mutedForeground)
            .frame(width: 36, height: 36)
            .background(on ? Tokens.Palette.muted : Color.clear, in: RoundedRectangle(cornerRadius: Tokens.Radius.medium))
            .contentShape(Rectangle())
    }

    private func toolButton(_ symbol: String, label: String, on: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            toolIcon(symbol, on: on)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    private func formatButton(_ symbol: String, on: Bool, label: String, command: String) -> some View {
        Button {
            editor.format(command)
        } label: {
            Image(systemName: symbol)
                .font(.system(size: 15))
                .foregroundStyle(on ? Tokens.Palette.foreground : Tokens.Palette.mutedForeground)
                .frame(width: 36, height: 32)
                .background(on ? Tokens.Palette.background : Color.clear, in: RoundedRectangle(cornerRadius: Tokens.Radius.medium))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    // MARK: Actions

    private func openSchedule() {
        if from == nil {
            alert = AlertContent(title: MailStrings.composeSendFailedTitle, message: MailStrings.composeNoAccount)
        } else if !hasRecipient {
            recipientMissing = true
        } else {
            choosingTime = true
        }
    }

    /// The time sheet closed: set the time, or open the date picker.
    private func afterTimeSheet() {
        if let at = chosenTime {
            chosenTime = nil
            scheduledAt = at
        }
        if wantsPicker {
            wantsPicker = false
            pickingDate = true
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
