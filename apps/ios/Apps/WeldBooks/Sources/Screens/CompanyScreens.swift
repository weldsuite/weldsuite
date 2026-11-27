import SwiftUI
import UIKit
import WeldCore
import WeldUI

// The companies (accounting entities): the door of a workspace without one,
// the administration switcher, setting one up, editing it, and Settings
// (Android `ui/CompanyScreens.kt`).

/// The words for a legal form (`single_member_llc`, `ltda`, …), or the code itself.
private func entityTypeLabel(_ type: String) -> String {
    switch type {
    case "sole_proprietorship": return BooksStrings.entitySetupEntityTypesSoleProprietorship
    case "single_member_llc": return BooksStrings.entitySetupEntityTypesSingleMemberLlc
    case "multi_member_llc": return BooksStrings.entitySetupEntityTypesMultiMemberLlc
    case "partnership": return BooksStrings.entitySetupEntityTypesPartnership
    case "s_corp": return BooksStrings.entitySetupEntityTypesSCorp
    case "c_corp": return BooksStrings.entitySetupEntityTypesCCorp
    case "nonprofit": return BooksStrings.entitySetupEntityTypesNonprofit
    case "mei": return BooksStrings.entitySetupEntityTypesMei
    case "ei": return BooksStrings.entitySetupEntityTypesEi
    case "slu": return BooksStrings.entitySetupEntityTypesSlu
    case "ltda": return BooksStrings.entitySetupEntityTypesLtda
    case "sa": return BooksStrings.entitySetupEntityTypesSa
    default: return type
    }
}

/// The words for a tax classification or regime, or the code itself.
private func taxClassificationLabel(_ value: String) -> String {
    switch value {
    case "disregarded": return BooksStrings.entitySetupTaxClassificationsDisregarded
    case "sole_proprietor": return BooksStrings.entitySetupTaxClassificationsSoleProprietor
    case "partnership": return BooksStrings.entitySetupTaxClassificationsPartnership
    case "s_corp": return BooksStrings.entitySetupTaxClassificationsSCorp
    case "c_corp": return BooksStrings.entitySetupTaxClassificationsCCorp
    case "exempt": return BooksStrings.entitySetupTaxClassificationsExempt
    case "mei": return BooksStrings.entitySetupTaxClassificationsMei
    case "simples_nacional": return BooksStrings.entitySetupTaxClassificationsSimplesNacional
    case "lucro_presumido": return BooksStrings.entitySetupTaxClassificationsLucroPresumido
    case "lucro_real": return BooksStrings.entitySetupTaxClassificationsLucroReal
    default: return value
    }
}

/// A company field's problem (`CompanyProblems`) in words.
private func companyProblemText(_ problem: String?) -> String? {
    guard let problem else { return nil }
    switch problem {
    case "einFormat": return BooksStrings.entitySetupEinFormat
    case "einPrefix": return BooksStrings.entitySetupEinPrefix
    case "cnpjFormat": return BooksStrings.entitySetupCnpjFormat
    case "cnpjCheckDigits": return BooksStrings.entitySetupCnpjCheckDigits
    case "btwFormat": return BooksStrings.companyBtwFormat
    case "kvkFormat": return BooksStrings.companyKvkFormat
    case "ibanChecksum": return BooksStrings.companyIbanChecksum
    default: return BooksStrings.companyIbanFormat
    }
}

private func registrationPlaceholder(_ registrationId: String) -> String {
    switch registrationId {
    case "kvk": return BooksStrings.companyRegistrationPlaceholderKvk
    case "pan": return BooksStrings.companyRegistrationPlaceholderPan
    case "state_id": return BooksStrings.companyRegistrationPlaceholderStateId
    case "ie": return BooksStrings.companyRegistrationPlaceholderIe
    default: return BooksStrings.companyRegistrationPlaceholderCompanyNumber
    }
}

/// "NL · EUR · Acme Holding B.V."
private func entityMeta(_ entity: Entity) -> String {
    var parts = [entity.jurisdictionCode, entity.baseCurrency]
    if let legal = entity.legalName, !legal.isBlank, legal != entity.name { parts.append(legal) }
    return parts.joined(separator: " · ")
}

// MARK: - Company fields

/// The company's tax ID, bank details and address: what an invoice can't be
/// finalised without. Shared by the setup and the edit sheet, as two `Form`
/// sections. A field the country makes mandatory on invoices says so underneath.
private struct CompanyFields: View {
    let code: String
    @Binding var draft: CompanyDraft
    let problems: CompanyProblems
    let usProblems: UsAddressProblems
    let requiredFields: [String]
    let labels: Labels
    let terminology: Terminology
    let taxIdLabel: String
    let idHeader: String?
    let idFooter: String?

    private var isUs: Bool { code == "US" }
    private var needed: String { BooksStrings.companyNeededForInvoices }
    private var taxIdError: String? { companyProblemText(problems.taxId) }
    private var registrationError: String? { companyProblemText(problems.registrationNumber) }
    private var ibanError: String? { companyProblemText(problems.iban) }

    private var taxIdHelper: String? {
        if taxIdError != nil { return nil }
        if code == "US" { return BooksStrings.entitySetupEinHint }
        if code == "BR" { return BooksStrings.entitySetupCnpjHint }
        return requiredFields.contains("vatNumber") ? needed : nil
    }

    private var addressHint: String {
        let hint = isUs ? BooksStrings.entitySetupAddressHint : BooksStrings.entitySetupAddressHintInvoice
        return !isUs && requiredFields.contains("address") ? "\(hint) \(needed)." : hint
    }

    private var taxIdText: Binding<String> {
        Binding(get: { draft.taxId }, set: { draft.taxId = CompanyForm.formatTaxIdInput(code, $0) })
    }

    private var ibanText: Binding<String> {
        Binding(get: { draft.iban }, set: { draft.iban = Identifiers.formatIbanInput($0) })
    }

    private var bicText: Binding<String> {
        Binding(get: { draft.bic }, set: { draft.bic = $0.uppercased() })
    }

    var body: some View {
        Section {
            FormField(
                taxIdLabel,
                text: taxIdText,
                placeholder: labels.taxIdPlaceholder,
                error: taxIdError,
                helper: taxIdHelper,
                keyboard: isUs ? .numberPad : .default,
                tag: "company-tax-id"
            )
            if requiredFields.contains("registrationNumber") {
                FormField(
                    labels.registrationId,
                    text: $draft.registrationNumber,
                    placeholder: registrationPlaceholder(terminology.registrationId),
                    error: registrationError,
                    helper: registrationError == nil ? needed : nil,
                    tag: "company-registration"
                )
            }
            if requiredFields.contains("iban") {
                FormField(
                    BooksStrings.companyIban,
                    text: ibanText,
                    placeholder: BooksStrings.companyIbanPlaceholder,
                    error: ibanError,
                    helper: ibanError == nil ? needed : nil,
                    tag: "company-iban"
                )
                FormField(BooksStrings.companyBic, text: bicText, placeholder: BooksStrings.companyBicPlaceholder, tag: "company-bic")
            }
        } header: {
            if let idHeader { Text(idHeader) }
        } footer: {
            if let idFooter { Text(idFooter) }
        }
        Section {
            if isUs {
                AddressFields(value: $draft.address, problems: usProblems)
            } else {
                FormField(
                    BooksStrings.addressLine1,
                    text: $draft.address.line1,
                    placeholder: BooksStrings.addressLine1Placeholder,
                    error: problems.line1 ? BooksStrings.companyLine1Required : nil,
                    tag: "company-line1"
                )
                HStack(alignment: .top, spacing: Tokens.Spacing.s) {
                    FormField(
                        BooksStrings.companyPostalCode,
                        text: $draft.address.postalCode,
                        placeholder: BooksStrings.companyPostalCodePlaceholder,
                        tag: "company-postal-code"
                    )
                    .frame(maxWidth: .infinity)
                    FormField(
                        BooksStrings.addressCity,
                        text: $draft.address.city,
                        error: problems.city ? BooksStrings.companyCityRequired : nil,
                        tag: "company-city"
                    )
                    .frame(maxWidth: .infinity)
                    .layoutPriority(1)
                }
            }
        } header: {
            Text(BooksStrings.entitySetupBusinessAddress)
        } footer: {
            Text(addressHint)
        }
    }
}

// MARK: - Setting up a company

/// A new company: the jurisdiction (it decides the chart of accounts, tax
/// rates and numbering, and can't change later), the name, the currency and,
/// per country, how it is organised and what its invoices need. Created with
/// the country's defaults seeded. Sheet content: it brings its own
/// `NavigationStack` and closes itself.
struct CreateEntitySheet: View {
    let additional: Bool
    let initialJurisdiction: String?
    let onCreated: (Entity) -> Void

    @Environment(Books.self) private var books
    @Environment(Toaster.self) private var toaster
    @Environment(\.dismiss) private var dismiss

    @State private var company = CompanyDraft()
    @State private var code: String
    /// Nil until chosen: the country's own currency.
    @State private var currency: String?
    @State private var entityType = "single_member_llc"
    @State private var classification = "disregarded"
    @State private var dba = ""
    @State private var brEntityType = "ltda"
    @State private var brRegime = "simples_nacional"
    @State private var submitting = false
    @State private var problems = CompanyProblems()
    @State private var usProblems = UsAddressProblems()

    init(additional: Bool = false, initialJurisdiction: String? = nil, onCreated: @escaping (Entity) -> Void) {
        self.additional = additional
        self.initialJurisdiction = initialJurisdiction
        self.onCreated = onCreated
        _code = State(initialValue: (initialJurisdiction ?? Jurisdictions.defaultCode()).uppercased())
    }

    private var loaded: [Jurisdiction]? { books.jurisdictions }

    private var choices: [Jurisdiction] {
        if let loaded, !loaded.isEmpty { return loaded }
        return Jurisdictions.builtIn
    }

    private var jurisdiction: Jurisdiction? { Jurisdictions.find(code, loaded) }
    private var isUs: Bool { Jurisdictions.isUs(code) }
    private var isBr: Bool { Jurisdictions.isBr(code) }
    private var terminology: Terminology { jurisdiction?.terminology ?? Terminology() }
    private var types: [UsEntityType] { UsRules.entityTypes(jurisdiction?.entityTypes) }
    private var classifications: [UsClassification] { types.first { $0.type == entityType }?.classifications ?? [] }
    private var chosenCurrency: String { currency ?? jurisdiction?.defaultCurrency ?? Jurisdictions.fallbackCurrency }

    private var jurisdictionChoices: [Choice] {
        choices.map { item in Choice(item.code.uppercased(), "\(item.name) (\(item.code.uppercased()))") }
    }

    private var typeChoices: [Choice] {
        types.map { type -> Choice in
            let label = entityTypeLabel(type.type)
            return Choice(type.type, label == type.type ? type.label : label)
        }
    }

    private var classificationChoices: [Choice] {
        classifications.map { option -> Choice in
            let label = taxClassificationLabel(option.value)
            let text = option.formLabel.isBlank ? label : BooksStrings.entitySetupClassificationOption(label: label, form: option.formLabel)
            return Choice(option.value, text)
        }
    }

    private static let currencyChoices: [Choice] = [
        Choice("EUR", BooksStrings.entitySetupCurrencyEur),
        Choice("GBP", BooksStrings.entitySetupCurrencyGbp),
        Choice("USD", BooksStrings.entitySetupCurrencyUsd),
        Choice("INR", BooksStrings.entitySetupCurrencyInr),
        Choice("BRL", BooksStrings.entitySetupCurrencyBrl),
    ]

    private var draft: Binding<CompanyDraft> {
        Binding(get: { company }, set: { change($0) })
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Dropdown(
                        BooksStrings.entitySetupJurisdiction,
                        value: code,
                        options: jurisdictionChoices,
                        tag: "company-jurisdiction"
                    ) { changeJurisdiction($0) }
                    FormField(
                        BooksStrings.entitySetupCompanyName,
                        text: draft.name,
                        placeholder: isUs ? BooksStrings.examplesCompanyUs : BooksStrings.entitySetupCompanyNamePlaceholder,
                        error: problems.name ? BooksStrings.entitySetupCompanyNameError : nil,
                        tag: "company-name"
                    )
                } footer: {
                    Text(BooksStrings.entitySetupHint)
                }
                if isUs { usSections }
                if isBr { brSection }
                Section {
                    Dropdown(
                        BooksStrings.entitySetupBaseCurrency,
                        value: chosenCurrency,
                        options: Self.currencyChoices,
                        tag: "company-currency"
                    ) { currency = $0 }
                }
                CompanyFields(
                    code: code,
                    draft: draft,
                    problems: problems,
                    usProblems: usProblems,
                    requiredFields: Jurisdictions.requiredInvoiceFields(code, loaded),
                    labels: terminologyLabels(terminology),
                    terminology: terminology,
                    taxIdLabel: BooksStrings.entitySetupTaxIdOptional(taxId: terminologyLabels(terminology).taxId),
                    idHeader: isUs ? nil : BooksStrings.entitySetupInvoiceDetails,
                    idFooter: isUs ? nil : BooksStrings.entitySetupInvoiceDetailsHint
                )
                Section {
                    Button(action: create) {
                        Text(BooksStrings.entitySetupCreateCompany).frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(submitting)
                    .tagged("create-company-submit")
                }
            }
            .tagged("create-company-sheet")
            .navigationTitle(additional ? BooksStrings.entitySetupAddSheetTitle : BooksStrings.entitySetupSheetTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(CoreStrings.commonCancel) { dismiss() }
                        .tagged("cancel")
                }
            }
        }
    }

    /// US: the legal form, how the IRS taxes it, and a trade name.
    @ViewBuilder
    private var usSections: some View {
        Section {
            Dropdown(
                BooksStrings.entitySetupEntityType,
                value: entityType,
                options: typeChoices,
                tag: "company-entity-type"
            ) { next in
                entityType = next
                classification = UsRules.validClassification(types, next, classification)
            }
            Dropdown(
                BooksStrings.entitySetupTaxClassification,
                value: UsRules.validClassification(types, entityType, classification),
                options: classificationChoices,
                enabled: classifications.count > 1,
                tag: "company-tax-classification"
            ) { classification = $0 }
        } footer: {
            Text(BooksStrings.entitySetupClassificationHint)
        }
        Section {
            FormField(BooksStrings.entitySetupDba, text: $dba, placeholder: BooksStrings.entitySetupDbaPlaceholder, tag: "company-dba")
        }
    }

    /// Brazil: the legal form and the tax regime it allows.
    private var brSection: some View {
        let regimes = Identifiers.allowedBrRegimes(brEntityType)
        return Section {
            Dropdown(
                BooksStrings.entitySetupEntityType,
                value: brEntityType,
                options: Identifiers.brEntityTypes.map { Choice($0, entityTypeLabel($0)) },
                tag: "company-entity-type"
            ) { next in
                brEntityType = next
                brRegime = Identifiers.validBrRegime(next, brRegime)
            }
            Dropdown(
                BooksStrings.entitySetupTaxRegime,
                value: Identifiers.validBrRegime(brEntityType, brRegime),
                options: regimes.map { Choice($0, taxClassificationLabel($0)) },
                enabled: regimes.count > 1,
                tag: "company-tax-regime"
            ) { brRegime = $0 }
        } footer: {
            Text(BooksStrings.entitySetupRegimeHint)
        }
    }

    private func change(_ next: CompanyDraft) {
        company = next
        problems = CompanyProblems()
        usProblems = UsAddressProblems()
    }

    private func changeJurisdiction(_ next: String) {
        let kept = chosenCurrency
        code = next
        // Each country starts on its own currency; the picker below can still change it.
        currency = Jurisdictions.find(next, loaded)?.defaultCurrency ?? kept
        var cleared = company
        cleared.taxId = ""
        cleared.registrationNumber = ""
        cleared.iban = ""
        cleared.bic = ""
        company = cleared
        problems = CompanyProblems()
        usProblems = UsAddressProblems()
    }

    private func create() {
        let found = CompanyForm.problems(company, code, requireName: true)
        // The US address is where the company's sales tax starts from: a state and ZIP are required.
        let usFound = isUs ? Addresses.usProblems(company.address, requireStateAndZip: true) : UsAddressProblems()
        problems = found
        usProblems = usFound
        guard found.isEmpty, usFound.isEmpty else { return }
        let values = newEntity()
        let store = books.store
        submitting = true
        Task {
            do {
                let entity = try await store.createEntity(values)
                toaster.show(BooksStrings.entitySetupCreated)
                onCreated(entity)
                submitting = false
                dismiss()
            } catch {
                toaster.show(ErrorTexts.describe(error, fallback: BooksStrings.entitySetupCreateFailed))
                submitting = false
            }
        }
    }

    private func newEntity() -> NewEntity {
        let name = company.name.trimmed
        let taxId = CompanyForm.normalizeTaxId(company.taxId, code).nilIfEmpty
        if isUs {
            return NewEntity(
                name: name,
                jurisdictionCode: code,
                baseCurrency: chosenCurrency,
                isDefault: !additional,
                entityType: entityType,
                taxClassification: UsRules.validClassification(types, entityType, classification),
                dba: dba.trimmed.nilIfEmpty,
                vatNumber: nil,
                ein: taxId,
                registrationNumber: nil,
                iban: nil,
                bic: nil,
                address: Addresses.usAddress(company.address)
            )
        }
        if isBr {
            return NewEntity(
                name: name,
                jurisdictionCode: code,
                baseCurrency: chosenCurrency,
                isDefault: !additional,
                entityType: brEntityType,
                taxClassification: Identifiers.validBrRegime(brEntityType, brRegime),
                dba: nil,
                vatNumber: taxId,
                ein: nil,
                registrationNumber: nil,
                iban: nil,
                bic: nil,
                address: Addresses.genericAddress(company.address, country: code)
            )
        }
        return NewEntity(
            name: name,
            jurisdictionCode: code,
            baseCurrency: chosenCurrency,
            isDefault: !additional,
            entityType: nil,
            taxClassification: nil,
            dba: nil,
            vatNumber: taxId,
            ein: nil,
            registrationNumber: company.registrationNumber.trimmed.nilIfEmpty,
            iban: Identifiers.normalizeIban(company.iban).nilIfEmpty,
            bic: company.bic.trimmed.uppercased().nilIfEmpty,
            address: Addresses.genericAddress(company.address, country: code)
        )
    }
}

// MARK: - No company yet

/// The door of a workspace without a company: create one, or find the way
/// out (set it up on the web and check again, switch workspace, sign out).
struct EntityEmptyStateView: View {
    let workspaces: [WorkspaceRef]
    let onSwitchWorkspace: () -> Void

    @Environment(Books.self) private var books
    @Environment(BooksNavigator.self) private var navigator
    @Environment(Toaster.self) private var toaster
    @State private var creating = false
    @State private var checking = false
    @State private var confirmSignOut = false

    init(workspaces: [WorkspaceRef], onSwitchWorkspace: @escaping () -> Void) {
        self.workspaces = workspaces
        self.onSwitchWorkspace = onSwitchWorkspace
    }

    var body: some View {
        GeometryReader { proxy in
            ScrollView {
                content
                    .frame(maxWidth: 360)
                    .padding(Tokens.Spacing.xl)
                    .frame(maxWidth: .infinity, minHeight: proxy.size.height)
            }
        }
        .navigationTitle(BooksStrings.appName)
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $creating) {
            CreateEntitySheet { entity in
                books.entities.adopt(entity)
                Task { await books.entities.load() }
            }
            .booksContext(books: books, navigator: navigator, toaster: toaster)
        }
        .confirmDialog(
            BooksStrings.settingsSignOutTitle,
            isPresented: $confirmSignOut,
            confirm: BooksStrings.settingsSignOut,
            destructive: true
        ) {
            Task { await books.env.signOut() }
        }
    }

    private var content: some View {
        VStack(spacing: Tokens.Spacing.s) {
            IconTile(systemImage: "building.2", color: Accents.brand, size: 96)
            Text(BooksStrings.entitySetupEmptyTitle)
                .font(.title3.weight(.semibold))
                .multilineTextAlignment(.center)
                .padding(.top, Tokens.Spacing.m)
            Text(BooksStrings.entitySetupEmptyDescription)
                .font(.subheadline)
                .foregroundStyle(Color.secondary)
                .multilineTextAlignment(.center)
            Button {
                creating = true
            } label: {
                Text(BooksStrings.entitySetupCreateCompany).frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .tagged("create-company-open")
            .padding(.top, Tokens.Spacing.l)
            Text(BooksStrings.entitySetupEmptyWebHint)
                .font(.footnote)
                .foregroundStyle(Color.secondary)
                .multilineTextAlignment(.center)
                .padding(.top, Tokens.Spacing.l)
            Button(BooksStrings.entitySetupEmptyRefresh) { checkAgain() }
                .disabled(checking)
                .tagged("entity-check-again")
            if workspaces.count > 1 {
                Button(BooksStrings.entitySetupSwitchWorkspace, action: onSwitchWorkspace)
                    .tagged("entity-switch-workspace")
            }
            Button(BooksStrings.settingsSignOut, role: .destructive) { confirmSignOut = true }
                .tagged("entity-sign-out")
        }
        .accessibilityElement(children: .contain)
        .tagged("entity-empty")
    }

    private func checkAgain() {
        checking = true
        Task {
            await books.entities.load()
            checking = false
        }
    }
}

// MARK: - Administration switcher

/// The administration switcher: pick the company whose books are open, or
/// add another one. Sheet content; `ContentView` presents it while
/// `books.entities.switcherOpen` (opened from Home, More and Settings).
struct AdministrationSheet: View {
    @Environment(Books.self) private var books
    @Environment(BooksNavigator.self) private var navigator
    @Environment(Toaster.self) private var toaster
    @State private var adding = false

    init() {}

    var body: some View {
        let entities = books.entities
        NavigationStack {
            List {
                Section {
                    ForEach(entities.entities) { entity in
                        Button {
                            entities.select(entity.id)
                        } label: {
                            AdministrationRow(entity: entity, selected: entity.id == entities.activeId)
                        }
                        .tagged("administration-\(entity.id)")
                    }
                }
                Section {
                    Button {
                        adding = true
                    } label: {
                        HStack(spacing: Tokens.Spacing.m) {
                            Image(systemName: "plus")
                                .font(.system(size: 18, weight: .medium))
                                .foregroundStyle(Accents.brand)
                                .frame(width: 40, height: 40)
                                .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color(uiColor: .separator), lineWidth: 1))
                                .accessibilityHidden(true)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(BooksStrings.administrationsAdd)
                                    .font(.body.weight(.semibold))
                                    .foregroundStyle(Accents.brand)
                                Text(BooksStrings.administrationsAddHint)
                                    .font(.footnote)
                                    .foregroundStyle(Color.secondary)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .contentShape(Rectangle())
                    }
                    .tagged("administration-add")
                }
            }
            .tagged("administrations")
            .navigationTitle(BooksStrings.administrationsTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(CoreStrings.commonClose) { entities.closeSwitcher() }
                        .tagged("cancel")
                }
            }
        }
        .presentationDetents([.medium, .large])
        .sheet(isPresented: $adding) {
            // Over the switcher: creating the company opens its books, which closes both.
            CreateEntitySheet(
                additional: true,
                // A second company is usually registered where the first one is.
                initialJurisdiction: books.entity?.jurisdictionCode
            ) { entity in
                books.entities.adopt(entity)
                // The created row is enough to switch; the refresh fills in what the list adds.
                Task { await books.entities.load() }
            }
            .booksContext(books: books, navigator: navigator, toaster: toaster)
        }
    }
}

private struct AdministrationRow: View {
    let entity: Entity
    let selected: Bool

    var body: some View {
        HStack(spacing: Tokens.Spacing.m) {
            IconTile(systemImage: "building.2", color: Accents.settings)
            VStack(alignment: .leading, spacing: 2) {
                Text(entity.name)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(Color.primary)
                    .lineLimit(1)
                Text(entity.isDefault ? "\(entityMeta(entity)) · \(BooksStrings.commonDefault)" : entityMeta(entity))
                    .font(.footnote)
                    .foregroundStyle(Color.secondary)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if selected {
                Image(systemName: "checkmark")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(Accents.brand)
                    .accessibilityHidden(true)
            }
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

// MARK: - Editing the company

/// The open company's name, tax IDs, bank details and address. The country
/// and currency are fixed once the books exist, so they aren't here. Sheet
/// content (Settings, and an invoice that can't be finalised without them).
struct EditCompanySheet: View {
    let onSaved: () -> Void

    @Environment(Books.self) private var books
    @Environment(\.dismiss) private var dismiss

    init(onSaved: @escaping () -> Void = {}) {
        self.onSaved = onSaved
    }

    var body: some View {
        if let entity = books.entity {
            EditCompanyForm(entity: entity, onSaved: onSaved)
                .id(entity.id)
        } else {
            Color.clear.onAppear { dismiss() }
        }
    }
}

private struct EditCompanyForm: View {
    let entity: Entity
    let onSaved: () -> Void

    @Environment(Books.self) private var books
    @Environment(Toaster.self) private var toaster
    @Environment(\.dismiss) private var dismiss
    @State private var company: CompanyDraft
    @State private var problems = CompanyProblems()
    @State private var usProblems = UsAddressProblems()
    @State private var saving = false

    init(entity: Entity, onSaved: @escaping () -> Void) {
        self.entity = entity
        self.onSaved = onSaved
        _company = State(initialValue: CompanyForm.draft(entity))
    }

    private var code: String { entity.jurisdictionCode.uppercased() }

    private var draft: Binding<CompanyDraft> {
        Binding(get: { company }, set: { change($0) })
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    FormField(
                        BooksStrings.companyName,
                        text: draft.name,
                        error: problems.name ? BooksStrings.entitySetupCompanyNameError : nil,
                        tag: "company-name"
                    )
                } footer: {
                    Text(BooksStrings.companyEditHint)
                }
                CompanyFields(
                    code: code,
                    draft: draft,
                    problems: problems,
                    usProblems: usProblems,
                    requiredFields: Jurisdictions.requiredInvoiceFields(code, books.jurisdictions),
                    labels: books.labels,
                    terminology: books.terminology,
                    taxIdLabel: books.labels.taxId,
                    idHeader: nil,
                    idFooter: nil
                )
                Section {
                    Button(action: save) {
                        Text(BooksStrings.companySave).frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(saving)
                    .tagged("save-company")
                }
            }
            .tagged("edit-company-sheet")
            .navigationTitle(BooksStrings.companyEditTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(CoreStrings.commonCancel) { dismiss() }
                        .tagged("cancel")
                }
            }
        }
    }

    private func change(_ next: CompanyDraft) {
        company = next
        problems = CompanyProblems()
        usProblems = UsAddressProblems()
    }

    private func save() {
        let found = CompanyForm.problems(company, code, requireName: true)
        // A US address that is started needs its state and ZIP: they decide the sales tax.
        let usFound = Jurisdictions.isUs(code) ? Addresses.usProblems(company.address) : UsAddressProblems()
        problems = found
        usProblems = usFound
        guard found.isEmpty, usFound.isEmpty else { return }
        let update = CompanyForm.update(entity, company)
        if update.isEmpty {
            dismiss()
            return
        }
        let store = books.store
        let entities = books.entities
        let id = entity.id
        saving = true
        Task {
            do {
                _ = try await store.updateEntity(id: id, update: update)
                toaster.show(BooksStrings.companySaved)
                await entities.load()
                onSaved()
                saving = false
                dismiss()
            } catch {
                toaster.show(ErrorTexts.describe(error, fallback: BooksStrings.companySaveFailed))
                saving = false
            }
        }
    }
}

// MARK: - Settings

/// Settings: the company first, then sync, then what every WeldSuite app has
/// (workspace, app lock, notifications, appearance, language, account).
struct SettingsView: View {
    let person: Person
    let workspace: WorkspaceRef
    let workspaces: [WorkspaceRef]
    @Binding var appearance: AppAppearance

    @Environment(Books.self) private var books
    @Environment(BooksNavigator.self) private var navigator
    @Environment(Toaster.self) private var toaster
    @State private var editing = false

    init(person: Person, workspace: WorkspaceRef, workspaces: [WorkspaceRef], appearance: Binding<AppAppearance>) {
        self.person = person
        self.workspace = workspace
        self.workspaces = workspaces
        _appearance = appearance
    }

    var body: some View {
        Form {
            CompanySettingsSection { editing = true }
            SyncSettingsSection()
            CommonSettingsSections(
                env: books.env,
                appName: BooksStrings.appName,
                person: person,
                workspace: workspace,
                workspaces: workspaces,
                appearance: $appearance
            )
        }
        .tagged("settings")
        .navigationTitle(BooksStrings.settingsTitle)
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $editing) {
            EditCompanySheet()
                .booksContext(books: books, navigator: navigator, toaster: toaster)
        }
    }
}

/// The open company: a field the country needs on invoices shows as "Not set" while empty, instead of vanishing.
private struct CompanySettingsSection: View {
    let onEdit: () -> Void

    @Environment(Books.self) private var books

    init(onEdit: @escaping () -> Void) {
        self.onEdit = onEdit
    }

    var body: some View {
        let entities = books.entities
        let entity = entities.active
        let name = entity?.name ?? BooksStrings.commonDash
        let required = Jurisdictions.requiredInvoiceFields(books.code, books.jurisdictions)
        let missing = CompanyForm.missingInvoiceFields(entity, required)
        let address = Addresses.lines(entity?.address)
        Section {
            if entities.canSwitch {
                Button {
                    entities.openSwitcher()
                } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(BooksStrings.settingsAdministration)
                                .font(.footnote)
                                .foregroundStyle(Color.secondary)
                            Text(name)
                                .font(.body.weight(.semibold))
                                .foregroundStyle(Color.primary)
                        }
                        Spacer()
                        Image(systemName: "chevron.right")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(Color(uiColor: .tertiaryLabel))
                    }
                    .contentShape(Rectangle())
                }
                .accessibilityLabel(BooksStrings.screenSwitchAdministration(name: name))
                .tagged("settings-administration")
            } else {
                LabeledContent(BooksStrings.settingsName, value: name)
            }
            LabeledContent(BooksStrings.settingsJurisdiction, value: entity?.jurisdictionCode ?? BooksStrings.commonDash)
            LabeledContent(BooksStrings.settingsBaseCurrency, value: books.currency)
            LabeledContent(
                BooksStrings.settingsFiscalYearStart,
                value: CompanyForm.fiscalYearStart(entity?.fiscalYearStart, locale: books.locale) ?? BooksStrings.settingsFiscalYearFallback
            )
            CompanySettingRow(
                label: books.labels.taxId,
                value: books.isUs ? entity?.ein : entity?.vatNumber,
                required: required.contains("vatNumber")
            )
            CompanySettingRow(label: books.labels.registrationId, value: entity?.registrationNumber, required: required.contains("registrationNumber"))
            CompanySettingRow(label: BooksStrings.companyIban, value: entity?.iban, required: required.contains("iban"))
            if books.isUs, let entity {
                if let type = entity.entityType {
                    LabeledContent(BooksStrings.settingsLegalForm, value: entityTypeLabel(type))
                }
                if let value = entity.taxClassification {
                    LabeledContent(BooksStrings.settingsTaxClassification, value: taxClassificationLabel(value))
                }
                if let dba = entity.dba, !dba.isBlank {
                    LabeledContent(BooksStrings.settingsDba, value: dba)
                }
            }
            CompanySettingRow(
                label: BooksStrings.settingsAddress,
                value: address.isEmpty ? nil : address.joined(separator: "\n"),
                required: true
            )
            Button(action: onEdit) {
                Label(BooksStrings.settingsEditCompany, systemImage: "pencil")
            }
            .disabled(entity == nil)
            .tagged("edit-company")
        } header: {
            Text(BooksStrings.settingsCompany)
        } footer: {
            if !missing.isEmpty {
                Text(BooksStrings.settingsMissingForInvoices(fields: invoiceFieldNames(missing, labels: books.labels)))
            }
        }
    }
}

private struct CompanySettingRow: View {
    let label: String
    let value: String?
    let required: Bool

    var body: some View {
        if let value, !value.isBlank {
            LabeledContent(label) {
                Text(value).multilineTextAlignment(.trailing)
            }
        } else if required {
            LabeledContent(label) {
                Text(BooksStrings.companyNotSet).foregroundStyle(Tokens.Status.warning)
            }
        }
    }
}

/// The connection and what waits in the offline queue, with a way to send it now.
private struct SyncSettingsSection: View {
    @Environment(Books.self) private var books

    init() {}

    var body: some View {
        let queue = books.queue
        let waiting = queue.items.count
        Section {
            LabeledContent(BooksStrings.settingsConnection, value: queue.isOnline ? BooksStrings.settingsOnline : BooksStrings.settingsOffline)
            LabeledContent(BooksStrings.settingsQueuedItems, value: String(waiting))
            if waiting > 0 {
                Button {
                    Task { await queue.sync() }
                } label: {
                    Label(BooksStrings.settingsSyncNow, systemImage: "arrow.triangle.2.circlepath")
                }
                .disabled(!queue.isOnline || queue.isSyncing)
                .tagged("sync-now")
            }
        } header: {
            Text(BooksStrings.settingsSync)
        } footer: {
            if waiting > 0 {
                Text(BooksStrings.settingsSignOutQueued(waiting))
            }
        }
    }
}
