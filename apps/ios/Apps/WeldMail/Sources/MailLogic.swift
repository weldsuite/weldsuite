import Foundation
import WeldCore

/// A system folder: its slug as the server labels messages.
enum SystemLabel: String, CaseIterable, Identifiable {
    case inbox = "INBOX"
    case promotions = "PROMOTIONS"
    case starred = "STARRED"
    case sent = "SENT"
    case drafts = "DRAFTS"
    case scheduled = "SCHEDULED"
    case snoozed = "SNOOZED"
    case important = "IMPORTANT"
    case all = "ALL"
    case archive = "ARCHIVE"
    case spam = "SPAM"
    case trash = "TRASH"

    var id: String { rawValue }
    var slug: String { rawValue }

    /// Shown first in the mailbox menu.
    static let main: [SystemLabel] = [.inbox, .promotions, .starred, .sent, .drafts]

    /// Behind "More".
    static let secondary: [SystemLabel] = [.scheduled, .snoozed, .important, .all, .archive, .spam, .trash]

    static func of(_ slug: String) -> SystemLabel? { SystemLabel(rawValue: slug.uppercased()) }
}

/// The inbox's quick filters.
enum InboxFilter: String, CaseIterable, Identifiable {
    case all, unread, starred, attachments
    var id: String { rawValue }
}

/// A group of the mail list, as the platform's list groups it (Gmail and
/// Outlook style): Today, Yesterday, a weekday of this week, Last week, two or
/// three weeks ago, then a month (with its year once it isn't this year's).
/// A message dated in the future (a scheduled send) gets its own day.
struct DateGroup: Hashable {
    enum Kind: String, Hashable {
        case pinned, today, yesterday, weekday, lastWeek, weeksAgo, month, monthYear, upcoming, undated
    }

    let kind: Kind
    /// The day (weekday, upcoming) or the month's first day (month, monthYear), at its start.
    var day: Date?
    var weeks = 0
}

struct MessageSection: Equatable, Identifiable {
    let group: DateGroup
    let messages: [MailMessage]
    var id: DateGroup { group }
}

/// How a row shows its date: the time today, else the day, with the year once it isn't this year.
enum DateStyle: Equatable {
    case time, day, dayYear
}

/// Reply, reply all or forward.
enum ComposeMode: Equatable {
    case new, reply, replyAll, forward
}

/// What the composer opens with: a reply's recipients and quote, a forward's.
struct ComposePrefill: Equatable {
    var mode: ComposeMode = .new
    var to: [String] = []
    var cc: [String] = []
    var subject = ""
    var quotedFrom = ""
    var quotedDate = ""
    var quotedSubject = ""
    var quotedBody = ""
    var accountID: String?
    var inReplyTo: String?
    var references: [String] = []
}

/// The ids a push carries, checked before they are used.
struct NotificationTarget: Equatable {
    let emailID: String?
    let accountID: String?
    let fromName: String?
    let fromEmail: String?
    let subject: String?
    let preview: String?
}

/// What kind of file an attachment is, for its icon and colour.
enum AttachmentKind: CaseIterable {
    case image, pdf, doc, sheet, slides, archive, video, audio, file
}

/// Mail rules that don't depend on the UI: sorting, grouping, composing, scheduling.
enum MailLogic {
    // MARK: Labels

    private static let systemSlugs: Set<String> = [
        "INBOX", "STARRED", "SENT", "DRAFTS", "TRASH", "SPAM", "ARCHIVE", "SCHEDULED", "SNOOZED",
        "IMPORTANT", "ALL", "MUTED", "UNREAD", "PROMOTIONS", "DRAFT", "PINNED",
    ]

    static func isSystemLabel(_ slug: String) -> Bool { systemSlugs.contains(slug.uppercased()) }

    /// The labels a row shows: the mailbox's own (system labels are upper case).
    static func displayLabels(_ labels: [String]) -> [String] { labels.filter { $0 != $0.uppercased() } }

    /// Folds label rows (of one mailbox, or of every mailbox in the unified
    /// inbox) into the system folders' counts and the custom labels, merging
    /// custom labels of the same name.
    static func processLabels(_ rows: [LabelRow]) -> LabelState {
        var counts: [String: Int] = [:]
        var custom: [CustomLabel] = []
        for row in rows {
            let slug = (row.slug?.isEmpty == false ? row.slug : nil) ?? row.name
            if row.isSystem || isSystemLabel(slug) {
                guard let system = SystemLabel.of(slug) else { continue }
                counts[system.slug, default: 0] += row.count
            } else if let index = custom.firstIndex(where: { $0.name.lowercased() == row.name.lowercased() }) {
                custom[index].count += row.count
            } else {
                custom.append(CustomLabel(id: row.id, name: row.name, slug: row.slug ?? row.name, color: row.color, count: row.count))
            }
        }
        return LabelState(systemCounts: counts, custom: custom)
    }

    /// The colours a new label can have.
    static let labelChoices: [(key: String, value: Int)] = [
        ("red", 0xEF4444), ("orange", 0xF97316), ("yellow", 0xEAB308), ("green", 0x22C55E),
        ("teal", 0x14B8A6), ("blue", 0x3B82F6), ("purple", 0x8B5CF6), ("pink", 0xEC4899),
    ]

    /// A label's own colour (`#RRGGBB`), or nil: the screens then take the
    /// platform's colour for its name (`PlatformColors.label`).
    static func parseHex(_ value: String?) -> Int? {
        guard var text = value?.trimmingCharacters(in: .whitespaces) else { return nil }
        if text.hasPrefix("#") { text.removeFirst() }
        guard text.count == 6 else { return nil }
        return Int(text, radix: 16)
    }

    // MARK: The list

    /// The group a message falls in, as the platform's list groups it (weeks start on Monday).
    static func dateGroup(_ date: String, now: Date = Date(), calendar: Calendar = .current) -> DateGroup {
        guard let at = WeldDate.parse(date) else { return DateGroup(kind: .undated) }
        let day = calendar.startOfDay(for: at)
        let today = calendar.startOfDay(for: now)
        if day == today { return DateGroup(kind: .today) }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: today), day == yesterday { return DateGroup(kind: .yesterday) }
        if at > now { return DateGroup(kind: .upcoming, day: day) }
        let monday = startOfWeek(today, calendar: calendar)
        if day >= monday { return DateGroup(kind: .weekday, day: day) }
        let weeks = (calendar.dateComponents([.day], from: startOfWeek(day, calendar: calendar), to: monday).day ?? 0) / 7
        if weeks <= 1 { return DateGroup(kind: .lastWeek) }
        if weeks <= 3 { return DateGroup(kind: .weeksAgo, weeks: weeks) }
        let month = calendar.date(from: calendar.dateComponents([.year, .month], from: day)) ?? day
        let sameYear = calendar.component(.year, from: day) == calendar.component(.year, from: today)
        return DateGroup(kind: sameYear ? .month : .monthYear, day: month)
    }

    /// The Monday of the week `day` falls in.
    private static func startOfWeek(_ day: Date, calendar: Calendar) -> Date {
        let weekday = calendar.component(.weekday, from: day) // 1 is Sunday
        let back = (weekday + 5) % 7 // Monday 0, Sunday 6
        return calendar.date(byAdding: .day, value: -back, to: calendar.startOfDay(for: day)) ?? day
    }

    /// The system label that pins a message, as the platform pins one (`usePinThread`, the message context menu).
    static let pinnedLabel = "PINNED"

    /// Pinned on the server: it carries the `PINNED` label, so the pin shows on the web and every device.
    static func isPinned(_ message: MailMessage) -> Bool {
        message.labels.contains { $0.uppercased() == pinnedLabel }
    }

    /// The labels with the pin added or taken off.
    static func withPinned(_ labels: [String], on: Bool) -> [String] {
        let rest = labels.filter { $0.uppercased() != pinnedLabel }
        return on ? rest + [pinnedLabel] : rest
    }

    /// Pinned first, then a group per day, week or month in the list's own order (newest first).
    static func sections(_ messages: [MailMessage], now: Date = Date(), calendar: Calendar = .current) -> [MessageSection] {
        let top = messages.filter(isPinned)
        var order: [DateGroup] = []
        var byGroup: [DateGroup: [MailMessage]] = [:]
        for message in messages where !isPinned(message) {
            let group = dateGroup(message.listDate, now: now, calendar: calendar)
            if byGroup[group] == nil { order.append(group) }
            byGroup[group, default: []].append(message)
        }
        let dated = order.map { MessageSection(group: $0, messages: byGroup[$0] ?? []) }
        return top.isEmpty ? dated : [MessageSection(group: DateGroup(kind: .pinned), messages: top)] + dated
    }

    /// How a row's (or a message's) date reads: the time today, else the day, with the year when it isn't this one.
    static func dateStyle(_ date: Date, now: Date = Date(), calendar: Calendar = .current) -> DateStyle {
        if calendar.isDate(date, inSameDayAs: now) { return .time }
        return calendar.component(.year, from: date) == calendar.component(.year, from: now) ? .day : .dayYear
    }

    private static let outgoingFolders: Set<String> = ["SENT", "SCHEDULED", "DRAFTS", "DRAFT"]

    /// Sent, Drafts and Scheduled hold the person's own mail: a row names who it goes to, not the sender.
    static func isOutgoingFolder(_ label: String) -> Bool { outgoingFolders.contains(label.uppercased()) }

    /// "Jane Doe, bob@example.com": names where there are any, addresses otherwise; nil when nobody.
    static func recipientNames(_ recipients: [MailAddress]) -> String? {
        let names = recipients
            .filter { !$0.email.trimmingCharacters(in: .whitespaces).isEmpty || !($0.name ?? "").trimmingCharacters(in: .whitespaces).isEmpty }
            .map(\.label)
        return names.isEmpty ? nil : names.joined(separator: ", ")
    }

    /// The orange flag: marked important, or labelled so.
    static func isImportant(_ message: MailMessage) -> Bool {
        message.isImportant || message.labels.contains { $0.uppercased() == "IMPORTANT" }
    }

    /// "jane.doe@example.com" → "Jane Doe", as the platform names a recipient it only has the address of.
    static func displayName(_ email: String) -> String {
        let local = email.components(separatedBy: "@").first ?? email
        return local.split(separator: ".").map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: " ")
    }

    /// Who a message went to, as the platform's "to Sanne Bakker, me" line: To then Cc, the person's own addresses as `me`.
    static func recipientsLine(_ message: MailMessage, selfAddresses: [String], me: String) -> [String] {
        let own = Set(selfAddresses.map { $0.lowercased() })
        return (message.to + message.cc)
            .filter { !$0.email.isEmpty || !($0.name ?? "").trimmingCharacters(in: .whitespaces).isEmpty }
            .map { address in
                if own.contains(address.email.lowercased()) { return me }
                if let name = address.name, !name.trimmingCharacters(in: .whitespaces).isEmpty { return name }
                return displayName(address.email)
            }
    }

    /// The conversation in the platform's order: earlier messages oldest first, the newest last (shown open).
    static func conversation(_ current: MailMessage, others: [MailMessage]) -> [MailMessage] {
        let all = others.filter { $0.id != current.id } + [current]
        return all.sorted { a, b in
            let ta = WeldDate.parse(a.listDate)?.timeIntervalSince1970 ?? 0
            let tb = WeldDate.parse(b.listDate)?.timeIntervalSince1970 ?? 0
            return ta == tb ? a.id < b.id : ta < tb
        }
    }

    static func filter(_ messages: [MailMessage], _ filter: InboxFilter) -> [MailMessage] {
        switch filter {
        case .all: return messages
        case .unread: return messages.filter { !$0.isRead }
        case .starred: return messages.filter { $0.isStarred || $0.labels.contains("STARRED") }
        case .attachments: return messages.filter(\.hasAttachments)
        }
    }

    /// How many loaded messages share each message's thread.
    static func withThreadCounts(_ list: [MailMessage]) -> [MailMessage] {
        var counts: [String: Int] = [:]
        for message in list { if let thread = message.threadID { counts[thread, default: 0] += 1 } }
        return list.map { message in
            var copy = message
            copy.threadCount = message.threadID.flatMap { counts[$0] } ?? 1
            return copy
        }
    }

    /// Whether `a` comes after `b` in the server's newest-first order.
    static func isOlder(_ a: MailMessage, than b: MailMessage) -> Bool {
        let ta = WeldDate.parse(a.sentDate)?.timeIntervalSince1970 ?? 0
        let tb = WeldDate.parse(b.sentDate)?.timeIntervalSince1970 ?? 0
        return ta < tb || (ta == tb && a.id < b.id)
    }

    /// A freshly loaded first page folded onto the list on screen: the rows
    /// already scrolled to that are older than the page stay, with the cursor
    /// past them. `previousKnown == false` means the list came from the
    /// offline cache, whose place is unknown: the page replaces it.
    static func mergeFirstPage(
        previous: [MailMessage],
        firstPage: [MailMessage],
        firstPageCursor: String?,
        previousCursor: String?,
        previousKnown: Bool
    ) -> (messages: [MailMessage], cursor: String?) {
        guard previousKnown, firstPageCursor != nil, let boundary = firstPage.last else { return (firstPage, firstPageCursor) }
        let ids = Set(firstPage.map(\.id))
        let tail = previous.filter { !ids.contains($0.id) && isOlder($0, than: boundary) }
        if tail.isEmpty { return (firstPage, firstPageCursor) }
        return (firstPage + tail, previousCursor)
    }

    /// A page appended, without rows already listed.
    static func appendPage(_ previous: [MailMessage], _ page: [MailMessage]) -> [MailMessage] {
        let seen = Set(previous.map(\.id))
        let fresh = page.filter { !seen.contains($0.id) }
        return fresh.isEmpty ? previous : previous + fresh
    }

    /// The id after `current` in `ids`, for "archive and open the next".
    static func nextID(_ ids: [String], after current: String) -> String? {
        guard let index = ids.firstIndex(of: current), index + 1 < ids.count else { return nil }
        return ids[index + 1]
    }

    // MARK: Composing

    /// "a@b.com, c@d.com; e@f.com" as addresses.
    static func splitAddresses(_ raw: String) -> [String] {
        raw.components(separatedBy: CharacterSet(charactersIn: ",;"))
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    /// What was typed into a field ends in `,` or `;`: the address before it.
    static func committedAddress(_ text: String) -> String? {
        guard text.hasSuffix(",") || text.hasSuffix(";") else { return nil }
        let value = String(text.dropLast()).trimmingCharacters(in: .whitespaces)
        return value.isEmpty ? nil : value
    }

    /// The chips and whatever was typed but not committed: typing an address and tapping Send counts.
    static func withPending(_ chips: [String], typed: String) -> [String] { chips + splitAddresses(typed) }

    private static let addressSeparators = CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: "<>,;\"'"))

    /// Bare addresses from a recipient value: a name like "Doe, Jane" is never split into two.
    static func addresses(_ recipients: [MailAddress]) -> [String] {
        recipients.flatMap { recipient in
            recipient.email.components(separatedBy: addressSeparators).filter(isAddressToken)
        }
    }

    private static func isAddressToken(_ token: String) -> Bool {
        guard let at = token.dropFirst().firstIndex(of: "@") else { return false }
        return at < token.index(before: token.endIndex)
    }

    private static func unique(_ list: [String], excluding exclude: Set<String>) -> [String] {
        var seen = exclude
        return list.filter { seen.insert($0.lowercased()).inserted }
    }

    private static func prefixed(_ subject: String?, reply: Bool) -> String {
        let base = subject ?? ""
        let pattern = reply ? "^re:" : "^(fwd?|fw):"
        let trimmed = base.trimmingCharacters(in: .whitespaces)
        if trimmed.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil { return base }
        return "\(reply ? "Re" : "Fwd"): \(base)"
    }

    /// The composer's prefill for a reply, reply-all or forward: the user's own
    /// addresses are left out of reply-all, and a reply to one's own mail goes
    /// to its recipients.
    static func prefill(_ message: MailMessage, mode: ComposeMode, selfAddresses: [String], unknownSender: String) -> ComposePrefill {
        let me = Set(selfAddresses.map { $0.lowercased() })
        let sender = message.from.map { addresses([$0]) } ?? []
        let to = addresses(message.to)
        let cc = addresses(message.cc)
        let fromSelf = sender.contains { me.contains($0.lowercased()) }
        var replyTo: [String] = []
        var replyCc: [String] = []
        switch mode {
        case .reply:
            replyTo = fromSelf ? unique(to, excluding: me) : Array(sender.prefix(1))
        case .replyAll:
            replyTo = unique(fromSelf ? to : sender + to, excluding: me)
            replyCc = unique(cc, excluding: me.union(replyTo.map { $0.lowercased() }))
        case .new, .forward:
            break
        }
        let isReply = mode == .reply || mode == .replyAll
        let smtp = message.smtpMessageID.flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 }
        var references: [String] = []
        if isReply, let smtp { references = message.references.filter { $0 != smtp } + [smtp] }
        return ComposePrefill(
            mode: mode,
            to: replyTo,
            cc: replyCc,
            subject: prefixed(message.subject, reply: isReply),
            quotedFrom: "\(message.senderName ?? unknownSender) (\(message.from?.email ?? ""))",
            quotedDate: message.sentDate,
            quotedSubject: message.subject ?? "",
            quotedBody: message.textBody ?? message.preview ?? "",
            accountID: message.accountID,
            inReplyTo: isReply ? smtp : nil,
            references: references
        )
    }

    /// The quoted original under a reply or forward, as plain text.
    static func quotedSuffix(_ prefill: ComposePrefill, label: String, from: String, subject: String) -> String {
        if prefill.mode == .new || prefill.quotedBody.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "" }
        return "\n\n---------- \(label) ---------\n\(from)\n\(subject)\n\n\(prefill.quotedBody)"
    }

    static func escapeHTML(_ text: String) -> String {
        text.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
    }

    /// The plain quote as HTML for an HTML body (so `Bob <bob@x.com>` isn't read as a tag).
    static func quotedSuffixHTML(_ suffix: String) -> String {
        if suffix.isEmpty { return "" }
        let escaped = escapeHTML(suffix).replacingOccurrences(of: "\r?\n", with: "<br>", options: .regularExpression)
        return "<div>\(escaped)</div>"
    }

    /// Nothing to read: no text, no quote, no attachment.
    static func hasNoBody(text: String, quotedSuffix: String, attachmentCount: Int) -> Bool {
        attachmentCount == 0
            && text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && quotedSuffix.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// The send payload: HTML in `htmlBody` when the rich editor was used (with
    /// the quote as HTML), else plain text in `body`. "(No subject)" when empty.
    static func sendPayload(
        to: [String],
        cc: [String],
        bcc: [String],
        subject: String,
        text: String,
        html: String,
        quotedSuffix: String,
        attachments: [UploadedAttachment],
        idempotencyKey: String?,
        inReplyTo: String?,
        references: [String],
        noSubject: String
    ) -> SendPayload {
        let useHTML = !html.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let body = useHTML ? html + quotedSuffixHTML(quotedSuffix) : text + quotedSuffix
        let trimmedSubject = subject.trimmingCharacters(in: .whitespacesAndNewlines)
        return SendPayload(
            to: to,
            cc: cc.isEmpty ? nil : cc,
            bcc: bcc.isEmpty ? nil : bcc,
            subject: trimmedSubject.isEmpty ? noSubject : trimmedSubject,
            body: useHTML ? nil : (body.isEmpty ? nil : body),
            htmlBody: useHTML ? body : nil,
            attachments: attachments,
            idempotencyKey: idempotencyKey,
            inReplyTo: inReplyTo,
            references: inReplyTo != nil && !references.isEmpty ? references : nil
        )
    }

    // MARK: Times

    /// The server's window: strictly in the future, at most a year out.
    static let maxScheduleDays = 365

    static func isWithinScheduleWindow(_ at: Date, now: Date) -> Bool {
        at > now && at <= now.addingTimeInterval(TimeInterval(maxScheduleDays) * 86_400)
    }

    enum SendLaterPreset: CaseIterable {
        case inOneHour, inTwoHours, tomorrowMorning, tomorrowAfternoon
    }

    /// A day after `now` (0 is today) at a time of day.
    private static func day(_ offset: Int, hour: Int, from now: Date, calendar: Calendar) -> Date {
        let day = calendar.date(byAdding: .day, value: offset, to: calendar.startOfDay(for: now)) ?? now
        return calendar.date(bySettingHour: hour, minute: 0, second: 0, of: day) ?? day
    }

    /// The quick "send later" choices, those outside the window left out.
    static func sendLaterPresets(now: Date, calendar: Calendar = .current) -> [(preset: SendLaterPreset, date: Date)] {
        let all: [(preset: SendLaterPreset, date: Date)] = [
            (.inOneHour, now.addingTimeInterval(3_600)),
            (.inTwoHours, now.addingTimeInterval(7_200)),
            (.tomorrowMorning, day(1, hour: 9, from: now, calendar: calendar)),
            (.tomorrowAfternoon, day(1, hour: 14, from: now, calendar: calendar)),
        ]
        return all.filter { isWithinScheduleWindow($0.date, now: now) }
    }

    enum SnoozePreset: CaseIterable {
        case inOneHour, inFourHours, tomorrowMorning, nextMonday
    }

    /// Snooze choices: in an hour, four hours, tomorrow at 8, next Monday at 8.
    static func snoozePresets(now: Date, calendar: Calendar = .current) -> [(preset: SnoozePreset, date: Date)] {
        let weekday = calendar.component(.weekday, from: now)
        // Days to the next Monday (weekday 2), never today.
        let toMonday = (9 - weekday) % 7 == 0 ? 7 : (9 - weekday) % 7
        return [
            (.inOneHour, now.addingTimeInterval(3_600)),
            (.inFourHours, now.addingTimeInterval(4 * 3_600)),
            (.tomorrowMorning, day(1, hour: 8, from: now, calendar: calendar)),
            (.nextMonday, day(toMonday, hour: 8, from: now, calendar: calendar)),
        ]
    }

    /// A picked moment with its seconds dropped.
    static func wholeMinute(_ date: Date, calendar: Calendar = .current) -> Date {
        let parts = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: date)
        return calendar.date(from: parts) ?? date
    }

    // MARK: Subscriptions

    static func canUnsubscribe(_ subscription: MailSubscription) -> Bool {
        subscription.unsubscribeURL != nil || subscription.unsubscribeMailto != nil
    }

    /// Only the sender's own page: it has to be opened to finish.
    static func isLinkOnly(_ subscription: MailSubscription) -> Bool {
        subscription.unsubscribeURL != nil && !subscription.oneClick && subscription.unsubscribeMailto == nil
    }

    /// This sender's subscription in a mailbox's list.
    static func subscription(in list: [MailSubscription], for senderEmail: String?) -> MailSubscription? {
        guard let email = senderEmail?.trimmingCharacters(in: .whitespaces).lowercased(), !email.isEmpty else { return nil }
        return list.first { $0.senderEmail.lowercased() == email }
    }

    /// Unsubscribed, yet mail from the sender arrived after.
    static func stillSending(_ subscription: MailSubscription) -> Bool {
        guard !subscription.active,
              let unsubscribed = WeldDate.parse(subscription.unsubscribedAt),
              let last = WeldDate.parse(subscription.lastReceivedAt)
        else { return false }
        return last > unsubscribed
    }

    static func matches(_ subscription: MailSubscription, query: String) -> Bool {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        if q.isEmpty { return true }
        return subscription.senderEmail.lowercased().contains(q)
            || (subscription.senderName ?? "").lowercased().contains(q)
            || (subscription.lastSubject ?? "").lowercased().contains(q)
    }

    // MARK: Pushes and links

    private static func clip(_ value: String?, _ max: Int) -> String? {
        guard let value else { return nil }
        let text = value.replacingOccurrences(of: "[\\x00-\\x1F\\x7F]", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
        return text.isEmpty ? nil : String(text.prefix(max))
    }

    /// An id from a push or a link, if it has generateId()'s shape.
    static func safeID(_ value: String?) -> String? {
        guard let value, value.range(of: "^[A-Za-z0-9_-]{1,40}$", options: .regularExpression) != nil else { return nil }
        return value
    }

    /// A new-email push's data: nil when it names no message and no mailbox.
    static func notificationTarget(_ values: [String: String]) -> NotificationTarget? {
        let emailID = safeID(values["emailId"]) ?? (values["entityType"] == "email" ? safeID(values["entityId"]) : nil)
        let accountID = safeID(values["emailAccountId"])
        if emailID == nil && accountID == nil { return nil }
        return NotificationTarget(
            emailID: emailID,
            accountID: accountID,
            fromName: clip(values["fromName"], 80),
            fromEmail: clip(values["fromEmail"], 120),
            subject: clip(values["subject"], 120),
            preview: clip(values["preview"], 160)
        )
    }

    // MARK: Attachments

    private static let kinds: [(AttachmentKind, [String])] = [
        (.image, ["jpg", "jpeg", "png", "gif", "webp", "heic", "bmp", "svg", "tiff"]),
        (.pdf, ["pdf"]),
        (.doc, ["doc", "docx", "rtf", "txt", "pages", "odt"]),
        (.sheet, ["xls", "xlsx", "csv", "numbers", "ods"]),
        (.slides, ["ppt", "pptx", "key", "odp"]),
        (.archive, ["zip", "rar", "7z", "tar", "gz"]),
        (.video, ["mp4", "mov", "avi", "mkv", "webm"]),
        (.audio, ["mp3", "wav", "m4a", "aac", "ogg"]),
    ]

    static func attachmentKind(_ name: String) -> AttachmentKind {
        let ext = fileExtension(name)
        return kinds.first { $0.1.contains(ext) }?.0 ?? .file
    }

    /// "PDF", or empty when the file has no short extension.
    static func extensionLabel(_ name: String) -> String {
        let ext = fileExtension(name)
        return (1...5).contains(ext.count) ? ext.uppercased() : ""
    }

    private static func fileExtension(_ name: String) -> String {
        guard let dot = name.lastIndex(of: ".") else { return "" }
        return String(name[name.index(after: dot)...]).lowercased()
    }

    /// "2.5 MB".
    static func fileSize(_ bytes: Int) -> String {
        if bytes <= 0 { return "0 Bytes" }
        let units = ["Bytes", "KB", "MB", "GB"]
        let index = min(max(Int(log(Double(bytes)) / log(1024.0)), 0), units.count - 1)
        let value = Double(bytes) / pow(1024.0, Double(index))
        let rounded = (value * 100).rounded() / 100
        let text = rounded == rounded.rounded(.down) ? String(Int(rounded)) : String(rounded)
        return "\(text) \(units[index])"
    }

    /// A name safe to create on disk: a stranger chose it.
    static func safeFileName(_ name: String) -> String {
        let cleaned = name
            .replacingOccurrences(of: "[\\x00-\\x1f\\x7f/\\\\:*?\"<>|]", with: "_", options: .regularExpression)
            .replacingOccurrences(of: "^\\.+", with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
        let short = String(cleaned.prefix(120))
        return short.isEmpty ? "attachment" : short
    }

    /// A random-enough key that makes a retried send safe to replay.
    static func idempotencyKey(nowMillis: Int64, random: (Int) -> Int) -> String {
        "snd_\(nowMillis)_" + (0..<8).map { _ in String(random(36), radix: 36) }.joined()
    }
}
