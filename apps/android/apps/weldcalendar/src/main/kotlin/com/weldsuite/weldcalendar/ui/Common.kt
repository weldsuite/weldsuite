package com.weldsuite.weldcalendar.ui

import android.text.format.DateFormat
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckBox
import androidx.compose.material.icons.outlined.Group
import androidx.compose.material.icons.outlined.LocationOn
import androidx.compose.material.icons.outlined.Repeat
import androidx.compose.material.icons.outlined.Videocam
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.weldsuite.weldcalendar.BRAND_HEX
import com.weldsuite.weldcalendar.CalendarDates
import com.weldsuite.weldcalendar.CalendarEvent
import com.weldsuite.weldcalendar.CalendarPermission
import com.weldsuite.weldcalendar.EventLists
import com.weldsuite.weldcalendar.EventPriority
import com.weldsuite.weldcalendar.EventStatus
import com.weldsuite.weldcalendar.EventType
import com.weldsuite.weldcalendar.GuestResponse
import com.weldsuite.weldcalendar.R
import com.weldsuite.weldcalendar.RRule
import com.weldsuite.weldcalendar.RelativeDay
import com.weldsuite.weldcalendar.RepeatPreset
import com.weldsuite.weldcalendar.TASK_HEX
import com.weldsuite.weldcalendar.eventColor
import com.weldsuite.weldcalendar.parseHex
import com.weldsuite.weldcalendar.relativeDay
import com.weldsuite.weldcalendar.typeColor
import org.weldsuite.core.R as CoreR
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged
import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.time.format.TextStyle
import java.util.Locale

/** The workspace hub's topics for calendars and their events: what every screen reloads on. */
val CALENDAR_TOPICS = listOf("calendar_event", "calendar", "calendar_share")

/** A `#RRGGBB` string as a colour; the brand colour for anything else. */
fun hexColor(hex: String?): Color {
    val value = parseHex(hex) ?: parseHex(BRAND_HEX) ?: 0
    return Color(0xFF000000 or value)
}

@Composable
@ReadOnlyComposable
fun currentLocale(): Locale = LocalConfiguration.current.locales[0] ?: Locale.getDefault()

/** "09:00", or "9:00 AM", as the phone shows times. */
@Composable
@ReadOnlyComposable
fun timeText(instant: Instant, zone: ZoneId = ZoneId.systemDefault()): String =
    instant.atZone(zone).format(DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(currentLocale()))

/** A date in the locale's order from a skeleton (`EEEdMMM` → "Wed 5 Aug"). */
@Composable
@ReadOnlyComposable
fun dateText(day: LocalDate, skeleton: String): String {
    val locale = currentLocale()
    return day.format(DateTimeFormatter.ofPattern(DateFormat.getBestDateTimePattern(locale, skeleton), locale))
}

/** "Today", "Tomorrow", "Yesterday", else "Wed 5 Aug" (with the year once it differs). */
@Composable
@ReadOnlyComposable
fun dayHeading(day: LocalDate, today: LocalDate = LocalDate.now()): String = when (relativeDay(day, today)) {
    RelativeDay.TODAY -> stringResource(CoreR.string.core_common_today)
    RelativeDay.TOMORROW -> stringResource(CoreR.string.core_common_tomorrow)
    RelativeDay.YESTERDAY -> stringResource(CoreR.string.core_common_yesterday)
    RelativeDay.THIS_YEAR -> dateText(day, "EEEdMMM")
    RelativeDay.OTHER_YEAR -> dateText(day, "EEEdMMMyyyy")
}

/**
 * The time line of an event: "09:00 – 10:30", "09:00" without an end, the
 * all-day label, and both dates when it spans days.
 */
@Composable
@ReadOnlyComposable
fun timeRangeText(event: CalendarEvent, zone: ZoneId = ZoneId.systemDefault()): String {
    val startDay = CalendarDates.dayOf(event.start, zone)
    val endDay = event.end?.let { CalendarDates.dayOf(it, zone) }
    if (event.allDay) {
        val label = stringResource(R.string.weldcalendar_agenda_all_day)
        return if (endDay != null && endDay != startDay) "$label · ${dateText(startDay, "dMMM")} – ${dateText(endDay, "dMMM")}" else label
    }
    val start = timeText(event.start, zone)
    val end = event.end ?: return start
    return if (endDay == startDay) {
        "$start – ${timeText(end, zone)}"
    } else {
        "${dateText(startDay, "dMMM")} $start – ${dateText(endDay ?: startDay, "dMMM")} ${timeText(end, zone)}"
    }
}

/** "1h 30m", or null when there is no measurable span. */
@Composable
@ReadOnlyComposable
fun durationText(event: CalendarEvent): String? {
    if (event.allDay) return null
    val (hours, minutes) = CalendarDates.duration(event.start, event.end) ?: return null
    return when {
        hours == 0L -> stringResource(R.string.weldcalendar_event_duration_minutes, minutes.toInt())
        minutes == 0L -> stringResource(R.string.weldcalendar_event_duration_hours, hours.toInt())
        else -> stringResource(R.string.weldcalendar_event_duration_hours_minutes, hours.toInt(), minutes.toInt())
    }
}

@Composable
@ReadOnlyComposable
fun typeLabel(type: EventType): String = stringResource(
    when (type) {
        EventType.MEETING -> R.string.weldcalendar_event_type_meeting
        EventType.CALL -> R.string.weldcalendar_event_type_call
        EventType.APPOINTMENT -> R.string.weldcalendar_event_type_appointment
        EventType.EVENT -> R.string.weldcalendar_event_type_event
        EventType.REMINDER -> R.string.weldcalendar_event_type_reminder
        EventType.OTHER -> R.string.weldcalendar_event_type_other
    },
)

@Composable
@ReadOnlyComposable
fun statusLabel(status: EventStatus): String = stringResource(
    when (status) {
        EventStatus.CONFIRMED -> R.string.weldcalendar_status_confirmed
        EventStatus.TENTATIVE -> R.string.weldcalendar_status_tentative
        EventStatus.CANCELLED -> R.string.weldcalendar_status_cancelled
    },
)

@Composable
@ReadOnlyComposable
fun priorityLabel(priority: EventPriority): String = stringResource(
    when (priority) {
        EventPriority.LOW -> R.string.weldcalendar_priority_low
        EventPriority.NORMAL -> R.string.weldcalendar_priority_normal
        EventPriority.HIGH -> R.string.weldcalendar_priority_high
        EventPriority.URGENT -> R.string.weldcalendar_priority_urgent
    },
)

@Composable
@ReadOnlyComposable
fun permissionLabel(permission: CalendarPermission): String = stringResource(
    when (permission) {
        CalendarPermission.VIEW -> R.string.weldcalendar_permission_view
        CalendarPermission.EDIT -> R.string.weldcalendar_permission_edit
        CalendarPermission.MANAGE -> R.string.weldcalendar_permission_manage
    },
)

@Composable
@ReadOnlyComposable
fun responseLabel(response: GuestResponse): String = stringResource(
    when (response) {
        GuestResponse.ACCEPTED -> R.string.weldcalendar_response_accepted
        GuestResponse.DECLINED -> R.string.weldcalendar_response_declined
        GuestResponse.TENTATIVE -> R.string.weldcalendar_response_tentative
        GuestResponse.PENDING -> R.string.weldcalendar_response_pending
    },
)

@Composable
@ReadOnlyComposable
fun responseColor(response: GuestResponse): Color = when (response) {
    GuestResponse.ACCEPTED -> Tokens.Status.success.current()
    GuestResponse.DECLINED -> Tokens.Status.danger.current()
    GuestResponse.TENTATIVE -> Tokens.Status.warning.current()
    GuestResponse.PENDING -> MaterialTheme.colorScheme.onSurfaceVariant
}

@Composable
@ReadOnlyComposable
fun repeatPresetLabel(preset: RepeatPreset): String = stringResource(
    when (preset) {
        RepeatPreset.NONE -> R.string.weldcalendar_repeat_none
        RepeatPreset.DAILY -> R.string.weldcalendar_repeat_daily
        RepeatPreset.WEEKDAYS -> R.string.weldcalendar_repeat_weekdays
        RepeatPreset.WEEKLY -> R.string.weldcalendar_repeat_weekly
        RepeatPreset.MONTHLY -> R.string.weldcalendar_repeat_monthly
        RepeatPreset.YEARLY -> R.string.weldcalendar_repeat_yearly
    },
)

/**
 * A rule in words: "Every 2 weeks on Mon, Wed, until 31 Dec 2030". Null
 * when it doesn't repeat.
 */
@Composable
fun repeatText(rule: String?): String? {
    if (rule.isNullOrBlank()) return null
    val parsed = RRule.parse(rule) ?: return stringResource(R.string.weldcalendar_repeat_custom)
    if (parsed.frequency == RRule.Frequency.WEEKLY && parsed.interval == 1 && parsed.days == RepeatPreset.WORKDAYS &&
        parsed.count == null && parsed.until == null
    ) {
        return stringResource(R.string.weldcalendar_repeat_weekdays)
    }
    val every = when (parsed.frequency) {
        RRule.Frequency.DAILY -> pluralStringResource(R.plurals.weldcalendar_repeat_every_days, parsed.interval, parsed.interval)
        RRule.Frequency.WEEKLY -> pluralStringResource(R.plurals.weldcalendar_repeat_every_weeks, parsed.interval, parsed.interval)
        RRule.Frequency.MONTHLY -> pluralStringResource(R.plurals.weldcalendar_repeat_every_months, parsed.interval, parsed.interval)
        RRule.Frequency.YEARLY -> pluralStringResource(R.plurals.weldcalendar_repeat_every_years, parsed.interval, parsed.interval)
    }
    val locale = currentLocale()
    val withDays = if (parsed.days.isEmpty()) {
        every
    } else {
        stringResource(R.string.weldcalendar_repeat_on_days, every, parsed.days.joinToString(", ") { weekdayName(it, locale) })
    }
    val until = parsed.until
    val count = parsed.count
    return when {
        until != null -> stringResource(R.string.weldcalendar_repeat_until, withDays, dateText(until, "dMMMyyyy"))
        count != null -> stringResource(
            R.string.weldcalendar_repeat_with_limit,
            withDays,
            pluralStringResource(R.plurals.weldcalendar_repeat_times, count, count),
        )
        else -> withDays
    }
}

private fun weekdayName(day: DayOfWeek, locale: Locale): String = day.getDisplayName(TextStyle.SHORT, locale)

/** A small round colour sample. */
@Composable
fun ColorDot(hex: String?, modifier: Modifier = Modifier, size: Int = 12) {
    Box(modifier.size(size.dp).background(hexColor(hex), CircleShape))
}

/** The type's chip, tinted with the type's colour. */
@Composable
fun TypeChip(type: EventType) {
    Chip(typeLabel(type), typeColor(type))
}

/** Shown instead of "Reminder" for an event WeldSuite placed from a task. */
@Composable
fun TaskChip() {
    Chip(stringResource(R.string.weldcalendar_event_task), TASK_HEX)
}

@Composable
private fun Chip(text: String, hex: String) {
    val color = hexColor(hex)
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        modifier = Modifier
            .background(color.copy(alpha = 0.14f), RoundedCornerShape(10.dp))
            .padding(horizontal = 9.dp, vertical = 4.dp),
    ) {
        Box(Modifier.size(7.dp).background(color, CircleShape))
        Text(text, color = color, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
@ReadOnlyComposable
fun statusColor(status: EventStatus): Color = when (status) {
    EventStatus.CONFIRMED -> Tokens.Status.success.current()
    EventStatus.TENTATIVE -> Tokens.Status.warning.current()
    EventStatus.CANCELLED -> MaterialTheme.colorScheme.onSurfaceVariant
}

/**
 * The event's status pill: none for a task block while it's confirmed (it
 * always is), "Closed" once its task is done.
 */
@Composable
fun StatePill(event: CalendarEvent) {
    val status = event.status ?: return
    if (event.isTask && status == EventStatus.CONFIRMED) return
    if (event.isTask && status == EventStatus.CANCELLED) {
        org.weldsuite.ui.StatusBadge(stringResource(R.string.weldcalendar_event_task_closed), MaterialTheme.colorScheme.onSurfaceVariant)
        return
    }
    org.weldsuite.ui.StatusBadge(statusLabel(status), statusColor(status))
}

/** `normal` carries no signal, so it shows nothing. */
@Composable
fun PriorityBadge(priority: EventPriority?) {
    val value = priority?.takeIf { it != EventPriority.NORMAL } ?: return
    val color = when (value) {
        EventPriority.URGENT -> Tokens.Status.danger.current()
        EventPriority.HIGH -> Tokens.Status.warning.current()
        else -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    org.weldsuite.ui.StatusBadge(priorityLabel(value), color)
}

/**
 * The row every list uses: a time column, the type's colour as a rule, the
 * title, the calendar and the place, and what's special about it (now, a
 * task, a video link, guests, a repeat). A cancelled event stays, struck
 * through; a past one is dimmed.
 */
@Composable
fun EventRow(event: CalendarEvent, calendarName: String?, now: Instant, onClick: () -> Unit) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val accent = hexColor(eventColor(event.color, event.type))
    val cancelled = event.isCancelled
    val past = !cancelled && EventLists.isPast(event, now)
    val live = !cancelled && EventLists.isOngoing(event, now)
    val allDayLabel = stringResource(R.string.weldcalendar_agenda_all_day)
    val start = timeText(event.start)
    val description = listOfNotNull(event.title, if (event.allDay) allDayLabel else start, calendarName).joinToString(", ")
    Column {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(IntrinsicSize.Min)
                .clickable(onClick = onClick)
                .semantics(mergeDescendants = true) { contentDescription = description }
                .tagged("event-row")
                .padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.m),
            horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m),
        ) {
            Column(Modifier.width(56.dp)) {
                if (event.allDay) {
                    Text(allDayLabel, style = MaterialTheme.typography.labelMedium, color = muted, maxLines = 2)
                } else {
                    Text(start, style = MaterialTheme.typography.titleSmall, maxLines = 1)
                    event.end?.let { Text(timeText(it), style = MaterialTheme.typography.bodySmall, color = muted, maxLines = 1) }
                }
            }
            Box(
                Modifier
                    .width(3.dp)
                    .fillMaxHeight()
                    .alpha(if (past) 0.55f else 1f)
                    .background(accent, RoundedCornerShape(2.dp)),
            )
            Column(Modifier.weight(1f)) {
                Text(
                    event.title,
                    style = MaterialTheme.typography.titleMedium,
                    color = if (cancelled) muted else MaterialTheme.colorScheme.onSurface,
                    textDecoration = if (cancelled) TextDecoration.LineThrough else null,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.alpha(if (past) 0.55f else 1f),
                )
                val subtitle = listOfNotNull(calendarName, event.location).joinToString(" · ")
                if (subtitle.isNotEmpty()) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        if (event.location != null) Icon(Icons.Outlined.LocationOn, null, Modifier.size(12.dp), tint = muted)
                        Text(subtitle, style = MaterialTheme.typography.bodySmall, color = muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
                EventMeta(event, live, accent)
            }
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
    }
}

@Composable
private fun EventMeta(event: CalendarEvent, live: Boolean, accent: Color) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val hasVideo = event.isVirtual || event.meetingUrl != null
    val repeats = !event.recurrenceRule.isNullOrBlank()
    if (!live && !event.isTask && !hasVideo && event.guests.isEmpty() && !repeats) return
    Spacer(Modifier.height(6.dp))
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        if (live) {
            Text(
                stringResource(R.string.weldcalendar_agenda_now),
                color = Color.White,
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.background(accent, RoundedCornerShape(8.dp)).padding(horizontal = 7.dp, vertical = 2.dp),
            )
        }
        if (event.isTask) {
            MetaItem(Icons.Outlined.CheckBox, stringResource(R.string.weldcalendar_event_task), muted)
        }
        if (hasVideo) Icon(Icons.Outlined.Videocam, null, Modifier.size(14.dp), tint = muted)
        if (repeats) Icon(Icons.Outlined.Repeat, null, Modifier.size(14.dp), tint = muted)
        if (event.guests.isNotEmpty()) {
            MetaItem(
                Icons.Outlined.Group,
                pluralStringResource(R.plurals.weldcalendar_event_attendee_count, event.guests.size, event.guests.size),
                muted,
            )
        }
    }
}

@Composable
private fun MetaItem(icon: androidx.compose.ui.graphics.vector.ImageVector, text: String, tint: Color) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Icon(icon, null, Modifier.size(13.dp), tint = tint)
        Text(text, style = MaterialTheme.typography.labelSmall, color = tint)
    }
}

/** A section title above a group of rows. */
@Composable
fun SectionTitle(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        style = MaterialTheme.typography.titleSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = modifier.padding(start = Tokens.Spacing.l, end = Tokens.Spacing.l, top = Tokens.Spacing.xl, bottom = Tokens.Spacing.s),
    )
}

/** A failed action's message: what failed, then why ("Couldn't save the event", "You're offline…"). */
fun failureText(what: String, why: String): String = "$what\n$why"
