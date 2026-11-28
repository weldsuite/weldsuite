import Foundation

/// Typo checks for the identifiers the company and contact forms take; the server checks them again.
enum Identifiers {
    // MARK: IBAN

    static func normalizeIban(_ raw: String) -> String {
        String(raw.filter { !$0.isWhitespace }).uppercased()
    }

    /// Upper case, in groups of four, as typed.
    static func formatIbanInput(_ raw: String) -> String {
        let characters = Array(normalizeIban(raw).filter { $0.isASCII && ($0.isUppercase || $0.isNumber) }.prefix(34))
        return stride(from: 0, to: characters.count, by: 4)
            .map { String(characters[$0..<min($0 + 4, characters.count)]) }
            .joined(separator: " ")
    }

    /// `format`, `checksum` or nil when the IBAN is fine.
    static func ibanProblem(_ raw: String) -> String? {
        let iban = normalizeIban(raw)
        if !iban.fullyMatches("[A-Z]{2}\\d{2}[A-Z0-9]{11,30}") { return "format" }
        let rearranged = iban.dropping(4) + iban.take(4)
        var remainder = 0
        for character in rearranged {
            guard let ascii = character.asciiValue else { return "format" }
            let value = character.isLetter ? String(Int(ascii) - 55) : String(character)
            for digit in value {
                remainder = (remainder * 10 + (digit.wholeNumberValue ?? 0)) % 97
            }
        }
        return remainder == 1 ? nil : "checksum"
    }

    // MARK: Netherlands

    static func normalizeBtw(_ raw: String) -> String {
        String(raw.filter { !$0.isWhitespace && $0 != "." }).uppercased()
    }

    static func btwProblem(_ raw: String) -> String? {
        normalizeBtw(raw).fullyMatches("NL\\d{9}B\\d{2}") ? nil : "format"
    }

    static func normalizeKvk(_ raw: String) -> String { String(raw.filter { !$0.isWhitespace }) }

    static func kvkProblem(_ raw: String) -> String? {
        normalizeKvk(raw).fullyMatches("\\d{8}") ? nil : "format"
    }

    // MARK: US

    private static let einPrefixes: [ClosedRange<Int>] = [1...6, 10...16, 20...27, 30...48, 50...68, 71...77, 80...88, 90...95, 98...99]

    private static func digitsOnly(_ raw: String) -> String { String(raw.filter { $0.isASCII && $0.isNumber }) }

    static func formatEinInput(_ raw: String) -> String {
        let digits = digitsOnly(raw).take(9)
        return digits.count > 2 ? "\(digits.take(2))-\(digits.dropping(2))" : digits
    }

    /// `format`, `prefix` or nil when the EIN is fine (or empty).
    static func einProblem(_ raw: String) -> String? {
        let text = raw.trimmed
        if text.isEmpty { return nil }
        if !text.fullyMatches("\\d{2}-\\d{7}"), !text.fullyMatches("\\d{9}") { return "format" }
        let prefix = Int(digitsOnly(text).take(2)) ?? -1
        return einPrefixes.contains { $0.contains(prefix) } ? nil : "prefix"
    }

    static func normalizeEin(_ raw: String) -> String {
        let digits = digitsOnly(raw)
        return digits.count == 9 ? "\(digits.take(2))-\(digits.dropping(2))" : raw.trimmed
    }

    /// `12345`, `12345-6789` or nine digits, as the canonical form; nil for anything else.
    static func normalizeZip(_ raw: String?) -> String? {
        guard let groups = raw.orEmpty.trimmed.firstMatchGroups("^(\\d{5})(?:-?(\\d{4}))?$"), groups.count >= 2 else { return nil }
        let five = groups[1]
        let four = groups.count > 2 ? groups[2] : ""
        if five == "00000" { return nil }
        return four.isEmpty ? five : "\(five)-\(four)"
    }

    static func formatZipInput(_ raw: String) -> String {
        let digits = digitsOnly(raw).take(9)
        return digits.count > 5 ? "\(digits.take(5))-\(digits.dropping(5))" : digits
    }

    // MARK: Brazil

    private static let cnpjWeights1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
    private static let cnpjWeights2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]

    static func normalizeCnpj(_ raw: String) -> String {
        String(raw.filter { !$0.isWhitespace && $0 != "." && $0 != "/" && $0 != "-" }).uppercased()
    }

    private static func checkDigit(_ values: [Int], _ weights: [Int]) -> Int {
        var sum = 0
        for index in values.indices where index < weights.count { sum += values[index] * weights[index] }
        let remainder = sum % 11
        return remainder < 2 ? 0 : 11 - remainder
    }

    /// The two check digits of a CNPJ's first twelve characters (letters count as their code minus 48).
    static func cnpjCheckDigits(_ first12: String) -> String {
        let values = first12.map { Int($0.asciiValue ?? 48) - 48 }
        let first = checkDigit(values, cnpjWeights1)
        let second = checkDigit(values + [first], cnpjWeights2)
        return "\(first)\(second)"
    }

    static func formatCnpj(_ normalized: String) -> String {
        guard normalized.count == 14 else { return normalized }
        return "\(normalized.slice(0, 2)).\(normalized.slice(2, 5)).\(normalized.slice(5, 8))/\(normalized.slice(8, 12))-\(normalized.slice(12, 14))"
    }

    static func formatCnpjInput(_ raw: String) -> String { formatCnpj(normalizeCnpj(raw).take(14)) }

    /// `format`, `checkDigits` or nil when the CNPJ is fine (or empty).
    static func cnpjProblem(_ raw: String) -> String? {
        let value = normalizeCnpj(raw)
        if value.isEmpty { return nil }
        let allSame = value.allSatisfy { $0 == value.first }
        if !value.fullyMatches("[0-9A-Z]{12}\\d{2}") || allSame { return "format" }
        return cnpjCheckDigits(value.take(12)) == String(value.suffix(2)) ? nil : "checkDigits"
    }

    static let brEntityTypes = ["mei", "ei", "slu", "ltda", "sa"]

    /// Which tax regimes a Brazilian legal form can be in.
    static func allowedBrRegimes(_ entityType: String?) -> [String] {
        switch entityType {
        case "mei": return ["mei"]
        case "sa": return ["lucro_presumido", "lucro_real"]
        default: return ["simples_nacional", "lucro_presumido", "lucro_real"]
        }
    }

    static func validBrRegime(_ entityType: String?, _ value: String?) -> String {
        let allowed = allowedBrRegimes(entityType)
        if let value, allowed.contains(value) { return value }
        return allowed.contains("simples_nacional") ? "simples_nacional" : (allowed.first ?? "simples_nacional")
    }
}

/// US states and US company forms.
enum UsRules {
    static let states: [(code: String, name: String)] = [
        ("AL", "Alabama"), ("AK", "Alaska"), ("AZ", "Arizona"), ("AR", "Arkansas"), ("CA", "California"),
        ("CO", "Colorado"), ("CT", "Connecticut"), ("DE", "Delaware"), ("DC", "District of Columbia"),
        ("FL", "Florida"), ("GA", "Georgia"), ("HI", "Hawaii"), ("ID", "Idaho"), ("IL", "Illinois"),
        ("IN", "Indiana"), ("IA", "Iowa"), ("KS", "Kansas"), ("KY", "Kentucky"), ("LA", "Louisiana"),
        ("ME", "Maine"), ("MD", "Maryland"), ("MA", "Massachusetts"), ("MI", "Michigan"), ("MN", "Minnesota"),
        ("MS", "Mississippi"), ("MO", "Missouri"), ("MT", "Montana"), ("NE", "Nebraska"), ("NV", "Nevada"),
        ("NH", "New Hampshire"), ("NJ", "New Jersey"), ("NM", "New Mexico"), ("NY", "New York"),
        ("NC", "North Carolina"), ("ND", "North Dakota"), ("OH", "Ohio"), ("OK", "Oklahoma"), ("OR", "Oregon"),
        ("PA", "Pennsylvania"), ("RI", "Rhode Island"), ("SC", "South Carolina"), ("SD", "South Dakota"),
        ("TN", "Tennessee"), ("TX", "Texas"), ("UT", "Utah"), ("VT", "Vermont"), ("VA", "Virginia"),
        ("WA", "Washington"), ("WV", "West Virginia"), ("WI", "Wisconsin"), ("WY", "Wyoming"),
        ("AS", "American Samoa"), ("GU", "Guam"), ("MP", "Northern Mariana Islands"), ("PR", "Puerto Rico"),
        ("VI", "U.S. Virgin Islands"),
    ]

    private static let codes = Set(states.map(\.code))

    static func isStateCode(_ value: String?) -> Bool {
        guard let value else { return false }
        return codes.contains(value.trimmed.uppercased())
    }

    /// `ca`, `CA` and `California` all become `CA`; anything else comes back trimmed.
    static func stateCode(_ value: String?) -> String {
        let text = value.orEmpty.trimmed
        if text.isEmpty { return "" }
        let upper = text.uppercased()
        if codes.contains(upper) { return upper }
        return states.first { $0.name.uppercased() == upper }?.code ?? text
    }

    /// The product tax codes a US line can carry.
    static let taxCodes = [
        "general", "saas", "digital_goods", "services", "professional_services", "shipping", "handling",
        "food_grocery", "prepared_food", "clothing", "prescription_drugs", "non_taxable",
    ]

    static let defaultTaxCode = "general"

    private static let forms: [String: (form: String, label: String)] = [
        "sole_proprietor": ("sch_c", "Schedule C (Form 1040)"),
        "disregarded": ("sch_c", "Schedule C (Form 1040)"),
        "partnership": ("f1065", "Form 1065"),
        "s_corp": ("f1120s", "Form 1120-S"),
        "c_corp": ("f1120", "Form 1120"),
        "exempt": ("f990", "Form 990"),
    ]

    private static func entityType(_ type: String, _ classifications: String...) -> UsEntityType {
        UsEntityType(
            type: type,
            label: type,
            defaultClassification: classifications.first ?? "",
            classifications: classifications.map { value in
                let form = forms[value] ?? (form: value, label: value)
                return UsClassification(value: value, form: form.form, formLabel: form.label)
            }
        )
    }

    static let fallbackEntityTypes: [UsEntityType] = [
        entityType("sole_proprietorship", "sole_proprietor"),
        entityType("single_member_llc", "disregarded", "s_corp", "c_corp"),
        entityType("multi_member_llc", "partnership", "s_corp", "c_corp"),
        entityType("partnership", "partnership"),
        entityType("s_corp", "s_corp"),
        entityType("c_corp", "c_corp"),
        entityType("nonprofit", "exempt"),
    ]

    static func entityTypes(_ loaded: [UsEntityType]?) -> [UsEntityType] {
        if let loaded, !loaded.isEmpty { return loaded }
        return fallbackEntityTypes
    }

    static func defaultClassification(_ types: [UsEntityType], _ type: String) -> String {
        let found = types.first { $0.type == type }
        if let value = found?.defaultClassification, !value.isEmpty { return value }
        return found?.classifications.first?.value ?? ""
    }

    /// `value` when the legal form allows it, else the form's default.
    static func validClassification(_ types: [UsEntityType], _ type: String, _ value: String?) -> String {
        let allowed = types.first { $0.type == type }?.classifications ?? []
        if let value, allowed.contains(where: { $0.value == value }) { return value }
        return defaultClassification(types, type)
    }
}
