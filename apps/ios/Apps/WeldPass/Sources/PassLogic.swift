import Foundation

/// WeldPass's list rules, the same as the platform's, the Android app's and
/// the React Native app's (`@weldsuite/app-api-client/schemas/weldpass-items`).
enum PassLogic {
    /// Personal vault first, then shared vaults by name.
    static func sortVaults(_ vaults: [PassVault]) -> [PassVault] {
        vaults.sorted { a, b in
            if a.kind != b.kind { return a.kind == .personal }
            return a.name.localizedStandardCompare(b.name) == .orderedAscending
        }
    }

    /// The visible items, sorted by title. Every word of `query` has to match
    /// somewhere in the title, username, site or URL: never a secret.
    static func filterItems(_ items: [PassItem], query: String, kind: PassItem.Kind? = nil, vaultID: String? = nil) -> [PassItem] {
        let words = query.lowercased().split(whereSeparator: \.isWhitespace).map(String.init)
        return items
            .filter { item in
                if let vaultID, item.vaultID != vaultID { return false }
                if let kind, item.kind != kind { return false }
                if words.isEmpty { return true }
                let haystack = [item.title, item.subtitle, item.url, item.host]
                    .compactMap { $0 }
                    .joined(separator: " ")
                    .lowercased()
                return words.allSatisfy { haystack.contains($0) }
            }
            .sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
    }

    /// Editor and manager can add, change, move and delete items.
    static func canEdit(_ vault: PassVault?) -> Bool {
        vault?.role == .editor || vault?.role == .manager
    }

    /// An admin looking at a shared vault they are not in: no items, only settings.
    static func isNonMemberView(_ vault: PassVault?) -> Bool {
        guard let vault else { return false }
        return vault.role == nil
    }

    /// "123456" → "123 456"; other lengths split in the middle.
    static func formatTotpCode(_ code: String) -> String {
        guard code.count >= 4 else { return code }
        let half = (code.count + 1) / 2
        let index = code.index(code.startIndex, offsetBy: half)
        return "\(code[..<index]) \(code[index...])"
    }

    /// Whole seconds until `expiresAt`, never negative. 0 when it doesn't parse.
    static func secondsUntil(_ expiresAt: String, now: Date = Date()) -> Int {
        guard let expires = parseDate(expiresAt) else { return 0 }
        let left = expires.timeIntervalSince(now)
        return left <= 0 ? 0 : Int(left.rounded(.up))
    }

    /// A link target for an item's URL. A stored URL may lack a scheme
    /// ("example.com/login"); anything not http(s) is refused, so a saved
    /// `javascript:` URL never becomes a link.
    static func safeHref(_ url: String?) -> URL? {
        guard let trimmed = url?.trimmingCharacters(in: .whitespaces), !trimmed.isEmpty else { return nil }
        let hasScheme = trimmed.range(of: "^[a-zA-Z][a-zA-Z0-9+.-]*://", options: .regularExpression) != nil
        guard let parsed = URL(string: hasScheme ? trimmed : "https://\(trimmed)"),
              let scheme = parsed.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = parsed.host, !host.isEmpty
        else { return nil }
        return parsed
    }

    /// An ISO 8601 timestamp from the server, with or without fractional seconds.
    static func parseDate(_ text: String) -> Date? {
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFraction.date(from: text) { return date }
        return ISO8601DateFormatter().date(from: text)
    }
}
