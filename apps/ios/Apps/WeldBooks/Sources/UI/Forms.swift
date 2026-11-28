import SwiftUI
import UIKit
import WeldCore
import WeldUI

// Form fields and the shared form parts of the invoice, bill and payment
// screens (Android `ui/Forms.kt` and the fields of `ui/Common.kt`), drawn as
// the platform's: the label above a bordered `rounded-md` input, the ring colour
// while it has focus, the help or error line under it.

private struct PlainFieldsKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    /// Fields inside a system `Form` (a sheet): the form's rows are their frame, so no border of their own.
    var booksPlainFields: Bool {
        get { self[PlainFieldsKey.self] }
        set { self[PlainFieldsKey.self] = newValue }
    }
}

extension View {
    /// The platform's input box around a field: bordered, `rounded-md`, 44 points high.
    func inputChrome(focused: Bool = false, error: Bool = false, plain: Bool = false) -> some View {
        modifier(InputChrome(focused: focused, error: error, plain: plain))
    }
}

private struct InputChrome: ViewModifier {
    let focused: Bool
    let error: Bool
    let plain: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        if plain {
            content.padding(.vertical, 6)
        } else {
            content
                .padding(.horizontal, Tokens.Spacing.m)
                .padding(.vertical, 10)
                .frame(minHeight: 44)
                .background(Tokens.Palette.background, in: RoundedRectangle(cornerRadius: Tokens.Radius.medium))
                .overlay(
                    RoundedRectangle(cornerRadius: Tokens.Radius.medium)
                        .strokeBorder(error ? Tokens.Status.danger : (focused ? Tokens.Palette.ring : Tokens.Palette.input), lineWidth: 1)
                )
        }
    }
}

/// A field's label: the platform's `Label`, medium and in the foreground.
struct FieldLabel: View {
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text)
            .font(.inter(.subheadline, weight: .medium))
            .foregroundStyle(Tokens.Palette.foreground)
    }
}

/// The line under a field: the error in the danger colour, else the help text, muted.
private struct FieldNote: View {
    let error: String?
    let helper: String?

    var body: some View {
        if let error {
            Text(error).font(.inter(.caption)).foregroundStyle(Tokens.Status.danger)
        } else if let helper {
            Text(helper).font(.inter(.caption)).foregroundStyle(Tokens.Palette.mutedForeground)
        }
    }
}

/// A text field with its label above, and an error or helper line under it.
struct FormField: View {
    let label: String
    @Binding var text: String
    var placeholder: String?
    var error: String?
    var helper: String?
    var keyboard: UIKeyboardType
    /// More than 1: a field that grows, at least this many lines high.
    var lines: Int
    var maxLength: Int?
    var tag: String?

    @Environment(\.booksPlainFields) private var plain
    @FocusState private var focused: Bool

    init(
        _ label: String,
        text: Binding<String>,
        placeholder: String? = nil,
        error: String? = nil,
        helper: String? = nil,
        keyboard: UIKeyboardType = .default,
        lines: Int = 1,
        maxLength: Int? = nil,
        tag: String? = nil
    ) {
        self.label = label
        _text = text
        self.placeholder = placeholder
        self.error = error
        self.helper = helper
        self.keyboard = keyboard
        self.lines = lines
        self.maxLength = maxLength
        self.tag = tag
    }

    private var limited: Binding<String> {
        Binding(
            get: { text },
            set: { value in
                if let maxLength, value.count > maxLength {
                    text = String(value.prefix(maxLength))
                } else {
                    text = value
                }
            }
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            FieldLabel(label)
            field
                .font(.inter(.subheadline))
                .keyboardType(keyboard)
                .focused($focused)
                .inputChrome(focused: focused, error: error != nil, plain: plain)
                .tagged(tag)
            FieldNote(error: error, helper: helper)
        }
        .padding(.vertical, 6)
    }

    @ViewBuilder
    private var field: some View {
        if lines > 1 {
            TextField(placeholder ?? "", text: limited, axis: .vertical)
                .lineLimit(lines...)
        } else {
            TextField(placeholder ?? "", text: limited)
        }
    }
}

/// A choice from a list: the platform's select, as a menu.
struct Dropdown: View {
    let label: String
    let value: String?
    let options: [Choice]
    var enabled: Bool
    var placeholder: String?
    var error: String?
    var tag: String?
    let onChange: (String) -> Void

    @Environment(\.booksPlainFields) private var plain

    init(
        _ label: String,
        value: String?,
        options: [Choice],
        enabled: Bool = true,
        placeholder: String? = nil,
        error: String? = nil,
        tag: String? = nil,
        onChange: @escaping (String) -> Void
    ) {
        self.label = label
        self.value = value
        self.options = options
        self.enabled = enabled
        self.placeholder = placeholder
        self.error = error
        self.tag = tag
        self.onChange = onChange
    }

    private var current: String? {
        guard let value else { return nil }
        return options.first(where: { $0.key == value })?.label ?? value
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            FieldLabel(label)
            Menu {
                ForEach(options) { option in
                    Button {
                        onChange(option.key)
                    } label: {
                        if option.key == value {
                            Label(option.label, systemImage: "checkmark")
                        } else {
                            Text(option.label)
                        }
                    }
                }
            } label: {
                HStack {
                    Text(current ?? placeholder ?? "")
                        .font(.inter(.subheadline))
                        .foregroundStyle(current == nil || !enabled ? Tokens.Palette.mutedForeground : Tokens.Palette.foreground)
                        .lineLimit(1)
                    Spacer(minLength: Tokens.Spacing.s)
                    Image(systemName: "chevron.up.chevron.down")
                        .font(.system(size: 12))
                        .foregroundStyle(Tokens.Palette.mutedForeground)
                }
                .inputChrome(error: error != nil, plain: plain)
                .contentShape(Rectangle())
            }
            .disabled(!enabled)
            .tagged(tag)
            FieldNote(error: error, helper: nil)
        }
        .padding(.vertical, 6)
    }
}

/// A switch with its label.
struct SwitchRow: View {
    let label: String
    @Binding var isOn: Bool
    var tag: String?

    init(_ label: String, isOn: Binding<Bool>, tag: String? = nil) {
        self.label = label
        _isOn = isOn
        self.tag = tag
    }

    var body: some View {
        Toggle(isOn: $isOn) {
            Text(label).font(.inter(.subheadline))
        }
        .tint(Tokens.Palette.primary)
        .padding(.vertical, Tokens.Spacing.xs)
        .tagged(tag)
    }
}

/// A calendar day: its label above, the system's compact date picker in the company's locale.
struct DateField: View {
    let label: String
    @Binding var value: Day
    var error: String?
    var tag: String?

    @Environment(Books.self) private var books

    init(_ label: String, value: Binding<Day>, error: String? = nil, tag: String? = nil) {
        self.label = label
        _value = value
        self.error = error
        self.tag = tag
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            FieldLabel(label)
            DatePicker(
                label,
                selection: Binding(get: { value.date() }, set: { value = Day(date: $0) }),
                displayedComponents: .date
            )
            .labelsHidden()
            .environment(\.locale, books.locale)
            .tagged(tag)
            FieldNote(error: error, helper: nil)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 6)
    }
}

extension View {
    /// An "are you sure" alert (Android `ConfirmDialog`); the buttons are `confirm` and `cancel`.
    func confirmDialog(
        _ title: String,
        isPresented: Binding<Bool>,
        message: String? = nil,
        confirm: String,
        destructive: Bool = false,
        dismiss: String = CoreStrings.commonCancel,
        onConfirm: @escaping () -> Void
    ) -> some View {
        alert(title, isPresented: isPresented) {
            Button(confirm, role: destructive ? .destructive : nil, action: onConfirm)
                .accessibilityIdentifier("confirm")
            Button(dismiss, role: .cancel) {}
                .accessibilityIdentifier("cancel")
        } message: {
            if let message {
                Text(message)
            }
        }
    }

    /// Run `action` whenever `id` changes, after `milliseconds` without another change (Android `Debounced`).
    func debounced<ID: Equatable>(_ id: ID, milliseconds: Int, action: @escaping () async -> Void) -> some View {
        task(id: id) {
            try? await Task.sleep(for: .milliseconds(milliseconds))
            guard !Task.isCancelled else { return }
            await action()
        }
    }
}

// MARK: - Address

/// US address fields: street lines, city, a state picker and ZIP.
struct AddressFields: View {
    @Binding var value: AddressDraft
    var problems: UsAddressProblems = UsAddressProblems()

    private static let stateChoices = UsRules.states.map { Choice($0.code, "\($0.name) (\($0.code))") }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            FormField(BooksStrings.addressLine1, text: $value.line1, placeholder: BooksStrings.addressLine1Placeholder)
            FormField(BooksStrings.addressLine2, text: $value.line2, placeholder: BooksStrings.addressLine2Placeholder)
            FormField(BooksStrings.addressCity, text: $value.city)
            HStack(alignment: .top, spacing: Tokens.Spacing.s) {
                Dropdown(
                    BooksStrings.addressState,
                    value: UsRules.stateCode(value.state).nilIfEmpty,
                    options: Self.stateChoices,
                    placeholder: BooksStrings.addressSelectState,
                    error: stateError
                ) { code in
                    value.state = code
                }
                .frame(maxWidth: .infinity)
                FormField(
                    BooksStrings.addressZip,
                    text: Binding(get: { value.postalCode }, set: { value.postalCode = Identifiers.formatZipInput($0) }),
                    placeholder: BooksStrings.addressZipPlaceholder,
                    error: zipError,
                    keyboard: .numberPad
                )
                .frame(maxWidth: .infinity)
            }
        }
    }

    private var stateError: String? {
        switch problems.state {
        case "required": return BooksStrings.addressStateRequired
        case "invalid": return BooksStrings.addressStateInvalid
        default: return nil
        }
    }

    private var zipError: String? {
        switch problems.postalCode {
        case "required": return BooksStrings.addressZipRequired
        case "invalid": return BooksStrings.addressZipInvalid
        default: return nil
        }
    }
}

// MARK: - Line items

/// The server's tax of a US invoice, once it has calculated it.
struct ServerTax: Hashable, Sendable {
    var taxTotal: Decimal
    var total: Decimal
    var loading: Bool
}

/// The invoice and bill forms' lines, with totals. How a line is taxed depends on `mode`.
struct LineItemsEditor: View {
    @Binding var lines: [LineDraft]
    let mode: TaxMode
    let defaultTaxRate: String
    let currency: String
    var error: String?
    var serverTax: ServerTax?

    @Environment(Books.self) private var books

    private struct IndexedLine: Identifiable {
        let index: Int
        let line: LineDraft
        var id: String { line.key }
    }

    private var taxCodes: [Choice] { UsRules.taxCodes.map { Choice($0, taxCodeLabel($0)) } }

    private func text(_ key: String, _ path: WritableKeyPath<LineDraft, String>) -> Binding<String> {
        Binding(
            get: { lines.first(where: { $0.key == key })?[keyPath: path] ?? "" },
            set: { value in
                if let index = lines.firstIndex(where: { $0.key == key }) { lines[index][keyPath: path] = value }
            }
        )
    }

    private func flag(_ key: String) -> Binding<Bool> {
        Binding(
            get: { lines.first(where: { $0.key == key })?.accrueUseTax ?? false },
            set: { value in
                if let index = lines.firstIndex(where: { $0.key == key }) { lines[index].accrueUseTax = value }
            }
        )
    }

    private func setTaxCode(_ key: String, _ code: String) {
        if let index = lines.firstIndex(where: { $0.key == key }) { lines[index].taxCode = code }
    }

    var body: some View {
        let totals = LineItems.totals(lines, mode: mode, decimalPoint: books.decimalPoint)
        VStack(spacing: 0) {
            SectionCard(title: BooksStrings.lineItemsTitle) {
                Button {
                    lines.append(LineItems.empty(taxRate: defaultTaxRate))
                } label: {
                    Label(BooksStrings.lineItemsAdd, systemImage: "plus")
                        .font(.inter(.subheadline, weight: .medium))
                }
                .tagged("add-line")
            } content: {
                ForEach(lines.enumerated().map { IndexedLine(index: $0.offset, line: $0.element) }) { item in
                    if item.index > 0 {
                        Hairline().padding(.vertical, Tokens.Spacing.m)
                    }
                    lineEditor(item.line, index: item.index)
                }
                if let error {
                    Text(error)
                        .font(.inter(.footnote))
                        .foregroundStyle(Tokens.Status.danger)
                        .padding(.top, Tokens.Spacing.s)
                }
            }
            SectionCard(title: BooksStrings.lineItemsTotals) {
                TotalsBlock(
                    rows: [(BooksStrings.lineItemsSubtotal, books.money(totals.subtotal, currency: currency)), taxRow(totals)],
                    total: (BooksStrings.lineItemsTotal, books.money(grandTotal(totals), currency: currency))
                )
            }
        }
    }

    @ViewBuilder
    private func lineEditor(_ line: LineDraft, index: Int) -> some View {
        let number = String(index + 1)
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(BooksStrings.lineItemsItem(index: number))
                    .font(.inter(.caption, weight: .medium))
                    .foregroundStyle(Tokens.Palette.mutedForeground)
                Spacer()
                if lines.count > 1 {
                    Button {
                        lines.removeAll { $0.key == line.key }
                    } label: {
                        Image(systemName: "trash")
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Tokens.Status.danger)
                    .accessibilityLabel(BooksStrings.lineItemsRemove(index: number))
                }
            }
            FormField(BooksStrings.lineItemsDescription, text: text(line.key, \.description), tag: "line-description-\(index)")
            HStack(alignment: .top, spacing: Tokens.Spacing.s) {
                FormField(BooksStrings.lineItemsQty, text: text(line.key, \.quantity), keyboard: .decimalPad, tag: "line-quantity-\(index)")
                    .frame(maxWidth: .infinity)
                FormField(BooksStrings.lineItemsUnitPrice, text: text(line.key, \.unitPrice), placeholder: "0.00", keyboard: .decimalPad, tag: "line-price-\(index)")
                    .frame(maxWidth: .infinity)
                    .layoutPriority(1)
                if mode != .code {
                    FormField(
                        mode == .cost ? BooksStrings.lineItemsTaxPaidPercent : books.labels.taxPercent,
                        text: text(line.key, \.taxRate),
                        placeholder: defaultTaxRate,
                        keyboard: .decimalPad,
                        tag: "line-tax-\(index)"
                    )
                    .frame(maxWidth: .infinity)
                }
            }
            if mode == .code {
                Dropdown(BooksStrings.salesTaxTaxCode, value: line.taxCode, options: taxCodes) { code in setTaxCode(line.key, code) }
            }
            if mode == .cost {
                SwitchRow(BooksStrings.lineItemsAccrueUseTax, isOn: flag(line.key))
                HintText(BooksStrings.lineItemsAccrueUseTaxHint)
                if line.accrueUseTax {
                    Dropdown(BooksStrings.salesTaxTaxCode, value: line.taxCode, options: taxCodes) { code in setTaxCode(line.key, code) }
                }
            }
            Text(BooksStrings.lineItemsLineTotal(amount: books.money(LineItems.lineTotal(line, decimalPoint: books.decimalPoint), currency: currency)))
                .font(.inter(.footnote))
                .foregroundStyle(Tokens.Palette.mutedForeground)
                .frame(maxWidth: .infinity, alignment: .trailing)
                .padding(.top, 4)
        }
    }

    private func taxRow(_ totals: Totals) -> (String, String) {
        switch mode {
        case .code:
            if let serverTax, !serverTax.loading { return (books.labels.tax, books.money(serverTax.taxTotal, currency: currency)) }
            return (books.labels.tax, BooksStrings.lineItemsTaxPending)
        case .cost:
            return (BooksStrings.lineItemsTaxPaid, books.money(totals.taxTotal, currency: currency))
        case .rate:
            return (books.labels.tax, books.money(totals.taxTotal, currency: currency))
        }
    }

    private func grandTotal(_ totals: Totals) -> Decimal {
        if mode == .code, let serverTax, !serverTax.loading { return serverTax.total }
        return totals.total
    }
}

/// A US product tax code in words.
func taxCodeLabel(_ code: String) -> String {
    switch code {
    case "saas": return BooksStrings.salesTaxCodesSaas
    case "digital_goods": return BooksStrings.salesTaxCodesDigitalGoods
    case "services": return BooksStrings.salesTaxCodesServices
    case "professional_services": return BooksStrings.salesTaxCodesProfessionalServices
    case "shipping": return BooksStrings.salesTaxCodesShipping
    case "handling": return BooksStrings.salesTaxCodesHandling
    case "food_grocery": return BooksStrings.salesTaxCodesFoodGrocery
    case "prepared_food": return BooksStrings.salesTaxCodesPreparedFood
    case "clothing": return BooksStrings.salesTaxCodesClothing
    case "prescription_drugs": return BooksStrings.salesTaxCodesPrescriptionDrugs
    case "non_taxable": return BooksStrings.salesTaxCodesNonTaxable
    default: return BooksStrings.salesTaxCodesGeneral
    }
}

/// A US tax jurisdiction's level in words (`state`, `county`, …).
func taxLevelLabel(_ level: String?) -> String? {
    switch level {
    case "state": return BooksStrings.salesTaxLevelsState
    case "county": return BooksStrings.salesTaxLevelsCounty
    case "city": return BooksStrings.salesTaxLevelsCity
    case "district": return BooksStrings.salesTaxLevelsDistrict
    default: return nil
    }
}

/// A known sales tax warning code in words; nil for an unknown one (then `TaxBreakdown.warningText` makes it readable).
func taxWarningLabel(_ code: String) -> String? {
    switch code {
    case "not_registered_in_state": return BooksStrings.salesTaxWarningsNotRegisteredInState
    case "address_unverified": return BooksStrings.salesTaxWarningsAddressUnverified
    case "no_ship_to": return BooksStrings.salesTaxWarningsNoShipTo
    case "certificate_expired": return BooksStrings.salesTaxWarningsCertificateExpired
    case "certificate_missing": return BooksStrings.salesTaxWarningsCertificateMissing
    case "marketplace_facilitated": return BooksStrings.salesTaxWarningsMarketplaceFacilitated
    case "zone_not_found": return BooksStrings.salesTaxWarningsZoneNotFound
    case "no_use_tax_registration": return BooksStrings.salesTaxWarningsNoUseTaxRegistration
    case "rates_not_configured": return BooksStrings.salesTaxWarningsRatesNotConfigured
    case "override_not_applied": return BooksStrings.salesTaxWarningsOverrideNotApplied
    case "provider_rate_date_ignored": return BooksStrings.salesTaxWarningsProviderRateDateIgnored
    case "provider_not_supported": return BooksStrings.salesTaxWarningsProviderNotSupported
    case "provider_nexus_missing": return BooksStrings.salesTaxWarningsProviderNexusMissing
    case "tax_engine_unavailable": return BooksStrings.salesTaxWarningsTaxEngineUnavailable
    case "commit_failed": return BooksStrings.salesTaxWarningsCommitFailed
    case "reverse_failed": return BooksStrings.salesTaxWarningsReverseFailed
    case "reverse_unsupported": return BooksStrings.salesTaxWarningsReverseUnsupported
    case "reverse_skipped": return BooksStrings.salesTaxWarningsReverseSkipped
    default: return nil
    }
}

// MARK: - Tax breakdowns

/// US sales tax as the server calculated it: the total, a per-jurisdiction breakdown, exemptions and warnings.
struct TaxBreakdownCard: View {
    let rows: [TaxRow]
    let warnings: [String]
    let currency: String
    var title: String?
    var footnote: String?

    @State private var expanded: Bool
    @Environment(Books.self) private var books

    init(rows: [TaxRow], warnings: [String], currency: String, title: String? = nil, initiallyExpanded: Bool = false, footnote: String? = nil) {
        self.rows = rows
        self.warnings = warnings
        self.currency = currency
        self.title = title
        self.footnote = footnote
        _expanded = State(initialValue: initiallyExpanded)
    }

    var body: some View {
        let groups = TaxBreakdown.groups(rows)
        let charged = groups.filter { $0.kind == "tax" }
        let used = groups.filter { $0.kind == "use" }
        let canExpand = !groups.isEmpty
        if !groups.isEmpty || !warnings.isEmpty {
            SectionCard {
                Button {
                    if canExpand { expanded.toggle() }
                } label: {
                    HStack(alignment: .center) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(title ?? BooksStrings.salesTaxTitle).font(.inter(.subheadline, weight: .semibold))
                            if canExpand {
                                Text(expanded ? BooksStrings.salesTaxHideBreakdown : BooksStrings.salesTaxShowBreakdown)
                                    .font(.inter(.footnote))
                                    .foregroundStyle(Tokens.Palette.mutedForeground)
                            }
                        }
                        Spacer()
                        Text(headline(charged: charged, used: used)).font(.inter(.subheadline, weight: .semibold))
                        if canExpand {
                            Image(systemName: expanded ? "chevron.up" : "chevron.down")
                                .font(.inter(.caption))
                                .foregroundStyle(Tokens.Palette.mutedForeground)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .tagged("tax-breakdown")

                if expanded, canExpand {
                    Hairline().padding(.vertical, Tokens.Spacing.s)
                    ForEach(charged) { group in JurisdictionRow(group: group, currency: currency) }
                    if !used.isEmpty {
                        if !charged.isEmpty { HintText(BooksStrings.salesTaxUseTaxAccrued) }
                        ForEach(used) { group in JurisdictionRow(group: group, currency: currency) }
                    }
                }
                if groups.isEmpty { HintText(BooksStrings.salesTaxNoTaxCharged) }
                if let footnote { HintText(footnote) }
                if TaxBreakdown.hasExempt(rows) {
                    Banner(exemptNotice, title: BooksStrings.salesTaxExemptTitle)
                        .padding(.horizontal, -Tokens.Spacing.l)
                }
                if !warnings.isEmpty {
                    Banner(warningTexts.joined(separator: "\n"), tone: "warning", title: BooksStrings.salesTaxWarningsTitle)
                        .padding(.horizontal, -Tokens.Spacing.l)
                }
            }
        }
    }

    private func headline(charged: [TaxBreakdown.Group], used: [TaxBreakdown.Group]) -> String {
        if !charged.isEmpty { return books.money(TaxBreakdown.chargedTotal(rows), currency: currency) }
        if !used.isEmpty { return books.money(TaxBreakdown.useTaxTotal(rows), currency: currency) }
        return BooksStrings.commonDash
    }

    private var exemptNotice: String {
        let reasons = TaxBreakdown.exemptReasons(rows)
        let amount = books.money(TaxBreakdown.exemptAmount(rows), currency: currency)
        if reasons.isEmpty { return BooksStrings.salesTaxExemptNoticeNoReason(amount: amount) }
        return BooksStrings.salesTaxExemptNotice(amount: amount, reasons: reasons.joined(separator: ", "))
    }

    private var warningTexts: [String] {
        warnings.map { warning in
            taxWarningLabel(TaxBreakdown.parseWarning(warning).code) ?? TaxBreakdown.warningText(warning) { _ in nil }
        }
    }
}

private struct JurisdictionRow: View {
    let group: TaxBreakdown.Group
    let currency: String

    @Environment(Books.self) private var books

    var body: some View {
        let detail: String? = group.rate > 0
            ? BooksStrings.salesTaxRateOn(rate: Amounts.percent(group.rate), amount: books.money(group.taxable, currency: currency))
            : nil
        let line = [taxLevelLabel(group.level), detail].compactMap { $0 }.joined(separator: " · ")
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(group.name).font(.inter(.subheadline))
                if !line.isEmpty {
                    Text(line).font(.inter(.footnote)).foregroundStyle(Tokens.Palette.mutedForeground)
                }
            }
            Spacer()
            Text(books.money(group.tax, currency: currency)).font(.inter(.subheadline))
        }
        .padding(.vertical, 4)
    }
}

/// A Brazilian document's taxes by how they sit in its total.
struct TreatmentBreakdownCard: View {
    let rows: [TaxRow]
    let currency: String

    @Environment(Books.self) private var books

    var body: some View {
        let groups = TaxBreakdown.byTreatment(rows)
        if !groups.isEmpty {
            SectionCard(title: BooksStrings.taxTreatmentTitle) {
                ForEach(groups.indices, id: \.self) { index in
                    let group = groups[index]
                    if index > 0 { Hairline().padding(.vertical, Tokens.Spacing.s) }
                    HintText(treatmentLabel(group.treatment))
                    ForEach(group.taxes) { tax in
                        treatmentRow(tax, group: group)
                    }
                }
            }
        }
    }

    private func treatmentLabel(_ treatment: String) -> String {
        switch treatment {
        case "added": return BooksStrings.taxTreatmentAdded
        case "embedded": return BooksStrings.taxTreatmentEmbedded
        case "withheld": return BooksStrings.taxTreatmentWithheld
        default: return BooksStrings.taxTreatmentInformational
        }
    }

    private func treatmentRow(_ tax: TaxBreakdown.TreatmentTax, group: TaxBreakdown.TreatmentGroup) -> some View {
        let amount = books.money(tax.amount, currency: currency)
        let informational = group.treatment == "informational"
        let color = informational ? Tokens.Palette.mutedForeground : Tokens.Palette.foreground
        return HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(tax.name).font(.inter(.subheadline)).foregroundStyle(color)
                if tax.rate > 0 {
                    Text(BooksStrings.salesTaxRateOn(rate: Amounts.percent(tax.rate), amount: books.money(tax.base, currency: currency)))
                        .font(.inter(.footnote))
                        .foregroundStyle(Tokens.Palette.mutedForeground)
                }
            }
            Spacer()
            Text(group.treatment == "withheld" ? "−\(amount)" : amount).font(.inter(.subheadline)).foregroundStyle(color)
        }
        .padding(.vertical, 4)
    }
}

// MARK: - Payments

/// Record a payment against an invoice or bill: the open balance by default,
/// less for a partial payment. Sheet content: present it with
/// `.sheet(isPresented:)`; it closes itself on Cancel, the caller closes it after
/// `onSubmit` succeeds.
struct PaymentSheet: View {
    let balanceDue: Decimal
    let currency: String
    /// Money in (an invoice) rather than out (a bill).
    let received: Bool
    let busy: Bool
    let onSubmit: (PaymentValues) -> Void

    @Environment(Books.self) private var books
    @Environment(\.dismiss) private var dismiss
    @State private var amount: String
    @State private var date = Days.today()
    @State private var method: String?
    @State private var checkNumber = ""
    @State private var depositTo = "undeposited_funds"
    @State private var error: String?

    init(balanceDue: Decimal, currency: String, received: Bool, busy: Bool, onSubmit: @escaping (PaymentValues) -> Void) {
        self.balanceDue = balanceDue
        self.currency = currency
        self.received = received
        self.busy = busy
        self.onSubmit = onSubmit
        _amount = State(initialValue: balanceDue > 0 ? Money.apiString(Amounts.cents(balanceDue)) : "")
    }

    private var isUs: Bool { books.isUs }
    private var chosenMethod: String { method ?? Payments.defaultMethod(isUs: isUs) }
    private var value: Decimal { Amounts.parse(amount, decimalPoint: books.decimalPoint) }
    private var remaining: Decimal { balanceDue - value }
    private static let halfCent = Decimal(5) / 1000

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(BooksStrings.paymentsOpenBalance).font(.inter(.footnote)).foregroundStyle(Tokens.Palette.mutedForeground)
                        Text(books.money(balanceDue, currency: currency)).font(.inter(.title2, weight: .semibold))
                    }
                }
                Section {
                    FormField(
                        BooksStrings.paymentsAmount,
                        text: Binding(get: { amount }, set: { amount = $0; error = nil }),
                        placeholder: "0.00",
                        error: error,
                        helper: remaining > Self.halfCent ? BooksStrings.paymentsRemaining(amount: books.money(remaining, currency: currency)) : nil,
                        keyboard: .decimalPad,
                        tag: "payment-amount"
                    )
                    DateField(BooksStrings.paymentsPaymentDate, value: $date, tag: "payment-date")
                    Dropdown(
                        BooksStrings.paymentsMethod,
                        value: chosenMethod,
                        options: Payments.methods(isUs: isUs).map { Choice($0, paymentMethodLabel($0)) },
                        tag: "payment-method"
                    ) { method = $0 }
                    if Payments.takesCheckNumber(isUs: isUs, method: chosenMethod) {
                        FormField(
                            BooksStrings.paymentsCheckNumber,
                            text: $checkNumber,
                            placeholder: BooksStrings.paymentsCheckNumberPlaceholder,
                            keyboard: .numberPad
                        )
                    }
                    if Payments.offersDepositChoice(isUs: isUs, received: received, method: chosenMethod) {
                        Dropdown(
                            BooksStrings.paymentsDepositTo,
                            value: depositTo,
                            options: [
                                Choice("undeposited_funds", BooksStrings.paymentsUndepositedFunds),
                                Choice("bank", BooksStrings.paymentsBankAccount),
                            ]
                        ) { depositTo = $0 }
                        HintText(depositTo == "bank" ? BooksStrings.paymentsBankHint : BooksStrings.paymentsUndepositedHint)
                    }
                }
                Section {
                    Button(action: submit) {
                        Text(BooksStrings.paymentsTitle).frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(busy)
                    .tagged("payment-submit")
                }
            }
            // A system form: its rows frame the fields.
            .environment(\.booksPlainFields, true)
            .navigationTitle(BooksStrings.paymentsTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(CoreStrings.commonCancel) { dismiss() }.tagged("cancel")
                }
            }
        }
    }

    private func submit() {
        if value <= 0 {
            error = BooksStrings.paymentsAmountError
            return
        }
        if balanceDue > 0, value > balanceDue + Self.halfCent {
            error = BooksStrings.paymentsExceedBalance(amount: books.money(balanceDue, currency: currency))
            return
        }
        let check = checkNumber.trimmed
        onSubmit(PaymentValues(
            amount: value,
            date: date.iso,
            method: chosenMethod,
            checkNumber: Payments.takesCheckNumber(isUs: isUs, method: chosenMethod) && !check.isEmpty ? check : nil,
            depositTo: Payments.offersDepositChoice(isUs: isUs, received: received, method: chosenMethod) ? depositTo : nil
        ))
    }
}

/// A payment method in words.
func paymentMethodLabel(_ method: String) -> String {
    switch method {
    case "check": return BooksStrings.paymentsCheck
    case "ach": return BooksStrings.paymentsAch
    case "wire": return BooksStrings.paymentsWire
    case "credit_card": return BooksStrings.paymentsCreditCard
    case "debit_card": return BooksStrings.paymentsDebitCard
    case "cash": return BooksStrings.paymentsCash
    case "bank_transfer": return BooksStrings.paymentsBankTransfer
    case "card": return BooksStrings.paymentsCard
    case "direct_debit": return BooksStrings.paymentsDirectDebit
    default: return BooksStrings.paymentsOther
    }
}
