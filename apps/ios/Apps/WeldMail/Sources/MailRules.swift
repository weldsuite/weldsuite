import Foundation
import WeldCore

/// The search screen's filters. The folder, attachments and read state go to
/// the server with the query; "from me", "to me" and the date are applied to
/// the results on the phone.
struct SearchFilters: Equatable {
    var label: String?
    var fromMe: Bool?
    var toMe: Bool?
    var attachment: Bool?
    var date: SearchLogic.DateRange?
    var unread: Bool?

    var isActive: Bool {
        label != nil || fromMe != nil || toMe != nil || attachment != nil || date != nil || unread != nil
    }
}

enum SearchLogic {
    enum DateRange: CaseIterable {
        case today, yesterday, thisWeek, thisMonth, thisYear
    }

    /// The folders the Label filter offers, as the Expo app lists them.
    static let labels: [SystemLabel] = [.starred, .scheduled, .important, .sent, .snoozed, .drafts, .all, .archive, .trash]

    /// The phone-side filters applied to a page of results.
    static func apply(
        _ messages: [MailMessage],
        filters: SearchFilters,
        own: [String],
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> [MailMessage] {
        let mine = Set(own.map { $0.lowercased() })
        return messages.filter { message in
            let fromMe = mine.contains((message.from?.email ?? "").lowercased())
            let toMe = message.to.contains { mine.contains($0.email.lowercased()) } || message.cc.contains { mine.contains($0.email.lowercased()) }
            if let wanted = filters.fromMe, wanted != fromMe { return false }
            if let wanted = filters.toMe, wanted != toMe { return false }
            if let wanted = filters.attachment, wanted != message.hasAttachments { return false }
            if let wanted = filters.unread, wanted != !message.isRead { return false }
            if let range = filters.date, !inRange(message.listDate, range, now: now, calendar: calendar) { return false }
            return true
        }
    }

    /// Whether a message's date falls in a range of days on the phone's calendar (weeks start on Monday).
    static func inRange(_ date: String, _ range: DateRange, now: Date, calendar: Calendar) -> Bool {
        guard let at = WeldDate.parse(date) else { return false }
        let day = calendar.startOfDay(for: at)
        let today = calendar.startOfDay(for: now)
        let start: Date
        switch range {
        case .today:
            start = today
        case .yesterday:
            start = calendar.date(byAdding: .day, value: -1, to: today) ?? today
        case .thisWeek:
            let sinceMonday = (calendar.component(.weekday, from: today) + 5) % 7
            start = calendar.date(byAdding: .day, value: -sinceMonday, to: today) ?? today
        case .thisMonth:
            start = calendar.date(from: calendar.dateComponents([.year, .month], from: today)) ?? today
        case .thisYear:
            start = calendar.date(from: calendar.dateComponents([.year], from: today)) ?? today
        }
        let end = range == .yesterday ? start : today
        return day >= start && day <= end
    }

    /// Where the query occurs in the text, case ignored, without overlaps.
    static func matches(_ text: String, _ query: String) -> [Range<String.Index>] {
        let needle = query.trimmingCharacters(in: .whitespaces)
        guard !needle.isEmpty, !text.isEmpty else { return [] }
        var ranges: [Range<String.Index>] = []
        var from = text.startIndex
        while from < text.endIndex, let found = text.range(of: needle, options: .caseInsensitive, range: from..<text.endIndex) {
            ranges.append(found)
            from = found.upperBound
        }
        return ranges
    }
}

/// The contact card's rules: which field shows what, and what an edit changes.
enum ContactLogic {
    enum Field: String, CaseIterable, Identifiable {
        case domains, name, description, team, email, phone, address
        var id: String { rawValue }
    }

    /// What an edit sends: only the field that changed (nil: unchanged).
    struct Change: Equatable {
        var firstName: String?
        var lastName: String?
        var email: String?
        var phone: String?
        var notes: String?
        var department: String?
        var linkedinURL: String?
    }

    static func isEmail(_ value: String) -> Bool {
        value.trimmingCharacters(in: .whitespaces)
            .range(of: "^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}$", options: .regularExpression) != nil
    }

    /// Only digits and `+`: a sender wrote this, so nothing else goes into a `tel:` link.
    static func dialable(_ phone: String) -> String { phone.filter { $0.isASCII && ($0.isNumber || $0 == "+") } }

    static func displayName(_ person: MailContact) -> String { person.name ?? person.email ?? "?" }

    /// The search matches names and addresses anywhere; only the exact address is this sender.
    static func exactMatch(_ people: [MailContact], email: String) -> MailContact? {
        let wanted = email.trimmingCharacters(in: .whitespaces).lowercased()
        return people.first { $0.email?.trimmingCharacters(in: .whitespaces).lowercased() == wanted }
    }

    /// A sender who isn't a contact: shown from the address, not editable.
    static func placeholder(_ email: String) -> MailContact {
        let local = email.split(separator: "@", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? email
        return MailContact(id: email, email: email, firstName: local)
    }

    static func value(_ person: MailContact, _ field: Field) -> String? {
        let value: String?
        switch field {
        case .domains: value = person.linkedinURL
        case .name: value = person.name
        case .description: value = person.notes
        case .team: value = person.department
        case .email: value = person.email
        case .phone: value = person.phone
        case .address: value = person.bestTimeToContact
        }
        guard let value, !value.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
        return value
    }

    /// A name splits at its first space: "Ada King Lovelace" → "Ada", "King Lovelace".
    static func change(_ field: Field, _ value: String) -> Change {
        switch field {
        case .name:
            let parts = value.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: false)
            let first = parts.first.map(String.init) ?? value
            let last = parts.count > 1 ? String(parts[1]) : ""
            return Change(firstName: first, lastName: last)
        case .email: return Change(email: value)
        case .phone: return Change(phone: value)
        case .description: return Change(notes: value)
        case .team: return Change(department: value)
        case .domains: return Change(linkedinURL: value)
        case .address: return Change()
        }
    }
}

/// The new-mailbox form's rules.
enum AddAccountLogic {
    /// What the availability check said.
    enum Check: Equatable {
        case available
        /// `reserved`, `taken`, or nil when the check failed.
        case unavailable(String?)
    }

    static func check(_ availability: Availability) -> Check {
        availability.available ? .available : .unavailable(availability.reason ?? "taken")
    }

    /// What an address may hold: lower-case letters, digits, dots, dashes and underscores.
    static func cleanAddress(_ input: String) -> String {
        String(input.lowercased().filter { ($0.isASCII && ($0.isLetter || $0.isNumber)) || $0 == "." || $0 == "_" || $0 == "-" })
    }
}

/// Where a `weldmail://` link goes: `message/<id>`, `compose?to=…&subject=…`,
/// `search`, `settings`, `subscriptions` (the Expo app's links).
enum MailLinkRoute: Equatable {
    case message(String)
    case compose(to: [String], subject: String)
    case search
    case settings
    case subscriptions

    static func of(_ url: URL) -> MailLinkRoute? {
        guard url.scheme?.lowercased() == "weldmail" else { return nil }
        let parts = URLComponents(url: url, resolvingAgainstBaseURL: false)
        let query = { (name: String) in parts?.queryItems?.first { $0.name == name }?.value ?? "" }
        switch url.host?.lowercased() {
        case "message":
            return MailLogic.safeID(url.pathComponents.first { $0 != "/" }).map { .message($0) }
        case "compose":
            return .compose(to: MailLogic.splitAddresses(query("to")), subject: query("subject"))
        case "search":
            return .search
        case "settings":
            return .settings
        case "subscriptions":
            return .subscriptions
        default:
            return nil
        }
    }
}
