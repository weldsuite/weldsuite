import SwiftUI
import WeldCore
import WeldUI

/// What a form is for: a new item (of the type it starts on, in a vault when
/// one is chosen already) or an edit of an existing item.
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

/// The item form, in a sheet, as the platform's "Add item" and "Edit"
/// dialogs: a new item's type is picked in the form. Editing starts with a
/// reveal, which asks for Face ID and is audited, to fill in the secret
/// fields; saving sends the whole item.
struct ItemFormView: View {
    let env: AppEnvironment
    let store: PassStore
    let mode: ItemFormMode

    @Environment(\.dismiss) private var dismiss
    @Environment(ToastCenter.self) private var toast
    @State private var values: ItemFormValues?
    @State private var problem: String?
    @State private var saving = false
    @State private var showErrors = false

    var body: some View {
        NavigationStack {
            Group {
                if let problem {
                    EmptyMessage(systemImage: "exclamationmark.triangle", title: problem)
                } else if values != nil {
                    form
                } else {
                    ProgressView()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Tokens.Palette.background)
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

    private var editing: Bool {
        if case .edit = mode { return true }
        return false
    }

    private var title: String {
        switch mode {
        case let .edit(_, itemID):
            PassStrings.formEditTitle(title: store.items.data?.first { $0.id == itemID }?.title ?? "")
        case .new:
            PassStrings.formAddTitle
        }
    }

    private var writableVaults: [PassVault] {
        PassLogic.sortVaults((store.vaults.data ?? []).filter { PassLogic.canEdit($0) })
    }

    @ViewBuilder private var form: some View {
        if let binding = Binding($values) {
            ItemFormFields(
                values: binding,
                editing: editing,
                vaults: editing ? [] : writableVaults,
                showErrors: showErrors
            )
        }
    }

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

/// The fields of the item form, per type, in the platform's order and with
/// its labels.
private struct ItemFormFields: View {
    @Binding var values: ItemFormValues
    let editing: Bool
    let vaults: [PassVault]
    let showErrors: Bool

    @State private var showPassword = false
    @State private var generating = false
    @State private var appsText = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Tokens.Spacing.l) {
                Text(editing ? PassStrings.formEditDescription : PassStrings.formAddDescription)
                    .font(.inter(.subheadline))
                    .foregroundStyle(Tokens.Palette.mutedForeground)

                if editing {
                    // The type is fixed once the item exists.
                    HStack(spacing: Tokens.Spacing.s) {
                        NeutralBadge(typeLabel(values.kind))
                        Text(PassStrings.formTypeLocked)
                            .font(.inter(.caption))
                            .foregroundStyle(Tokens.Palette.mutedForeground)
                    }
                } else {
                    LabeledField(label: PassStrings.formType) {
                        TypePicker(selection: $values.kind)
                    }
                }

                if !editing, !vaults.isEmpty {
                    let selected = vaults.first { $0.id == values.vaultID }
                    LabeledField(
                        label: PassStrings.formVault,
                        hint: selected?.kind == .shared ? PassStrings.formSharedVaultHint : nil
                    ) {
                        VaultSelect(vaults: vaults, selection: $values.vaultID)
                    }
                }

                LabeledField(label: PassStrings.formTitle, error: titleMissing ? PassStrings.formTitleRequired : nil) {
                    PlatformTextField(text: $values.title, isError: titleMissing)
                        .accessibilityIdentifier("form-title")
                }

                switch values.kind {
                case .login: loginFields
                case .note:
                    LabeledField(label: PassStrings.formContent) {
                        PlatformTextField(text: $values.content, lines: 8)
                            .accessibilityIdentifier("form-content")
                    }
                case .card: cardFields
                }
            }
            .padding(Tokens.Spacing.l)
        }
        .scrollDismissesKeyboard(.interactively)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .onAppear { appsText = values.apps.joined(separator: "\n") }
        .onChange(of: appsText) { _, text in values.apps = PassForms.parseAppList(text) }
    }

    private var titleMissing: Bool {
        showErrors && values.title.trimmingCharacters(in: .whitespaces).isEmpty
    }

    @ViewBuilder private var loginFields: some View {
        LabeledField(label: PassStrings.formUrl) {
            PlatformTextField(text: $values.url, placeholder: PassStrings.formUrlPlaceholder)
                .keyboardType(.URL)
                .accessibilityIdentifier("form-url")
        }
        LabeledField(label: PassStrings.formUsername) {
            PlatformTextField(text: $values.username)
                .textContentType(.username)
                .accessibilityIdentifier("form-username")
        }
        LabeledField(label: PassStrings.formPassword) {
            HStack(spacing: Tokens.Spacing.s) {
                PlatformTextField(text: $values.password, secure: !showPassword, monospaced: true)
                    .accessibilityIdentifier("form-password")
                Button {
                    showPassword.toggle()
                } label: {
                    Image(systemName: showPassword ? "eye.slash" : "eye").font(.system(size: 14))
                }
                .buttonStyle(.platformOutline)
                .accessibilityLabel(showPassword ? PassStrings.itemHide : PassStrings.itemShow)
                .accessibilityIdentifier("form-password-toggle")
                Button {
                    generating.toggle()
                } label: {
                    Label(PassStrings.formGenerate, systemImage: "wand.and.stars")
                }
                .buttonStyle(.platformOutline)
                .accessibilityIdentifier("form-generate")
            }
            StrengthMeter(password: values.password)
        }
        if generating {
            GeneratorPanel(
                onUse: { generated in
                    values.password = generated
                    showPassword = true
                    generating = false
                },
                onCancel: { generating = false }
            )
        }
        LabeledField(label: PassStrings.formTotp, hint: PassStrings.formTotpHelp) {
            PlatformTextField(text: $values.totp, placeholder: PassStrings.formTotpPlaceholder, secure: true, monospaced: true)
                .accessibilityIdentifier("form-totp")
        }
        notesField
        LabeledField(label: PassStrings.formApps, hint: PassStrings.formAppsHelp, error: appsError) {
            PlatformTextField(text: $appsText, lines: 2, isError: appsError != nil)
                .accessibilityIdentifier("form-apps")
        }
    }

    @ViewBuilder private var cardFields: some View {
        LabeledField(label: PassStrings.formCardholder) {
            PlatformTextField(text: $values.cardholder)
                .textContentType(.creditCardName)
        }
        LabeledField(label: PassStrings.formNumber) {
            PlatformTextField(text: $values.number, monospaced: true)
                .keyboardType(.numberPad)
                .textContentType(.creditCardNumber)
        }
        HStack(alignment: .top, spacing: Tokens.Spacing.m) {
            LabeledField(label: PassStrings.formExpiry) {
                PlatformTextField(text: $values.expiry, placeholder: PassStrings.formExpiryPlaceholder, monospaced: true)
            }
            LabeledField(label: PassStrings.formCvc) {
                PlatformTextField(text: $values.cvc, monospaced: true)
                    .keyboardType(.numberPad)
            }
        }
        notesField
    }

    private var notesField: some View {
        LabeledField(label: PassStrings.formNotes) {
            PlatformTextField(text: $values.notes, lines: 3)
                .accessibilityIdentifier("form-notes")
        }
    }

    private var appsError: String? {
        let wrong = PassForms.invalidApps(values.apps)
        guard showErrors, !wrong.isEmpty else { return nil }
        return PassStrings.formAppsInvalid(apps: wrong.joined(separator: ", "))
    }
}

/// Login, secure note or card, as the platform's three bordered choices: the
/// chosen one outlined in the primary colour on a light wash of it.
private struct TypePicker: View {
    @Binding var selection: PassItem.Kind

    var body: some View {
        HStack(spacing: Tokens.Spacing.s) {
            ForEach([PassItem.Kind.login, .note, .card], id: \.self) { kind in
                let chosen = kind == selection
                Button {
                    selection = kind
                } label: {
                    VStack(spacing: Tokens.Spacing.xs) {
                        Image(systemName: typeSymbol(kind)).font(.system(size: 15))
                        Text(typeLabel(kind))
                            .font(.inter(.subheadline, weight: chosen ? .medium : .regular))
                            .multilineTextAlignment(.center)
                            .lineLimit(2)
                    }
                    .foregroundStyle(chosen ? Tokens.Palette.foreground : Tokens.Palette.mutedForeground)
                    .padding(.horizontal, Tokens.Spacing.xs)
                    .padding(.vertical, Tokens.Spacing.s)
                    .frame(maxWidth: .infinity, minHeight: 56)
                    .background(
                        chosen ? Tokens.Palette.primary.opacity(0.05) : Tokens.Palette.background,
                        in: RoundedRectangle(cornerRadius: Tokens.Radius.medium)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: Tokens.Radius.medium)
                            .stroke(chosen ? Tokens.Palette.primary : Tokens.Palette.border, lineWidth: 1)
                    )
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(chosen ? .isSelected : [])
                .accessibilityIdentifier("new-\(kind)")
            }
        }
    }
}

/// The vault to add to, as the platform's select: the chosen vault and a chevron, opening a menu.
private struct VaultSelect: View {
    let vaults: [PassVault]
    @Binding var selection: String

    var body: some View {
        Menu {
            ForEach(vaults) { vault in
                Button(vaultLabel(vault)) { selection = vault.id }
            }
        } label: {
            HStack {
                Text(vaults.first { $0.id == selection }.map(vaultLabel) ?? "")
                    .font(.inter(.subheadline))
                    .foregroundStyle(Tokens.Palette.foreground)
                    .lineLimit(1)
                Spacer()
                Image(systemName: "chevron.down")
                    .font(.system(size: 12))
                    .foregroundStyle(Tokens.Palette.mutedForeground)
            }
            .modifier(InputBox())
        }
        .accessibilityIdentifier("form-vault")
    }
}
