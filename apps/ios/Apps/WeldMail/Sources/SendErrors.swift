import Foundation
import WeldCore

/// A refused send in words: a title and the sentences under it.
struct SendErrorAlert: Equatable {
    let title: String
    let lines: [String]

    var message: String { lines.joined(separator: " ") }
}

/// What a refused send's `error.details` says.
struct SendErrorDetails: Equatable {
    var limit: Int?
    var window: String?
    var retryAfter: String?
    var suggestWeldReach = false
    var reason: String?
    var sent: [String] = []
    var failed: [String] = []
    var recipients: [String] = []
    var invalid: [String] = []
}

/// Turns a failed send into a message a person can act on: which limit, when
/// a retry can work, whether to point at WeldReach. The same rules as the
/// Expo app's and the web's `send-error.ts`, and the Android app's
/// `SendErrors.kt`. Nil when the code is not one there are words for (the
/// composer then shows its generic failure).
enum SendErrors {
    static func describe(code: String?, details: SendErrorDetails, now: Date = Date(), locale: Locale = .current) -> SendErrorAlert? {
        let number = { (value: Int) in value.formatted(.number.locale(locale)) }
        guard let code else { return nil }
        switch code {
        case "SENDING_LIMITED":
            let title: String
            switch details.window {
            case "hour": title = MailStrings.sendErrorHourlyTitle
            case "day": title = MailStrings.sendErrorDailyTitle
            case "month": title = MailStrings.sendErrorMonthlyTitle
            default: title = MailStrings.sendErrorLimitTitle
            }
            return SendErrorAlert(title: title, lines: [
                MailStrings.sendErrorLimitReached,
                limitLine(details, window: details.window, number: number),
                retry(details.retryAfter, now: now) ?? MailStrings.sendErrorContactSupport,
                details.suggestWeldReach ? MailStrings.sendErrorWeldReachHint : nil,
            ].compactMap { $0 })
        case "FIRST_CONTACT_LIMITED":
            let reason: String
            switch details.reason {
            case "cold_outreach_template": reason = MailStrings.sendErrorFirstContactTemplate
            case "weldmail_shared_domain": reason = MailStrings.sendErrorFirstContactSharedDomain
            default: reason = MailStrings.sendErrorFirstContactReason
            }
            return SendErrorAlert(title: MailStrings.sendErrorFirstContactTitle, lines: [
                reason,
                details.limit.map { MailStrings.sendErrorFirstContactLimit(limit: number($0)) },
                retry(details.retryAfter, now: now),
                MailStrings.sendErrorRepliesUnaffected,
                MailStrings.sendErrorWeldReachHint,
            ].compactMap { $0 })
        case "PARTIALLY_SENT":
            if details.sent.isEmpty && details.failed.isEmpty { return nil }
            return SendErrorAlert(title: MailStrings.sendErrorPartlySentTitle, lines: [
                MailStrings.sendErrorPartlySent(sent: list(details.sent), failed: list(details.failed)),
                MailStrings.sendErrorPartlySentAdvice,
            ])
        case "RECIPIENT_SUPPRESSED":
            return SendErrorAlert(title: MailStrings.sendErrorSuppressedTitle, lines: [
                details.recipients.isEmpty ? MailStrings.sendErrorSuppressed : MailStrings.sendErrorSuppressedList(recipients: list(details.recipients)),
                MailStrings.sendErrorSuppressedRemove,
            ])
        case "INVALID_RECIPIENTS":
            return SendErrorAlert(title: MailStrings.sendErrorInvalidTitle, lines: [
                details.invalid.isEmpty ? MailStrings.sendErrorInvalid : MailStrings.sendErrorInvalidList(recipients: list(details.invalid)),
            ])
        case "PLATFORM_LIMITED":
            return SendErrorAlert(
                title: MailStrings.sendErrorPlatformLimitedTitle,
                lines: [MailStrings.sendErrorPlatformLimited, retry(details.retryAfter, now: now)].compactMap { $0 }
            )
        case "SENDING_ON_HOLD":
            return SendErrorAlert(title: MailStrings.sendErrorOnHoldTitle, lines: [MailStrings.sendErrorOnHold])
        case "SENDING_SUSPENDED":
            return SendErrorAlert(title: MailStrings.sendErrorSuspendedTitle, lines: [MailStrings.sendErrorSuspended])
        case "SENDER_NOT_OWNED":
            return SendErrorAlert(title: MailStrings.sendErrorNotOwnedTitle, lines: [MailStrings.sendErrorNotOwned])
        case "TOO_MANY_RECIPIENTS":
            return SendErrorAlert(
                title: MailStrings.sendErrorTooManyTitle,
                lines: [MailStrings.sendErrorTooMany, limitLine(details, window: "message", number: number)].compactMap { $0 }
            )
        case "PROVIDER_RATE_LIMITED":
            return SendErrorAlert(title: MailStrings.sendErrorProviderRateTitle, lines: [MailStrings.sendErrorProviderRate])
        case "PROVIDER_DAILY_LIMIT":
            return SendErrorAlert(title: MailStrings.sendErrorProviderDailyTitle, lines: [MailStrings.sendErrorProviderDaily])
        case "DAILY_LIMIT_REACHED":
            return SendErrorAlert(
                title: MailStrings.sendErrorDailyTitle,
                lines: [MailStrings.sendErrorDailyLimit, retry(details.retryAfter, now: now)].compactMap { $0 }
            )
        case "SENDER_DOMAIN_NOT_VERIFIED":
            return SendErrorAlert(title: MailStrings.sendErrorDomainNotVerifiedTitle, lines: [MailStrings.sendErrorDomainNotVerified])
        case "EMAIL_TOO_LARGE":
            return SendErrorAlert(title: MailStrings.sendErrorTooLargeTitle, lines: [MailStrings.sendErrorTooLarge])
        default:
            return nil
        }
    }

    private static func limitLine(_ details: SendErrorDetails, window: String?, number: (Int) -> String) -> String? {
        guard let limit = details.limit else { return nil }
        switch window {
        case "hour": return MailStrings.sendErrorLimitPerHour(limit: number(limit))
        case "day": return MailStrings.sendErrorLimitPerDay(limit: number(limit))
        case "month": return MailStrings.sendErrorLimitPerMonth(limit: number(limit))
        case "message": return MailStrings.sendErrorLimitPerMessage(limit: number(limit))
        default: return nil
        }
    }

    /// "You can send again in 25 minutes."
    private static func retry(_ retryAfter: String?, now: Date) -> String? {
        whenText(retryAfter, now: now).map { MailStrings.sendErrorRetryWhen(when: $0) }
    }

    /// "in a moment", "in 3 hours", "tomorrow", "in 3 days"; nil when not a time.
    static func whenText(_ retryAfter: String?, now: Date) -> String? {
        guard let at = WeldDate.parse(retryAfter) else { return nil }
        let diff = at.timeIntervalSince(now)
        if diff <= 0 { return MailStrings.sendErrorWhenMoment }
        let minutes = Int((diff / 60).rounded(.up))
        if minutes < 60 { return MailStrings.sendErrorWhenMinutes(minutes) }
        let hours = Int((Double(minutes) / 60).rounded(.up))
        if hours < 24 { return MailStrings.sendErrorWhenHours(hours) }
        let days = Int((Double(hours) / 24).rounded(.up))
        return days == 1 ? MailStrings.sendErrorWhenTomorrow : MailStrings.sendErrorWhenDays(days)
    }

    /// "a, b, c and 2 more".
    static func list(_ items: [String], max: Int = 3) -> String {
        if items.count <= max { return items.joined(separator: ", ") }
        return items.prefix(max).joined(separator: ", ") + " " + MailStrings.commonAndMore(items.count - max)
    }
}
