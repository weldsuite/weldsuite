import Foundation
import WeldCore

// The rules the screens apply before asking the server, the same as the
// Android app's HrLogic.kt and the Expo app's lib/: calendar days, shifts and
// the hours clocked on them, leave, open shifts, announcements, the expense
// filter and search, receipts, and where a push leads. Pure, so they are
// unit tested.

/// Calendar days as WeldHR sends them: `yyyy-MM-dd` in the workspace's calendar, never instants.
enum HRDays {
    static var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        calendar.firstWeekday = 2
        calendar.minimumDaysInFirstWeek = 4
        return calendar
    }

    private static func formatter(_ zone: TimeZone) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = zone
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }

    /// A strict `yyyy-MM-dd` day as midnight on the phone's calendar; nil for anything else.
    static func parse(_ iso: String?, zone: TimeZone = .current) -> Date? {
        guard let iso, iso.count == 10, iso.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil else { return nil }
        let formatter = formatter(zone)
        guard let date = formatter.date(from: iso), formatter.string(from: date) == iso else { return nil }
        return date
    }

    static func string(_ date: Date, zone: TimeZone = .current) -> String {
        formatter(zone).string(from: date)
    }

    static func today(zone: TimeZone = .current) -> String { string(Date(), zone: zone) }

    private static func cal(_ zone: TimeZone) -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        calendar.firstWeekday = 2
        calendar.minimumDaysInFirstWeek = 4
        return calendar
    }

    static func add(_ iso: String, _ days: Int, zone: TimeZone = .current) -> String {
        guard let date = parse(iso, zone: zone), let moved = cal(zone).date(byAdding: .day, value: days, to: date) else { return iso }
        return string(moved, zone: zone)
    }

    static func isWeekend(_ iso: String, zone: TimeZone = .current) -> Bool {
        guard let date = parse(iso, zone: zone) else { return false }
        let weekday = cal(zone).component(.weekday, from: date)
        return weekday == 1 || weekday == 7
    }

    /// The first Monday to Friday after `iso`.
    static func nextWeekday(_ iso: String, zone: TimeZone = .current) -> String {
        var day = add(iso, 1, zone: zone)
        while isWeekend(day, zone: zone) { day = add(day, 1, zone: zone) }
        return day
    }

    /// Monday to Friday days from `start` to `end`, inclusive: the estimate shown while filling in a request.
    static func weekdaysBetween(_ start: String, _ end: String, zone: TimeZone = .current) -> Int {
        guard parse(start, zone: zone) != nil, parse(end, zone: zone) != nil, end >= start else { return 0 }
        var count = 0
        var day = start
        while day <= end {
            if !isWeekend(day, zone: zone) { count += 1 }
            day = add(day, 1, zone: zone)
        }
        return count
    }

    /// The Monday of the week `iso` falls in.
    static func startOfWeek(_ iso: String, zone: TimeZone = .current) -> String {
        guard let date = parse(iso, zone: zone) else { return iso }
        let weekday = cal(zone).component(.weekday, from: date)
        return add(iso, -((weekday + 5) % 7), zone: zone)
    }

    /// The ISO 8601 week number ("Week 43").
    static func isoWeek(_ iso: String, zone: TimeZone = .current) -> Int {
        guard let date = parse(iso, zone: zone) else { return 0 }
        var calendar = Calendar(identifier: .iso8601)
        calendar.timeZone = zone
        return calendar.component(.weekOfYear, from: date)
    }

    /// The local calendar day of a timestamp (a shift's start), or its date part when it does not parse.
    static func dayOf(_ timestamp: String, zone: TimeZone = .current) -> String {
        if parse(timestamp, zone: zone) != nil { return timestamp }
        guard let date = WeldDate.parse(timestamp) else { return String(timestamp.prefix(10)) }
        return string(date, zone: zone)
    }
}

/// Shifts and the hours clocked on them (the Expo app's lib/shifts.ts).
enum ShiftMath {
    /// The currency for "€ 0,00" when nothing carries one.
    static let defaultCurrency = "EUR"

    private static func millis(_ iso: String?) -> Double? {
        guard let date = WeldDate.parse(iso) else { return nil }
        return date.timeIntervalSince1970 * 1000
    }

    static func isOpen(_ record: HRClockRecord) -> Bool { record.clockIn != nil && record.clockOut == nil }

    static func byClockIn(_ records: [HRClockRecord]) -> [HRClockRecord] {
        records.sorted { ($0.clockIn ?? "") < ($1.clockIn ?? "") }
    }

    /// Whole minutes between two timestamps.
    static func minutesBetween(_ start: String?, _ end: String?) -> Int {
        guard let from = millis(start), let to = millis(end) else { return 0 }
        return max(0, Int(((to - from) / 60_000).rounded()))
    }

    /// A record's minutes: what it worked, or so far for one still running. `now` in milliseconds.
    static func minutesOf(_ record: HRClockRecord, now: Double) -> Double {
        if let worked = record.workedMinutes { return Double(worked) }
        if let start = millis(record.clockIn), record.clockOut == nil { return max(0, (now - start) / 60_000) }
        return 0
    }

    static func plannedBreak(_ shift: HRShift) -> (String, String)? {
        guard let start = shift.breakStartsAt, let end = shift.breakEndsAt else { return nil }
        return (start, end)
    }

    /// A shift's planned minutes, its break left out (breaks are unpaid).
    static func plannedMinutes(startsAt: String, endsAt: String, breakStartsAt: String?, breakEndsAt: String?) -> Int {
        var pause = 0
        if let breakStartsAt, let breakEndsAt { pause = minutesBetween(breakStartsAt, breakEndsAt) }
        return max(0, minutesBetween(startsAt, endsAt) - pause)
    }

    static func plannedMinutes(_ shift: HRShift) -> Int {
        plannedMinutes(startsAt: shift.startsAt, endsAt: shift.endsAt, breakStartsAt: shift.breakStartsAt, breakEndsAt: shift.breakEndsAt)
    }

    /// The shift a record was clocked on: the one it is linked to, or one that day its hours overlap.
    static func shiftOf(_ record: HRClockRecord, shifts: [HRShift], now: Double, zone: TimeZone = .current) -> HRShift? {
        if let id = record.shiftId { return shifts.first { $0.id == id } }
        guard let start = millis(record.clockIn) else { return nil }
        let end = millis(record.clockOut) ?? now
        return shifts.first { shift in
            guard let shiftStart = millis(shift.startsAt), let shiftEnd = millis(shift.endsAt) else { return false }
            return HRDays.dayOf(shift.startsAt, zone: zone) == record.date && shiftStart < end && shiftEnd > start
        }
    }

    /// The gaps between one clocked stretch and the next; under a minute is a slip of the finger.
    static func clockedOutGaps(_ records: [HRClockRecord]) -> [(String, String)] {
        let stretches = byClockIn(records.filter { $0.clockIn != nil })
        var gaps: [(String, String)] = []
        guard stretches.count > 1 else { return gaps }
        for index in 1 ..< stretches.count {
            if let before = stretches[index - 1].clockOut, let after = stretches[index].clockIn, minutesBetween(before, after) >= 1 {
                gaps.append((before, after))
            }
        }
        return gaps
    }

    /// What `records` earn at their own hourly rates, per currency; nothing set up is 0 in `fallback`.
    static func earnings(_ records: [HRClockRecord], now: Double, fallback: String) -> [(String, Double)] {
        var order: [String] = []
        var sums: [String: Double] = [:]
        for record in records {
            guard let rate = record.hourlyRate, let currency = record.currency else { continue }
            if sums[currency] == nil { order.append(currency) }
            sums[currency, default: 0] += minutesOf(record, now: now) / 60 * rate
        }
        if order.isEmpty { return [(fallback, 0)] }
        return order.map { ($0, sums[$0] ?? 0) }
    }

    /// "7:45" for worked minutes.
    static func duration(_ minutes: Double) -> String {
        let total = max(0, Int(minutes.rounded()))
        return "\(total / 60):" + String(format: "%02d", total % 60)
    }

    static func hoursAndMinutes(_ minutes: Double) -> (Int, Int) {
        let total = max(0, Int(minutes.rounded()))
        return (total / 60, total % 60)
    }

    /// A running clock, "01:02:08", from milliseconds.
    static func timer(_ millis: Double) -> String {
        let seconds = max(0, Int(millis / 1000))
        return String(format: "%02d:%02d:%02d", seconds / 3600, seconds / 60 % 60, seconds % 60)
    }
}

/// Leave rules, mirroring hr-api so a button only shows when the action can work.
enum LeaveRules {
    enum Allowance: Equatable {
        case ok
        case over(remaining: Double, blocked: Bool)

        /// The days left and whether the type blocks going over; nil when it fits.
        var excess: (remaining: Double, blocked: Bool)? {
            if case let .over(remaining, blocked) = self { return (remaining, blocked) }
            return nil
        }
    }

    /// Upcoming and pending first (soonest at the top), then the past, newest first.
    static func sortRequests(_ requests: [HRLeaveRequest], today: String) -> [HRLeaveRequest] {
        let isCurrent = { (request: HRLeaveRequest) in request.status == "pending" || request.endDate >= today }
        let current = requests.filter(isCurrent).sorted { $0.startDate < $1.startDate }
        let past = requests.filter { !isCurrent($0) }.sorted { $0.startDate > $1.startDate }
        return current + past
    }

    /// A pending request, or approved leave that has not started yet.
    static func canCancel(_ request: HRLeaveRequest, today: String) -> Bool {
        request.status == "pending" || (request.status == "approved" && request.startDate > today)
    }

    /// The balance for leave starting on `startDate`: this year's balances only cover this year.
    static func balanceForStart(_ balances: [HRLeaveBalance], leaveTypeId: String?, startDate: String, today: String) -> HRLeaveBalance? {
        guard startDate.prefix(4) == today.prefix(4) else { return nil }
        return balances.first { $0.leaveTypeId == leaveTypeId }
    }

    static func checkAllowance(_ balance: HRLeaveBalance?, days: Int) -> Allowance {
        guard let balance, let remaining = balance.remaining, Double(days) > remaining else { return .ok }
        return .over(remaining: max(0, remaining), blocked: balance.overAllowance == "block")
    }

    /// The day's planned minutes the leave takes off: all of them, or a share for a half day.
    static func minutesOff(_ request: HRLeaveRequest, planned: Int) -> Double {
        request.startDate == request.endDate && request.days < 1 ? Double(planned) * request.days : Double(planned)
    }
}

/// Where an open shift stands for the caller.
enum Standing: Equatable {
    case open, waiting, declined, full
}

enum OpenShiftRules {
    static func standingOf(_ shift: HROpenShift) -> Standing {
        switch shift.myRequest?.status {
        case "pending": return .waiting
        case "rejected": return .declined
        default: return shift.spotsLeft > 0 ? .open : .full
        }
    }

    private static func start(_ shift: HROpenShift) -> Double {
        (WeldDate.parse(shift.startsAt)?.timeIntervalSince1970 ?? 0) * 1000
    }

    /// A spot left, not started, and no sign-up waiting (a declined or withdrawn one may be tried again).
    static func canSignUp(_ shift: HROpenShift, now: Double) -> Bool {
        start(shift) > now && shift.spotsLeft > 0 && shift.myRequest?.status != "pending"
    }

    /// Not started, soonest first; a full one only while the caller's sign-up waits or was declined.
    static func listable(_ shifts: [HROpenShift], now: Double) -> [HROpenShift] {
        shifts
            .filter { start($0) > now }
            .filter { $0.myRequest?.status != "approved" }
            .filter { $0.spotsLeft > 0 || standingOf($0) == .waiting || standingOf($0) == .declined }
            .sorted { $0.startsAt < $1.startsAt }
    }
}

/// How long ago an announcement was published; the words come from the strings.
enum Age: Equatable {
    case now
    case minutes(Int)
    case hours(Int)
    case yesterday
    case days(Int)
    /// A week or more: show the date.
    case date
}

enum AnnouncementRules {
    /// Pinned first, then the newest.
    static func sort(_ list: [HRAnnouncement]) -> [HRAnnouncement] {
        list.sorted { a, b in
            if a.pinned != b.pinned { return a.pinned }
            return (WeldDate.parse(a.publishedAt) ?? .distantPast) > (WeldDate.parse(b.publishedAt) ?? .distantPast)
        }
    }

    /// The body on one line for a list row.
    static func preview(_ body: String, max: Int = 140) -> String {
        let flat = body.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).joined(separator: " ")
        guard flat.count > max else { return flat }
        let cut = String(flat.prefix(max))
        return cut.trimmingCharacters(in: .whitespaces) + "…"
    }

    static func ageOf(_ publishedAt: String, now: Date = Date(), zone: TimeZone = .current) -> Age {
        guard let published = WeldDate.parse(publishedAt) else { return .now }
        let minutes = Int(floor(now.timeIntervalSince(published) / 60))
        if minutes < 1 { return .now }
        if minutes < 60 { return .minutes(minutes) }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: published), to: calendar.startOfDay(for: now)).day ?? 0
        if days < 1 { return .hours(minutes / 60) }
        if days == 1 { return .yesterday }
        if days < 7 { return .days(days) }
        return .date
    }
}

/// A switch per status (own claims) or category (claims to approve); what is switched off is hidden.
struct ExpenseFilter: Equatable {
    var statuses: Set<String> = []
    var categories: Set<String> = []

    static let allStatuses = ["pending", "approved", "paid", "rejected", "cancelled"]
    static let allCategories = ["travel", "meals", "accommodation", "equipment", "training", "other"]

    var isActive: Bool { !statuses.isEmpty || !categories.isEmpty }

    func passes(_ row: HRDeclaration) -> Bool {
        !statuses.contains(row.status) && !categories.contains(row.category)
    }

    /// The statuses to offer: the ones the list has, plus the ones switched off.
    static func statusChoices(_ rows: [HRDeclaration], filter: ExpenseFilter) -> [String] {
        allStatuses.filter { status in filter.statuses.contains(status) || rows.contains { $0.status == status } }
    }

    static func categoryChoices(_ rows: [HRDeclaration], filter: ExpenseFilter) -> [String] {
        allCategories.filter { category in filter.categories.contains(category) || rows.contains { $0.category == category } }
    }
}

/// Search as you type: case and accents do not matter, and every word has to appear in one of the fields.
enum HRSearch {
    static func normalize(_ text: String) -> String {
        text.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: Locale(identifier: "en_US_POSIX"))
            .lowercased()
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func matches(_ query: String, _ fields: [String?]) -> Bool {
        let words = normalize(query).split(whereSeparator: { $0.isWhitespace }).map(String.init)
        if words.isEmpty { return true }
        let haystack = fields.compactMap { $0 }.map(normalize).joined(separator: "\n")
        return words.allSatisfy { haystack.contains($0) }
    }
}

/// Receipts: one image or PDF per claim, at most 10 MB.
enum Receipts {
    static let maxBytes = 10 * 1024 * 1024
    static let types = ["image/jpeg", "image/png", "image/webp", "application/pdf"]

    enum Problem: Equatable { case type, size }

    static func guessType(_ name: String) -> String? {
        let base = name.split(separator: "?").first.map(String.init) ?? name
        switch (base as NSString).pathExtension.lowercased() {
        case "jpg", "jpeg": return "image/jpeg"
        case "png": return "image/png"
        case "webp": return "image/webp"
        case "pdf": return "application/pdf"
        default: return nil
        }
    }

    static func problem(mimeType: String?, size: Int?) -> Problem? {
        guard let type = mimeType?.lowercased(), types.contains(type) else { return .type }
        if let size, size > maxBytes { return .size }
        return nil
    }

    /// `receipt-2026-11-27.jpg` when the picker gives no name.
    static func fileName(_ given: String?, mimeType: String, today: String) -> String {
        if let given = given?.trimmingCharacters(in: .whitespaces), !given.isEmpty { return given }
        let ext = mimeType == "application/pdf" ? "pdf" : (mimeType.split(separator: "/").last.map(String.init) ?? "jpg").replacingOccurrences(of: "jpeg", with: "jpg")
        return "receipt-\(today).\(ext)"
    }

    /// A file name that is safe on disk: no separators, control characters or leading dots.
    static func safeFileName(_ name: String) -> String {
        let forbidden = CharacterSet(charactersIn: "/\\:*?\"<>|").union(.controlCharacters)
        var cleaned = String(name.unicodeScalars.map { forbidden.contains($0) ? "_" : Character($0) })
        while cleaned.hasPrefix(".") { cleaned.removeFirst() }
        cleaned = String(cleaned.trimmingCharacters(in: .whitespaces).prefix(120))
        return cleaned.isEmpty ? "document.pdf" : cleaned
    }
}

/// What someone typed as an amount: "12,50", "12.5", "1.234,56" → 12.5 / 1234.56; nil when not above zero.
func parseAmount(_ input: String) -> Double? {
    let cleaned = input.filter { $0.isNumber || $0 == "." || $0 == "," || $0 == "-" }
    guard !cleaned.isEmpty else { return nil }
    let lastComma = cleaned.lastIndex(of: ",")
    let lastDot = cleaned.lastIndex(of: ".")
    let decimalIsComma: Bool
    switch (lastComma, lastDot) {
    case let (comma?, dot?): decimalIsComma = comma > dot
    case (.some, nil): decimalIsComma = true
    default: decimalIsComma = false
    }
    let thousands: Character = decimalIsComma ? "." : ","
    let normalized = cleaned.filter { $0 != thousands }.replacingOccurrences(of: decimalIsComma ? "," : ".", with: ".")
    guard let value = Double(normalized), value.isFinite, value > 0 else { return nil }
    return (value * 100).rounded() / 100
}

/// The tasks per checklist, open ones first, then by due date.
func groupTasks(_ tasks: [HRTask]) -> [(String, [HRTask])] {
    var order: [String] = []
    var groups: [String: [HRTask]] = [:]
    for task in tasks {
        if groups[task.checklistName] == nil { order.append(task.checklistName) }
        groups[task.checklistName, default: []].append(task)
    }
    return order.map { name in
        let list = (groups[name] ?? []).sorted { a, b in
            let aDone = a.completedAt != nil
            let bDone = b.completedAt != nil
            if aDone != bDone { return !aDone }
            return (a.dueDate ?? "9") < (b.dueDate ?? "9")
        }
        return (name, list)
    }
}

/// A screen a push or a deep link leads to.
enum HRTarget: Hashable {
    case announcements
    case announcement(String)
    case leave(String)
    case expense(String)
    case sickReport(String)
    case schedule
    case absence
    case expenses
    case pay
    case tasks
    case reviews
}

enum HRRoutes {
    /// Where a tapped push leads: announcements by `notificationType`, else the app's own `route`.
    static func forPush(_ values: [String: String]) -> HRTarget? {
        if values["notificationType"] == "hr_announcement" {
            if let id = values["announcementId"], !id.isEmpty { return .announcement(id) }
            return .announcements
        }
        return values["route"].flatMap(forPath)
    }

    /// `/announcement/ann_1`, `weldhr://leave/lr_1`, `/expenses`, …
    static func forPath(_ path: String) -> HRTarget? {
        let withoutScheme = path.range(of: "://").map { String(path[$0.upperBound...]) } ?? path
        let beforeQuery = withoutScheme.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? withoutScheme
        let parts = beforeQuery.split(separator: "/").map(String.init)
        let id = parts.count > 1 ? (parts[1].removingPercentEncoding ?? parts[1]) : nil
        switch parts.first {
        case "announcements": return .announcements
        case "announcement": return id.map { .announcement($0) } ?? .announcements
        case "leave": return id.map { .leave($0) } ?? .absence
        case "expense": return id.map { .expense($0) } ?? .expenses
        case "sick": return id.map { .sickReport($0) } ?? .absence
        case "schedule": return .schedule
        case "absence": return .absence
        case "expenses": return .expenses
        case "pay": return .pay
        case "tasks": return .tasks
        case "reviews": return .reviews
        default: return nil
        }
    }
}

/// The web platform's badge variants (`@weldsuite/ui` Badge): `primary` is its `default`, the primary
/// fill, `secondary` the neutral fill, `destructive` red, `outline` a border with foreground text.
enum Tone: Equatable {
    case primary, secondary, destructive, outline

    /// The variant WeldHR gives a status on the platform (`STATUS_TONE` in app/weldhr/components/shared.tsx).
    static func of(_ status: String) -> Tone {
        switch status {
        case "active", "present", "approved", "acknowledged", "achieved", "completed": .primary
        case "onboarding", "offboarding", "late", "pending", "ongoing", "open", "submitted", "in_progress", "invited": .outline
        case "terminated", "absent", "rejected", "missed", "revoked": .destructive
        default: .secondary
        }
    }
}

/// The platform's colours for shifts and leave types (app/weldhr/attendance/components/schedule-model.ts).
enum Swatches {
    /// WeldCalendar's default blue: a shift without a client account.
    static let defaultShift: UInt32 = 0x3B82F6
    /// The dot of a leave type without a colour of its own (the platform's `ColorDot`, slate-400).
    static let neutralDot: UInt32 = 0x94A3B8
    /// WeldCalendar's palette minus the default blue: one colour per client account.
    static let client: [UInt32] = [0x22C55E, 0x14B8A6, 0x8B5CF6, 0xF59E0B, 0xEC4899, 0x06B6D4, 0xF97316, 0x6366F1, 0xEF4444]

    /// The platform's `shiftColor` hash (`hash * 31 + code point`, mod 9973).
    static func hash(_ key: String) -> Int {
        var value = 0
        for scalar in key.unicodeScalars { value = (value * 31 + Int(scalar.value)) % 9973 }
        return value
    }

    /// A shift's colour by its client; the default blue without one.
    static func shiftColor(_ client: String?) -> UInt32 {
        guard let client, !client.isEmpty else { return defaultShift }
        return Swatches.client[hash(client) % Swatches.client.count]
    }

    /// A leave type's dot: the colour HR picked, else the neutral grey.
    static func dot(_ color: String?) -> UInt32 { hex(color) ?? neutralDot }

    /// The colour band of an evaluation score (0-100), as the platform's `ScoreBadge`.
    static func scoreBand(_ score: Double) -> Int {
        if score >= 85 { return 0 }
        if score >= 70 { return 1 }
        if score >= 55 { return 2 }
        return 3
    }

    /// A `#rgb` / `#rrggbb` colour; nil when it is not hex.
    static func hex(_ color: String?) -> UInt32? {
        guard var text = color?.trimmingCharacters(in: .whitespaces) else { return nil }
        if text.hasPrefix("#") { text.removeFirst() }
        guard text.range(of: #"^([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$"#, options: .regularExpression) != nil else { return nil }
        if text.count == 3 { text = text.map { "\($0)\($0)" }.joined() }
        return UInt32(text, radix: 16)
    }

    /// Whether dark text reads better than white on `rgb`.
    static func prefersDarkText(_ rgb: UInt32) -> Bool {
        func channel(_ shift: UInt32) -> Double {
            let s = Double((rgb >> shift) & 0xFF) / 255
            return s <= 0.03928 ? s / 12.92 : pow((s + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0) > 0.45
    }
}
