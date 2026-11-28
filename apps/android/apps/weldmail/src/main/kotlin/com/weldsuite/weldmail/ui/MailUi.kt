package com.weldsuite.weldmail.ui

import android.content.Context
import android.content.Intent
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.outlined.AccessTime
import androidx.compose.material.icons.outlined.Archive
import androidx.compose.material.icons.outlined.CalendarToday
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.automirrored.outlined.InsertDriveFile
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Inbox
import androidx.compose.material.icons.outlined.LocalOffer
import androidx.compose.material.icons.outlined.Mail
import androidx.compose.material.icons.outlined.StarOutline
import androidx.compose.material.icons.outlined.WifiOff
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.net.toUri
import com.weldsuite.weldmail.MailLogic
import com.weldsuite.weldmail.R
import com.weldsuite.weldmail.SystemLabel
import com.weldsuite.weldmail.Text as MailText
import com.weldsuite.weldmail.resolve
import org.weldsuite.core.WeldDate
import org.weldsuite.ui.Tokens
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

/** Shows a short message with an optional action (Undo, Discard) at the bottom of the screen. */
fun interface Notify {
    fun show(message: String, action: String?, onAction: (() -> Unit)?)
}

fun Notify.show(message: String) = show(message, null, null)

val LocalNotify = staticCompositionLocalOf { Notify { _, _, _ -> } }

/** The slim bar while the phone is offline. */
@Composable
fun OfflineBanner(modifier: Modifier = Modifier) {
    Row(
        modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .padding(horizontal = Tokens.Spacing.l, vertical = 6.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Outlined.WifiOff, contentDescription = null, tint = Tokens.Status.warning.current(), modifier = Modifier.size(16.dp))
        Text(
            stringResource(R.string.weldmail_inbox_offline),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(start = Tokens.Spacing.s),
        )
    }
}

/** A system folder's name. */
fun systemLabelName(label: SystemLabel): Int = when (label) {
    SystemLabel.INBOX -> R.string.weldmail_labels_inbox
    SystemLabel.PROMOTIONS -> R.string.weldmail_labels_promotions
    SystemLabel.STARRED -> R.string.weldmail_labels_starred
    SystemLabel.SENT -> R.string.weldmail_labels_sent
    SystemLabel.DRAFTS -> R.string.weldmail_labels_drafts
    SystemLabel.SCHEDULED -> R.string.weldmail_labels_scheduled
    SystemLabel.SNOOZED -> R.string.weldmail_labels_snoozed
    SystemLabel.IMPORTANT -> R.string.weldmail_labels_important
    SystemLabel.ALL -> R.string.weldmail_labels_all
    SystemLabel.ARCHIVE -> R.string.weldmail_labels_archive
    SystemLabel.SPAM -> R.string.weldmail_labels_spam
    SystemLabel.TRASH -> R.string.weldmail_labels_trash
}

fun systemLabelIcon(label: SystemLabel): ImageVector = when (label) {
    SystemLabel.INBOX -> Icons.Outlined.Inbox
    SystemLabel.PROMOTIONS -> Icons.Outlined.LocalOffer
    SystemLabel.STARRED -> Icons.Outlined.StarOutline
    SystemLabel.SENT -> Icons.AutoMirrored.Outlined.Send
    SystemLabel.DRAFTS -> Icons.AutoMirrored.Outlined.InsertDriveFile
    SystemLabel.SCHEDULED -> Icons.Outlined.CalendarToday
    SystemLabel.SNOOZED -> Icons.Outlined.AccessTime
    SystemLabel.IMPORTANT -> Icons.Outlined.ErrorOutline
    SystemLabel.ALL -> Icons.Outlined.Mail
    SystemLabel.ARCHIVE -> Icons.Outlined.Archive
    SystemLabel.SPAM -> Icons.Outlined.ErrorOutline
    SystemLabel.TRASH -> Icons.Outlined.Delete
}

/** The empty state of a folder: title and description. */
fun emptyText(label: SystemLabel?): Pair<Int, Int> = when (label) {
    SystemLabel.INBOX -> R.string.weldmail_empty_inbox_title to R.string.weldmail_empty_inbox_description
    SystemLabel.SENT -> R.string.weldmail_empty_sent_title to R.string.weldmail_empty_sent_description
    SystemLabel.DRAFTS -> R.string.weldmail_empty_drafts_title to R.string.weldmail_empty_drafts_description
    SystemLabel.STARRED -> R.string.weldmail_empty_starred_title to R.string.weldmail_empty_starred_description
    SystemLabel.TRASH -> R.string.weldmail_empty_trash_title to R.string.weldmail_empty_trash_description
    SystemLabel.SPAM -> R.string.weldmail_empty_spam_title to R.string.weldmail_empty_spam_description
    SystemLabel.ARCHIVE -> R.string.weldmail_empty_archive_title to R.string.weldmail_empty_archive_description
    SystemLabel.ALL -> R.string.weldmail_empty_all_title to R.string.weldmail_empty_all_description
    SystemLabel.SNOOZED -> R.string.weldmail_empty_snoozed_title to R.string.weldmail_empty_snoozed_description
    SystemLabel.SCHEDULED -> R.string.weldmail_empty_scheduled_title to R.string.weldmail_empty_scheduled_description
    SystemLabel.IMPORTANT -> R.string.weldmail_empty_important_title to R.string.weldmail_empty_important_description
    SystemLabel.PROMOTIONS, null -> R.string.weldmail_empty_other_title to R.string.weldmail_empty_other_description
}

fun emptyIcon(label: SystemLabel?): ImageVector = label?.let(::systemLabelIcon) ?: Icons.Outlined.Inbox

/** A list row's date, as the platform's list: the time today, else the day. */
fun rowTime(date: String): String = dateText(date)

/** The full date and time, for the details panel. */
fun fullTime(date: String): String = WeldDate.parse(date)?.let { WeldDate.dateTime(it) }.orEmpty()

/** A moment as a person reads it: "Fri 28 Nov, 09:00". */
fun momentText(instant: Instant, locale: Locale = Locale.getDefault()): String =
    instant.atZone(ZoneId.systemDefault()).format(DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT).withLocale(locale))

/** "09:00". */
fun clockText(instant: Instant, locale: Locale = Locale.getDefault()): String =
    instant.atZone(ZoneId.systemDefault()).format(DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(locale))

/** Opens a web page in a Custom Tab (the sender's unsubscribe page). */
fun openInTab(context: Context, url: String) {
    runCatching { CustomTabsIntent.Builder().build().launchUrl(context, url.toUri()) }
        .onFailure { openExternal(context, url) }
}

/** Hands a link to the system: the browser, the mail app, the dialler. */
fun openExternal(context: Context, url: String) {
    runCatching {
        context.startActivity(Intent(Intent.ACTION_VIEW, url.toUri()).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}

/** A [MailText] in the phone's language. */
fun MailText.text(context: Context): String = resolve(context)
