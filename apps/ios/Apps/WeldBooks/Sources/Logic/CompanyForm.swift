import Foundation

/// An address as the forms keep it while typing (text, never nil).
struct AddressDraft: Hashable, Sendable {
    var line1: String = ""
    var line2: String = ""
    var city: String = ""
    var state: String = ""
    var postalCode: String = ""

    var isBlank: Bool { [line1, line2, city, state, postalCode].allSatisfy(\.isBlank) }

    /// A ship-to the sales tax engine can work with: a real state and a ZIP.
    var isUsTaxable: Bool { UsRules.isStateCode(state) && Identifiers.normalizeZip(postalCode) != nil }

    static func of(_ address: Address?) -> AddressDraft {
        AddressDraft(
            line1: address?.line1 ?? "",
            line2: address?.line2 ?? "",
            city: address?.city ?? "",
            state: UsRules.stateCode(address?.state),
            postalCode: address?.postalCode ?? ""
        )
    }
}

/// What is wrong with a US address: `required` or `invalid` per field.
struct UsAddressProblems: Hashable, Sendable {
    var state: String?
    var postalCode: String?

    var isEmpty: Bool { state == nil && postalCode == nil }
}

enum Addresses {
    /// A blank address is fine, unless `requireStateAndZip`; a started one needs a valid state and ZIP.
    static func usProblems(_ draft: AddressDraft, requireStateAndZip: Bool = false) -> UsAddressProblems {
        let mustHave = requireStateAndZip || !draft.isBlank
        let state: String?
        if draft.state.isBlank {
            state = mustHave ? "required" : nil
        } else if !UsRules.isStateCode(draft.state) {
            state = "invalid"
        } else {
            state = nil
        }
        let zip: String?
        if draft.postalCode.isBlank {
            zip = mustHave ? "required" : nil
        } else if Identifiers.normalizeZip(draft.postalCode) == nil {
            zip = "invalid"
        } else {
            zip = nil
        }
        return UsAddressProblems(state: state, postalCode: zip)
    }

    /// A US address as the API takes it; nil for a blank one.
    static func usAddress(_ draft: AddressDraft) -> Address? {
        if draft.isBlank { return nil }
        return Address(
            line1: draft.line1.trimmed.nilIfEmpty,
            line2: draft.line2.trimmed.nilIfEmpty,
            city: draft.city.trimmed.nilIfEmpty,
            state: UsRules.stateCode(draft.state).nilIfEmpty,
            postalCode: (Identifiers.normalizeZip(draft.postalCode) ?? draft.postalCode.trimmed).nilIfEmpty,
            country: "US"
        )
    }

    /// An address outside the US as the API takes it; nil for a blank one. The
    /// update replaces the stored address as a whole, so the parts the form
    /// doesn't show (`stored` state, county) are carried through.
    static func genericAddress(_ draft: AddressDraft, country: String, stored: Address? = nil) -> Address? {
        if draft.isBlank { return nil }
        var address = stored ?? Address()
        address.line1 = draft.line1.trimmed.nilIfEmpty
        address.line2 = draft.line2.trimmed.nilIfEmpty
        address.city = draft.city.trimmed.nilIfEmpty
        address.postalCode = draft.postalCode.trimmed.nilIfEmpty
        address.country = country
        return address
    }

    /// "Springfield, IL 62704".
    static func cityLine(_ address: Address?) -> String {
        guard let address else { return "" }
        let stateZip = [address.state, address.postalCode].compactMap { $0 }.filter { !$0.isBlank }.joined(separator: " ")
        return [address.city, stateZip].compactMap { $0 }.filter { !$0.isBlank }.joined(separator: ", ")
    }

    /// The lines of an address to print, top to bottom.
    static func lines(_ address: Address?) -> [String] {
        guard let address else { return [] }
        return [address.line1, address.line2, cityLine(address)].compactMap { $0 }.filter { !$0.isBlank }
    }

    /// An address an invoice can print: a street and a city.
    static func isInvoiceAddress(_ address: Address?) -> Bool {
        !(address?.line1).isNullOrBlank && !(address?.city).isNullOrBlank
    }
}

/// The company details the setup and edit sheets keep while typing.
struct CompanyDraft: Hashable, Sendable {
    var name: String = ""
    /// BTW number, GSTIN, CNPJ or EIN.
    var taxId: String = ""
    /// KvK number, PAN, state ID, IE.
    var registrationNumber: String = ""
    var iban: String = ""
    var bic: String = ""
    var address: AddressDraft = AddressDraft()
}

/// What is wrong with the company details, by field. Blank optional fields are fine.
struct CompanyProblems: Hashable, Sendable {
    var name: Bool = false
    /// `einFormat`, `einPrefix`, `cnpjFormat`, `cnpjCheckDigits`, `btwFormat`.
    var taxId: String?
    /// `kvkFormat`.
    var registrationNumber: String?
    /// `ibanFormat`, `ibanChecksum`.
    var iban: String?
    var line1: Bool = false
    var city: Bool = false

    var isEmpty: Bool { !name && taxId == nil && registrationNumber == nil && iban == nil && !line1 && !city }
}

/// What `PATCH /accounting-entities/:id` changes; only what differs from the stored company.
struct EntityUpdateValues: Hashable, Sendable {
    var name: String?
    var vatNumber: String?
    var einOrSsn: String?
    var registrationNumber: String?
    var iban: String?
    var bic: String?
    var address: Address?

    var isEmpty: Bool { self == EntityUpdateValues() }
    var changesTaxIdentifiers: Bool { vatNumber != nil || einOrSsn != nil || registrationNumber != nil }
    var changesBank: Bool { iban != nil || bic != nil }
}

enum CompanyForm {
    static func draft(_ entity: Entity?) -> CompanyDraft {
        guard let entity else { return CompanyDraft() }
        let isUs = Jurisdictions.isUs(entity.jurisdictionCode)
        return CompanyDraft(
            name: entity.name,
            taxId: (isUs ? (entity.ein ?? entity.vatNumber) : entity.vatNumber) ?? "",
            registrationNumber: entity.registrationNumber ?? "",
            iban: entity.iban.map(Identifiers.formatIbanInput) ?? "",
            bic: entity.bic ?? "",
            address: AddressDraft.of(entity.address)
        )
    }

    /// The tax ID in the country's own normal form.
    static func normalizeTaxId(_ value: String, _ code: String?) -> String {
        switch code?.uppercased() {
        case "US": return value.isBlank ? "" : Identifiers.normalizeEin(value)
        case "BR": return Identifiers.normalizeCnpj(value)
        case "NL": return Identifiers.normalizeBtw(value)
        default: return value.trimmed
        }
    }

    private static func normalizeRegistration(_ value: String, _ code: String?) -> String {
        if code?.uppercased() == "NL" { return Identifiers.normalizeKvk(value) }
        return value.trimmed.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
    }

    /// Tax ID as typed: an EIN or a CNPJ takes shape while typing.
    static func formatTaxIdInput(_ code: String?, _ text: String) -> String {
        switch code?.uppercased() {
        case "US": return Identifiers.formatEinInput(text)
        case "BR": return Identifiers.formatCnpjInput(text)
        default: return text
        }
    }

    static func problems(_ draft: CompanyDraft, _ code: String?, requireName: Bool) -> CompanyProblems {
        let upper = code?.uppercased()
        var taxId: String?
        if !draft.taxId.isBlank {
            switch upper {
            case "US": taxId = Identifiers.einProblem(draft.taxId).map { $0 == "format" ? "einFormat" : "einPrefix" }
            case "BR": taxId = Identifiers.cnpjProblem(draft.taxId).map { $0 == "format" ? "cnpjFormat" : "cnpjCheckDigits" }
            case "NL": taxId = Identifiers.btwProblem(draft.taxId).map { _ in "btwFormat" }
            default: taxId = nil
            }
        }
        let registration: String? = upper == "NL" && !draft.registrationNumber.isBlank && Identifiers.kvkProblem(draft.registrationNumber) != nil
            ? "kvkFormat" : nil
        let iban: String? = draft.iban.isBlank ? nil : Identifiers.ibanProblem(draft.iban).map { $0 == "format" ? "ibanFormat" : "ibanChecksum" }
        // A US address is checked for its state and ZIP elsewhere; the others need a street and a city once started.
        let checkAddress = upper != "US" && !draft.address.isBlank
        return CompanyProblems(
            name: requireName && draft.name.isBlank,
            taxId: taxId,
            registrationNumber: registration,
            iban: iban,
            line1: checkAddress && draft.address.line1.isBlank,
            city: checkAddress && draft.address.city.isBlank
        )
    }

    private static func sameAddress(_ draft: AddressDraft, _ address: Address?) -> Bool {
        let stored = AddressDraft.of(address)
        return draft.line1.trimmed == stored.line1.trimmed && draft.line2.trimmed == stored.line2.trimmed
            && draft.city.trimmed == stored.city.trimmed && draft.state.trimmed == stored.state.trimmed
            && draft.postalCode.trimmed == stored.postalCode.trimmed
    }

    /// The changes `draft` makes to `entity`: an untouched field is not sent, and a blank address never clears one.
    static func update(_ entity: Entity, _ draft: CompanyDraft) -> EntityUpdateValues {
        let code = entity.jurisdictionCode
        let isUs = Jurisdictions.isUs(code)
        let stored = Self.draft(entity)
        var update = EntityUpdateValues()

        let name = draft.name.trimmed
        if !name.isEmpty, name != entity.name { update.name = name }

        let taxId = normalizeTaxId(draft.taxId, code)
        if taxId != normalizeTaxId(stored.taxId, code) {
            if isUs { update.einOrSsn = taxId } else { update.vatNumber = taxId }
        }
        let registration = normalizeRegistration(draft.registrationNumber, code)
        if registration != normalizeRegistration(stored.registrationNumber, code) { update.registrationNumber = registration }

        let iban = Identifiers.normalizeIban(draft.iban)
        if iban != Identifiers.normalizeIban(stored.iban) { update.iban = iban }
        let bic = draft.bic.trimmed.uppercased()
        if bic != stored.bic.trimmed.uppercased() { update.bic = bic }

        if !draft.address.isBlank, !sameAddress(draft.address, entity.address) {
            let address = isUs
                ? Addresses.usAddress(draft.address)
                : Addresses.genericAddress(draft.address, country: code.uppercased(), stored: entity.address)
            if let address { update.address = address }
        }
        return update
    }

    /// Which of `required` the company hasn't filled in.
    static func missingInvoiceFields(_ entity: Entity?, _ required: [String]) -> [String] {
        required.filter { field in
            switch field {
            case "vatNumber": return (entity?.vatNumber).isNullOrBlank
            case "registrationNumber": return (entity?.registrationNumber).isNullOrBlank
            case "iban": return (entity?.iban).isNullOrBlank
            case "bic": return (entity?.bic).isNullOrBlank
            case "address": return !Addresses.isInvoiceAddress(entity?.address)
            default: return false
            }
        }
    }

    /// "BTW-nummer, KvK-nummer and IBAN".
    static func listFields(_ fields: [String], name: (String) -> String, and: String) -> String {
        let words = fields.map(name)
        if words.count <= 1 { return words.joined() }
        return "\(words.dropLast().joined(separator: ", ")) \(and) \(words.last ?? "")"
    }

    /// "1 January" in `locale` for a fiscal year starting in `month` (1-12).
    static func fiscalYearStart(_ month: Int?, locale: Locale) -> String? {
        guard let month else { return nil }
        guard (1...12).contains(month) else { return String(month) }
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.locale = locale
        formatter.dateFormat = locale.region?.identifier == "US" ? "MMMM d" : "d MMMM"
        let date = Day(year: 2024, month: month, day: 1)?.date(timeZone: TimeZone(identifier: "UTC") ?? .current) ?? Date()
        return formatter.string(from: date)
    }
}
