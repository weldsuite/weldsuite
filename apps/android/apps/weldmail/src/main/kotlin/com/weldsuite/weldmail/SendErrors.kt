package com.weldsuite.weldmail

import androidx.annotation.PluralsRes
import androidx.annotation.StringRes
import java.text.NumberFormat
import java.time.Instant
import java.util.Locale
import kotlin.math.ceil

/** A piece of text from the string resources, its arguments resolved when shown. */
sealed interface Text {
    data class Res(@param:StringRes val id: Int, val args: List<Any> = emptyList()) : Text
    data class Plural(@param:PluralsRes val id: Int, val count: Int, val args: List<Any> = emptyList()) : Text
    data class Raw(val value: String) : Text

    /** Parts shown one after the other, with a space between. */
    data class Joined(val parts: List<Text>) : Text
}

/** The text in the phone's language; arguments that are texts themselves are resolved first. */
fun Text.resolve(context: android.content.Context): String = when (this) {
    is Text.Raw -> value
    is Text.Res -> context.getString(id, *args.map { (it as? Text)?.resolve(context) ?: it }.toTypedArray())
    is Text.Plural -> context.resources.getQuantityString(
        id,
        count,
        *(listOf<Any>(count) + args.map { (it as? Text)?.resolve(context) ?: it }).toTypedArray(),
    )
    is Text.Joined -> parts.joinToString(" ") { it.resolve(context) }
}

/** A refused send in words: a title and the sentences under it. */
data class SendErrorAlert(val title: Text, val lines: List<Text>)

/** What a refused send's `error.details` says. */
data class SendErrorDetails(
    val limit: Int? = null,
    val window: String? = null,
    val retryAfter: String? = null,
    val suggestWeldReach: Boolean = false,
    val reason: String? = null,
    val sent: List<String> = emptyList(),
    val failed: List<String> = emptyList(),
    val recipients: List<String> = emptyList(),
    val invalid: List<String> = emptyList(),
)

/**
 * Turns a failed send into a message a person can act on: which limit, when
 * a retry can work, whether to point at WeldReach. The same rules as the
 * Expo app's and the web's `send-error.ts`. Null when the code is not one
 * there are words for (the composer then shows its generic failure).
 */
object SendErrors {
    fun describe(code: String?, details: SendErrorDetails, now: Instant = Instant.now(), locale: Locale = Locale.getDefault()): SendErrorAlert? {
        val number = { value: Int -> NumberFormat.getIntegerInstance(locale).format(value) }
        return when (code) {
            null -> null
            "SENDING_LIMITED" -> {
                val title = when (details.window) {
                    "hour" -> R.string.weldmail_send_error_hourly_title
                    "day" -> R.string.weldmail_send_error_daily_title
                    "month" -> R.string.weldmail_send_error_monthly_title
                    else -> R.string.weldmail_send_error_limit_title
                }
                SendErrorAlert(
                    Text.Res(title),
                    listOfNotNull(
                        Text.Res(R.string.weldmail_send_error_limit_reached),
                        limitLine(details, details.window, number),
                        retry(details.retryAfter, now) ?: Text.Res(R.string.weldmail_send_error_contact_support),
                        if (details.suggestWeldReach) Text.Res(R.string.weldmail_send_error_weld_reach_hint) else null,
                    ),
                )
            }
            "FIRST_CONTACT_LIMITED" -> SendErrorAlert(
                Text.Res(R.string.weldmail_send_error_first_contact_title),
                listOfNotNull(
                    Text.Res(
                        when (details.reason) {
                            "cold_outreach_template" -> R.string.weldmail_send_error_first_contact_template
                            "weldmail_shared_domain" -> R.string.weldmail_send_error_first_contact_shared_domain
                            else -> R.string.weldmail_send_error_first_contact_reason
                        },
                    ),
                    details.limit?.let { Text.Res(R.string.weldmail_send_error_first_contact_limit, listOf(number(it))) },
                    retry(details.retryAfter, now),
                    Text.Res(R.string.weldmail_send_error_replies_unaffected),
                    Text.Res(R.string.weldmail_send_error_weld_reach_hint),
                ),
            )
            "PARTIALLY_SENT" -> if (details.sent.isEmpty() && details.failed.isEmpty()) {
                null
            } else {
                SendErrorAlert(
                    Text.Res(R.string.weldmail_send_error_partly_sent_title),
                    listOf(
                        Text.Res(R.string.weldmail_send_error_partly_sent, listOf(list(details.sent), list(details.failed))),
                        Text.Res(R.string.weldmail_send_error_partly_sent_advice),
                    ),
                )
            }
            "RECIPIENT_SUPPRESSED" -> SendErrorAlert(
                Text.Res(R.string.weldmail_send_error_suppressed_title),
                listOf(
                    if (details.recipients.isEmpty()) {
                        Text.Res(R.string.weldmail_send_error_suppressed)
                    } else {
                        Text.Res(R.string.weldmail_send_error_suppressed_list, listOf(list(details.recipients)))
                    },
                    Text.Res(R.string.weldmail_send_error_suppressed_remove),
                ),
            )
            "INVALID_RECIPIENTS" -> SendErrorAlert(
                Text.Res(R.string.weldmail_send_error_invalid_title),
                listOf(
                    if (details.invalid.isEmpty()) {
                        Text.Res(R.string.weldmail_send_error_invalid)
                    } else {
                        Text.Res(R.string.weldmail_send_error_invalid_list, listOf(list(details.invalid)))
                    },
                ),
            )
            "PLATFORM_LIMITED" -> SendErrorAlert(
                Text.Res(R.string.weldmail_send_error_platform_limited_title),
                listOfNotNull(Text.Res(R.string.weldmail_send_error_platform_limited), retry(details.retryAfter, now)),
            )
            "SENDING_ON_HOLD" -> simple(R.string.weldmail_send_error_on_hold_title, R.string.weldmail_send_error_on_hold)
            "SENDING_SUSPENDED" -> simple(R.string.weldmail_send_error_suspended_title, R.string.weldmail_send_error_suspended)
            "SENDER_NOT_OWNED" -> simple(R.string.weldmail_send_error_not_owned_title, R.string.weldmail_send_error_not_owned)
            "TOO_MANY_RECIPIENTS" -> SendErrorAlert(
                Text.Res(R.string.weldmail_send_error_too_many_title),
                listOfNotNull(Text.Res(R.string.weldmail_send_error_too_many), limitLine(details, "message", number)),
            )
            "PROVIDER_RATE_LIMITED" -> simple(R.string.weldmail_send_error_provider_rate_title, R.string.weldmail_send_error_provider_rate)
            "PROVIDER_DAILY_LIMIT" -> simple(R.string.weldmail_send_error_provider_daily_title, R.string.weldmail_send_error_provider_daily)
            "DAILY_LIMIT_REACHED" -> SendErrorAlert(
                Text.Res(R.string.weldmail_send_error_daily_title),
                listOfNotNull(Text.Res(R.string.weldmail_send_error_daily_limit), retry(details.retryAfter, now)),
            )
            "SENDER_DOMAIN_NOT_VERIFIED" ->
                simple(R.string.weldmail_send_error_domain_not_verified_title, R.string.weldmail_send_error_domain_not_verified)
            "EMAIL_TOO_LARGE" -> simple(R.string.weldmail_send_error_too_large_title, R.string.weldmail_send_error_too_large)
            else -> null
        }
    }

    private fun simple(@StringRes title: Int, @StringRes message: Int) = SendErrorAlert(Text.Res(title), listOf(Text.Res(message)))

    private fun limitLine(details: SendErrorDetails, window: String?, number: (Int) -> String): Text? {
        val limit = details.limit ?: return null
        val id = when (window) {
            "hour" -> R.string.weldmail_send_error_limit_per_hour
            "day" -> R.string.weldmail_send_error_limit_per_day
            "month" -> R.string.weldmail_send_error_limit_per_month
            "message" -> R.string.weldmail_send_error_limit_per_message
            else -> return null
        }
        return Text.Res(id, listOf(number(limit)))
    }

    /** "You can send again in 25 minutes." */
    private fun retry(retryAfter: String?, now: Instant): Text? {
        val time = whenText(retryAfter, now) ?: return null
        return Text.Res(R.string.weldmail_send_error_retry_when, listOf(time))
    }

    /** "in a moment", "in 3 hours", "tomorrow", "in 3 days"; null when not a time. */
    fun whenText(retryAfter: String?, now: Instant): Text? {
        val at = org.weldsuite.core.WeldDate.parse(retryAfter) ?: return null
        val diff = at.toEpochMilli() - now.toEpochMilli()
        if (diff <= 0) return Text.Res(R.string.weldmail_send_error_when_moment)
        val minutes = ceil(diff / 60_000.0).toInt()
        if (minutes < 60) return Text.Plural(R.plurals.weldmail_send_error_when_minutes, minutes)
        val hours = ceil(minutes / 60.0).toInt()
        if (hours < 24) return Text.Plural(R.plurals.weldmail_send_error_when_hours, hours)
        val days = ceil(hours / 24.0).toInt()
        return if (days == 1) Text.Res(R.string.weldmail_send_error_when_tomorrow) else Text.Plural(R.plurals.weldmail_send_error_when_days, days)
    }

    /** "a, b, c and 2 more". */
    private fun list(items: List<String>, max: Int = 3): Text {
        if (items.size <= max) return Text.Raw(items.joinToString(", "))
        return Text.Joined(
            listOf(
                Text.Raw(items.take(max).joinToString(", ")),
                Text.Plural(R.plurals.weldmail_common_and_more, items.size - max),
            ),
        )
    }
}
