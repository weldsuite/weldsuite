import Foundation

// Small text helpers the Kotlin code gets from its standard library
// (`ifBlank { null }`, `isNullOrBlank()`, `Regex.matches`). Shared by the
// logic and the screens: don't declare these names again in another file.

extension String {
    /// Without leading and trailing whitespace (Kotlin `trim()`).
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }

    /// Empty or only whitespace (Kotlin `isBlank()`).
    var isBlank: Bool { trimmed.isEmpty }

    /// Nil when blank, else the text as it is (Kotlin `ifBlank { null }`).
    var nilIfBlank: String? { isBlank ? nil : self }

    /// `fallback` when blank, else the text as it is (Kotlin `ifBlank { fallback }`).
    func orIfBlank(_ fallback: String) -> String { isBlank ? fallback : self }

    /// Nil when empty, else the text as it is (Kotlin `ifEmpty { null }`).
    var nilIfEmpty: String? { isEmpty ? nil : self }

    /// The whole text matches `pattern` (an ICU regular expression, Kotlin `Regex.matches`).
    func fullyMatches(_ pattern: String, ignoringCase: Bool = false) -> Bool {
        var options: String.CompareOptions = [.regularExpression]
        if ignoringCase { options.insert(.caseInsensitive) }
        return range(of: "^(?:\(pattern))$", options: options) != nil
    }

    /// Somewhere in the text matches `pattern` (Kotlin `Regex.containsMatchIn`).
    func containsMatch(_ pattern: String, ignoringCase: Bool = false) -> Bool {
        var options: String.CompareOptions = [.regularExpression]
        if ignoringCase { options.insert(.caseInsensitive) }
        return range(of: pattern, options: options) != nil
    }

    /// The capture groups of the first match of `pattern` (index 0 is the whole match); nil without a match.
    /// A group that took no part in the match is an empty string.
    func firstMatchGroups(_ pattern: String) -> [String]? {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return nil }
        let whole = NSRange(startIndex..<endIndex, in: self)
        guard let match = regex.firstMatch(in: self, range: whole) else { return nil }
        return (0..<match.numberOfRanges).map { index in
            let range = match.range(at: index)
            guard range.location != NSNotFound, let swiftRange = Range(range, in: self) else { return "" }
            return String(self[swiftRange])
        }
    }

    /// The first `count` characters (Kotlin `take`).
    func take(_ count: Int) -> String { String(prefix(max(count, 0))) }

    /// Without the first `count` characters (Kotlin `drop`).
    func dropping(_ count: Int) -> String { String(dropFirst(max(count, 0))) }

    /// Characters `from` up to (not including) `to`, clamped to the text.
    func slice(_ from: Int, _ to: Int) -> String {
        let characters = Array(self)
        let lower = min(max(from, 0), characters.count)
        let upper = min(max(to, lower), characters.count)
        return String(characters[lower..<upper])
    }

    /// The first character upper-cased (Kotlin `replaceFirstChar { it.uppercase() }`).
    var capitalizedFirst: String {
        guard let initial = self.first else { return self }
        return initial.uppercased() + String(dropFirst())
    }
}

extension Optional where Wrapped == String {
    /// Nil, empty or only whitespace (Kotlin `isNullOrBlank()`).
    var isNullOrBlank: Bool { self?.isBlank ?? true }

    /// The text, or "" for nil (Kotlin `orEmpty()`).
    var orEmpty: String { self ?? "" }
}
