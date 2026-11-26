import SwiftUI
import WeldCore
import WeldUI

/// What a form is for: a new item of a type (in a vault, when one is chosen
/// already) or an edit of an existing item.
enum ItemFormMode: Hashable, Identifiable {
    case new(PassItem.Kind, vaultID: String?)
    case edit(vaultID: String, itemID: String)

    var id: String {
        switch self {
        case let .new(kind, vaultID): "new-\(kind)-\(vaultID ?? "")"
        case let .edit(vaultID, itemID): "edit-\(vaultID)-\(itemID)"
        }
    }
}

/// "New item": a login, a secure note or a card.
struct NewItemMenu: View {
    let onChoose: (PassItem.Kind) -> Void

    var body: some View {
        Menu {
            ForEach([PassItem.Kind.login, .note, .card], id: \.self) { kind in
                Button(typeLabel(kind)) { onChoose(kind) }
                    .accessibilityIdentifier("new-\(kind)")
            }
        } label: {
            Image(systemName: "plus")
        }
        .accessibilityLabel(PassStrings.itemsAdd)
        .accessibilityIdentifier("add-item")
    }
}

/// The item form, in a sheet. Editing starts with a reveal, which asks for
/// Face ID and is audited, to fill in the secret fields; saving sends the
/// whole item.
struct ItemFormView: View {
    let env: AppEnvironment
    let store: PassStore
    let mode: ItemFormMode

    @Environment(\.dismiss) private var dismiss
    @Environment(ToastCenter.self) private var toast
    @State private var values: ItemFormValues?
    @State private var problem: String?
    @State private var saving = false

    var body: some View {
        NavigationStack {
            Group {
                if let problem {
                    ContentUnavailableView(problem, systemImage: "exclamationmark.triangle")
                } else if values != nil {
                    form
                } else {
                    ProgressView()
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(PassStrings.commonCancel) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? PassStrings.commonSaving : PassStrings.commonSave) { save() }
                        .disabled(saving || values == nil)
                        .accessibilityIdentifier("form-save")
                }
            }
        }
        .preventsScreenCapture()
        .task { await load() }
    }

    private var title: String {
        switch mode {
        case .edit: PassStrings.formEditTitle
        case .new(.login, _): PassStrings.formNewTitleLogin
        case .new(.note, _): PassStrings.formNewTitleNote
        case .new(.card, _): PassStrings.formNewTitleCard
        }
    }

    private var writableVaults: [PassVault] {
        (store.vaults.data ?? []).filter { PassLogic.canEdit($0) }
    }

    @ViewBuilder private var form: some View {
        if let binding = Binding($values) {
            ItemFormFields(
                values: binding,
                vaults: { if case .new = mode { return writableVaults } else { return [] } }(),
                showErrors: showErrors
            )
        }
    }

    @State private var showErrors = false

    private func load() async {
        guard values == nil else { return }
        switch mode {
        case let .new(kind, vaultID):
            guard let target = PassLogic.defaultCreateVaultID(store.vaults.data ?? [], selected: vaultID) else {
                problem = PassStrings.formNoWritableVault
                return
            }
            values = ItemFormValues(kind: kind, vaultID: target)
        case let .edit(vaultID, itemID):
            guard let item = store.items.data?.first(where: { $0.id == itemID }) else { return dismiss() }
            guard await env.lock.confirm(reason: PassStrings.lockEditPrompt) else { return dismiss() }
            do {
                values = ItemFormValues(item: item, fields: try await store.reveal(vaultID: vaultID, itemID: itemID))
            } catch {
                problem = passErrorMessage(error as? APIError)
            }
        }
    }

    private func save() {
        guard var current = values else { return }
        current.apps = current.kind == .login ? PassForms.parseAppList(current.apps.joined(separator: "\n")) : []
        values = current
        showErrors = true
        guard !current.title.trimmingCharacters(in: .whitespaces).isEmpty,
              PassForms.invalidApps(current.apps).isEmpty
        else { return }
        saving = true
        Task {
            defer { saving = false }
            do {
                let input = PassForms.input(from: current)
                switch mode {
                case .new:
                    try await store.create(vaultID: current.vaultID, input: input)
                    toast.show(PassStrings.formCreated)
                case let .edit(vaultID, itemID):
                    try await store.update(vaultID: vaultID, itemID: itemID, input: input)
                    toast.show(PassStrings.formSaved)
                }
                dismiss()
            } catch {
                toast.show(passErrorMessage(error as? APIError))
            }
        }
    }
}

/// The fields of the item form, per type.
private struct ItemFormFields: View {
    @Binding var values: ItemFormValues
    let vaults: [PassVault]
    let showErrors: Bool

    @State private var showPassword = false
    @State private var appsText = ""

    var body: some View {
        Form {
            if vaults.count > 1 {
                Picker(PassStrings.formVault, selection: $values.vaultID) {
                    ForEach(vaults) { vault in Text(vaultLabel(vault)).tag(vault.id) }
                }
            }
            Section {
                TextField(PassStrings.formTitle, text: $values.title, prompt: Text(PassStrings.formTitlePlaceholder))
                    .accessibilityIdentifier("form-title")
                if showErrors, values.title.trimmingCharacters(in: .whitespaces).isEmpty {
                    Text(PassStrings.formTitleRequired).font(.footnote).foregroundStyle(.red)
                }
            } header: {
                Text(PassStrings.formTitle)
            }
            switch values.kind {
            case .note:
                Section(PassStrings.formContent) {
                    TextEditor(text: $values.content)
                        .frame(minHeight: 160)
                        .accessibilityIdentifier("form-content")
                }
            case .card:
                Section {
                    TextField(PassStrings.formCardholder, text: $values.cardholder)
                        .textContentType(.creditCardName)
                    TextField(PassStrings.formNumber, text: $values.number)
                        .keyboardType(.numberPad)
                        .textContentType(.creditCardNumber)
                    TextField(PassStrings.formExpiry, text: $values.expiry)
                    TextField(PassStrings.formCvc, text: $values.cvc)
                        .keyboardType(.numberPad)
                }
                Section(PassStrings.formNotes) {
                    TextEditor(text: $values.notes).frame(minHeight: 80)
                }
            case .login:
                loginFields
            }
        }
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .onAppear { appsText = values.apps.joined(separator: "\n") }
        .onChange(of: appsText) { _, text in values.apps = PassForms.parseAppList(text) }
    }

    @ViewBuilder private var loginFields: some View {
        Section {
            TextField(PassStrings.formUrl, text: $values.url, prompt: Text(PassStrings.formUrlPlaceholder))
                .keyboardType(.URL)
                .accessibilityIdentifier("form-url")
            TextField(PassStrings.formUsername, text: $values.username)
                .textContentType(.username)
                .accessibilityIdentifier("form-username")
            HStack {
                Group {
                    if showPassword {
                        TextField(PassStrings.formPassword, text: $values.password)
                    } else {
                        SecureField(PassStrings.formPassword, text: $values.password)
                    }
                }
                .font(.body.monospaced())
                .accessibilityIdentifier("form-password")
                Button {
                    showPassword.toggle()
                } label: {
                    Image(systemName: showPassword ? "eye.slash" : "eye")
                }
                .buttonStyle(.borderless)
                .accessibilityLabel(showPassword ? PassStrings.itemHide : PassStrings.itemShow)
            }
            StrengthMeter(password: values.password)
            Button {
                values.password = PassForms.generatePassword()
                showPassword = true
            } label: {
                Label(PassStrings.formGenerate, systemImage: "wand.and.stars")
            }
            .accessibilityIdentifier("form-generate")
        }
        Section {
            SecureField(PassStrings.formTotp, text: $values.totp)
        } footer: {
            Text(PassStrings.formTotpHelp)
        }
        Section(PassStrings.formNotes) {
            TextEditor(text: $values.notes).frame(minHeight: 80)
        }
        Section {
            TextEditor(text: $appsText).frame(minHeight: 60)
        } header: {
            Text(PassStrings.formApps)
        } footer: {
            let wrong = PassForms.invalidApps(values.apps)
            if showErrors, !wrong.isEmpty {
                Text(PassStrings.formAppsInvalid(apps: wrong.joined(separator: ", "))).foregroundStyle(.red)
            } else {
                Text(PassStrings.formAppsHelp)
            }
        }
    }
}

/// How strong a password is: a bar and a word, the platform's thresholds.
struct StrengthMeter: View {
    let password: String

    var body: some View {
        if !password.isEmpty {
            let strength = PassForms.strength(password)
            let bits = Int(PassForms.entropyBits(password))
            let (color, label, fraction): (Color, String, Double) = switch strength {
            case .weak: (Tokens.Status.danger, PassStrings.strengthWeak, 0.33)
            case .fair: (Tokens.Status.warning, PassStrings.strengthFair, 0.66)
            case .strong: (Tokens.Status.success, PassStrings.strengthStrong, 1)
            }
            VStack(alignment: .leading, spacing: 4) {
                ProgressView(value: fraction).tint(color)
                HStack {
                    Text("\(PassStrings.strengthLabel): \(label)").foregroundStyle(color)
                    Spacer()
                    Text(PassStrings.strengthBits(bits: bits)).foregroundStyle(.secondary)
                }
                .font(.caption)
            }
        }
    }
}
