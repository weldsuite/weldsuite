import Foundation

/// Which country modules an entity gets (`GET /accounting-entities/jurisdictions`).
struct Features: Hashable, Sendable {
    var vatReturn: Bool = false
    var icp: Bool = false
    var xafExport: Bool = false
    var smallBusinessScheme: Bool = false
    var gstReturn: Bool = false
    var salesTax: Bool = false
    var form1099: Bool = false
    var brTaxReturn: Bool = false
    var fiscalDocuments: Bool = false
    var spedEcd: Bool = false
}

/// Codes of the words that differ per country; the app translates them (`terminologyLabels`).
struct Terminology: Hashable, Sendable {
    var tax: String = "vat"
    var taxId: String = "vat_number"
    var registrationId: String = "company_number"
    var supplier: String = "supplier"
    var creditNote: String = "credit_note"
}

struct UsClassification: Hashable, Sendable {
    var value: String
    var form: String
    var formLabel: String
}

struct UsEntityType: Hashable, Sendable {
    var type: String
    var label: String
    var defaultClassification: String
    var classifications: [UsClassification]
}

struct Jurisdiction: Hashable, Sendable {
    var code: String
    var name: String
    var defaultLocale: String
    var defaultCurrency: String
    var features: Features
    var terminology: Terminology
    /// The company fields an invoice can't be finalised without; nil from an older server.
    var invoiceRequiredFields: [String]?
    /// US only.
    var entityTypes: [UsEntityType]?
}

/// Country rules, mirroring the server's adapters, for before (or without) the server's list.
enum Jurisdictions {
    static let fallbackCurrency = "EUR"

    static let builtIn: [Jurisdiction] = [
        Jurisdiction(
            code: "NL", name: "Netherlands", defaultLocale: "nl-NL", defaultCurrency: "EUR",
            features: Features(vatReturn: true, icp: true, xafExport: true, smallBusinessScheme: true),
            terminology: Terminology(tax: "vat", taxId: "vat_number", registrationId: "kvk", supplier: "supplier", creditNote: "credit_note")
        ),
        Jurisdiction(
            code: "IN", name: "India", defaultLocale: "en-IN", defaultCurrency: "INR",
            features: Features(gstReturn: true),
            terminology: Terminology(tax: "gst", taxId: "gstin", registrationId: "pan", supplier: "supplier", creditNote: "credit_note")
        ),
        Jurisdiction(
            code: "US", name: "United States", defaultLocale: "en-US", defaultCurrency: "USD",
            features: Features(salesTax: true, form1099: true),
            terminology: Terminology(tax: "sales_tax", taxId: "ein", registrationId: "state_id", supplier: "vendor", creditNote: "credit_memo")
        ),
        Jurisdiction(
            code: "BR", name: "Brazil", defaultLocale: "pt-BR", defaultCurrency: "BRL",
            features: Features(brTaxReturn: true, fiscalDocuments: true, spedEcd: true),
            terminology: Terminology(tax: "tributos", taxId: "cnpj", registrationId: "ie", supplier: "supplier", creditNote: "credit_note")
        ),
    ]

    private static let defaultTaxRates = ["NL": "21", "IN": "18", "BR": "0"]

    /// What a company with these fields needs on an invoice, per country (address added everywhere).
    static let builtInInvoiceFields: [String: [String]] = [
        "NL": ["vatNumber", "registrationNumber", "iban", "address"],
        "IN": ["vatNumber", "registrationNumber", "address"],
        "BR": ["vatNumber", "address"],
        "US": ["address"],
    ]

    static let invoiceFields = ["vatNumber", "registrationNumber", "iban", "bic", "address"]

    private static let ibanCountries: Set<String> = [
        "AD", "AT", "BE", "BG", "CH", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GB", "GI", "GR",
        "HR", "HU", "IE", "IS", "IT", "LI", "LT", "LU", "LV", "MC", "MT", "NL", "NO", "PL", "PT", "RO",
        "SE", "SI", "SK", "SM", "VA",
    ]

    static func isUs(_ code: String?) -> Bool { code?.uppercased() == "US" }

    static func isBr(_ code: String?) -> Bool { code?.uppercased() == "BR" }

    static func usesIban(_ code: String?) -> Bool {
        guard let code else { return false }
        return ibanCountries.contains(code.uppercased())
    }

    /// The server's jurisdiction for a code, else the built-in one.
    static func find(_ code: String?, _ loaded: [Jurisdiction]?) -> Jurisdiction? {
        guard let wanted = code?.uppercased() else { return nil }
        if let fromServer = loaded?.first(where: { $0.code.uppercased() == wanted }) { return fromServer }
        return builtIn.first(where: { $0.code == wanted })
    }

    /// The VAT/GST percentage a new line starts with; a US line carries a tax code instead.
    static func defaultTaxRate(_ code: String?) -> String {
        guard let code else { return "0" }
        return defaultTaxRates[code.uppercased()] ?? "0"
    }

    /// The country setup starts on: the phone's region when supported, else the Netherlands.
    static func defaultCode(_ locale: Locale = .current) -> String {
        let region = locale.region?.identifier.uppercased()
        return builtIn.first(where: { $0.code == region })?.code ?? "NL"
    }

    /// The fields a company here needs to finalise an invoice: the server's list, else the built-in one, plus the address.
    static func requiredInvoiceFields(_ code: String?, _ loaded: [Jurisdiction]?) -> [String] {
        guard let wanted = code?.uppercased() else { return ["address"] }
        let fromServer = loaded?.first(where: { $0.code.uppercased() == wanted })?.invoiceRequiredFields
        let listed = (fromServer ?? builtInInvoiceFields[wanted] ?? []).filter { invoiceFields.contains($0) }
        var result: [String] = []
        for field in listed + ["address"] where !result.contains(field) { result.append(field) }
        return result
    }

    /// The locale money and dates are shown in: US and Brazilian companies read in their own format.
    static func formatLocale(_ entityLocale: String?, device: Locale = .current) -> Locale {
        guard let tag = entityLocale?.replacingOccurrences(of: "_", with: "-") else { return device }
        if tag.caseInsensitiveCompare("en-US") == .orderedSame { return Locale(identifier: "en_US") }
        if tag.caseInsensitiveCompare("pt-BR") == .orderedSame { return Locale(identifier: "pt_BR") }
        if device.language.languageCode?.identifier == "en", tag.fullyMatches("en-[A-Za-z]{2}") {
            return Locale(identifier: tag.replacingOccurrences(of: "-", with: "_"))
        }
        return device
    }
}

/// The company whose books are open: the one picked before when it still exists, else the default, else the first.
func resolveActiveEntity<T>(_ entities: [T], selectedId: String?, id: (T) -> String, isDefault: (T) -> Bool) -> T? {
    if let selectedId, let picked = entities.first(where: { id($0) == selectedId }) { return picked }
    return entities.first(where: isDefault) ?? entities.first
}
