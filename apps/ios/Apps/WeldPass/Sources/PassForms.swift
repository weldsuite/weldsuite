import Foundation

/// Every field of every item type, flat, so one form edits any of them. The
/// same shape as the platform's `ItemFormValues`
/// (`@weldsuite/app-api-client/schemas/weldpass-items`).
struct ItemFormValues: Equatable {
    var kind: PassItem.Kind
    var vaultID: String
    var title = ""
    var url = ""
    var username = ""
    var password = ""
    var totp = ""
    var notes = ""
    var content = ""
    var cardholder = ""
    var number = ""
    var expiry = ""
    var cvc = ""
    /// A login's Android apps. Carried through an edit: saving sends the
    /// whole item, so a field the form left out would be wiped.
    var apps: [String] = []

    init(kind: PassItem.Kind, vaultID: String) {
        self.kind = kind
        self.vaultID = vaultID
    }

    /// Prefill the form from a revealed item, for editing.
    init(item: PassItem, fields: PassFields) {
        self.init(kind: item.kind, vaultID: item.vaultID)
        title = item.title
        url = item.url ?? ""
        username = fields.username ?? ""
        password = fields.password ?? ""
        totp = fields.totp ?? ""
        notes = fields.notes ?? ""
        content = fields.content ?? ""
        cardholder = fields.cardholder ?? ""
        number = fields.number ?? ""
        expiry = fields.expiry ?? ""
        cvc = fields.cvc ?? ""
        apps = fields.apps
    }
}

/// An item as the API takes it, before it's mapped to the generated type.
/// Only the fields of the item's type are set.
struct PassItemInput: Equatable {
    var kind: PassItem.Kind
    var title: String
    var url: String?
    var fields: PassFields
}

enum Strength {
    case weak, fair, strong
}

enum PassForms {
    static let maxLoginApps = 20

    /// The whole item the API takes. Only the fields of the chosen type are
    /// sent, so a login never carries a stale card number; a login's apps are
    /// left out when there are none, so the sealed text stays as it was.
    static func input(from values: ItemFormValues) -> PassItemInput {
        let title = values.title.trimmingCharacters(in: .whitespacesAndNewlines)
        var fields = PassFields(apps: [])
        switch values.kind {
        case .note:
            fields.content = values.content
            return PassItemInput(kind: .note, title: title, url: nil, fields: fields)
        case .card:
            fields.cardholder = values.cardholder.trimmingCharacters(in: .whitespaces)
            fields.number = values.number.trimmingCharacters(in: .whitespaces)
            fields.expiry = values.expiry.trimmingCharacters(in: .whitespaces)
            fields.cvc = values.cvc.trimmingCharacters(in: .whitespaces)
            fields.notes = values.notes
            return PassItemInput(kind: .card, title: title, url: nil, fields: fields)
        case .login:
            fields.username = values.username
            fields.password = values.password
            fields.totp = values.totp.trimmingCharacters(in: .whitespaces)
            fields.notes = values.notes
            fields.apps = values.apps
            let url = values.url.trimmingCharacters(in: .whitespaces)
            return PassItemInput(kind: .login, title: title, url: url.isEmpty ? nil : url, fields: fields)
        }
    }

    /// Package names typed into a box, one per line (commas and spaces work
    /// too), without blanks or repeats, in the order given.
    static func parseAppList(_ text: String) -> [String] {
        var seen: [String] = []
        for part in text.components(separatedBy: CharacterSet(charactersIn: ",;").union(.whitespacesAndNewlines)) {
            let app = part.trimmingCharacters(in: .whitespaces)
            if !app.isEmpty, !seen.contains(app) { seen.append(app) }
        }
        return seen
    }

    /// The entries that aren't Android package names, for the form's message.
    static func invalidApps(_ apps: [String]) -> [String] {
        apps.filter { $0.range(of: #"^[A-Za-z]\w*(\.[A-Za-z]\w*)+$"#, options: .regularExpression) == nil }
    }

    // MARK: - Strength

    /// The passwords attackers try first. Matched case-insensitively.
    private static let commonPasswords: Set<String> = [
        "123456", "1234567", "12345678", "123456789", "1234567890", "111111", "000000", "123123",
        "password", "password1", "password123", "passw0rd", "p@ssw0rd", "qwerty", "qwerty123",
        "qwertyuiop", "azerty", "abc123", "letmein", "welcome", "welcome1", "welcome123", "admin",
        "admin123", "administrator", "root", "iloveyou", "monkey", "dragon", "football", "baseball",
        "master", "sunshine", "princess", "login", "changeme", "secret", "trustno1", "superman",
        "batman", "starwars", "whatever", "hello123", "freedom", "shadow", "michael", "jennifer",
        "welkom", "welkom01", "welkom123", "wachtwoord", "geheim",
    ]

    /// A rough entropy estimate, in bits: length times the size of the
    /// character pool, except that characters which repeat or continue a run
    /// ("aaaa", "1234") add nothing. The platform's `passwordEntropyBits`.
    static func entropyBits(_ password: String) -> Double {
        guard !password.isEmpty, !commonPasswords.contains(password.lowercased()) else { return 0 }
        let units = Array(password.utf16)
        var pool = 0
        if units.contains(where: { (97...122).contains($0) }) { pool += 26 }
        if units.contains(where: { (65...90).contains($0) }) { pool += 26 }
        if units.contains(where: { (48...57).contains($0) }) { pool += 10 }
        if units.contains(where: { !(97...122).contains($0) && !(65...90).contains($0) && !(48...57).contains($0) }) { pool += 33 }
        var effectiveLength = 0
        for index in units.indices where index == 0 || abs(Int(units[index]) - Int(units[index - 1])) > 1 {
            effectiveLength += 1
        }
        return Double(effectiveLength) * log2(Double(pool))
    }

    static func strength(_ password: String) -> Strength {
        let bits = entropyBits(password)
        if bits < 45 { return .weak }
        if bits < 75 { return .fair }
        return .strong
    }

    // MARK: - Generator

    private static let lower = Array("abcdefghijkmnopqrstuvwxyz")
    private static let upper = Array("ABCDEFGHJKLMNPQRSTUVWXYZ")
    private static let digitSet = Array("23456789")
    private static let symbolSet = Array("!@#$%^&*-_=+?")

    /// A random password from the system's secure generator. Look-alike
    /// characters (l/1/I, O/0) are left out, so it can be read aloud or typed
    /// from a screen, and every chosen class of character appears at least
    /// once. The platform's `generatePassword`.
    static func generatePassword(length: Int = 20, uppercase: Bool = true, digits: Bool = true, symbols: Bool = true) -> String {
        var random = SystemRandomNumberGenerator()
        let size = min(max(length, 8), 128)
        var classes = [lower]
        if uppercase { classes.append(upper) }
        if digits { classes.append(digitSet) }
        if symbols { classes.append(symbolSet) }
        let all = classes.flatMap { $0 }
        var chars = classes.map { $0.randomElement(using: &random)! }
        while chars.count < size { chars.append(all.randomElement(using: &random)!) }
        // Fisher–Yates, so the guaranteed characters aren't always at the front.
        chars.shuffle(using: &random)
        return String(chars)
    }
}
