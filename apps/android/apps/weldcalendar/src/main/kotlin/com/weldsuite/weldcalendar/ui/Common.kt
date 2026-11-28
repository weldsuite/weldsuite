package com.weldsuite.weldcalendar.ui

import android.text.format.DateFormat
import android.text.format.DateUtils
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.weldsuite.weldcalendar.CalendarDates
import com.weldsuite.weldcalendar.CalendarEvent
import com.weldsuite.weldcalendar.DEFAULT_CALENDAR_HEX
import com.weldsuite.weldcalendar.EventLists
import com.weldsuite.weldcalendar.EventPriority
import com.weldsuite.weldcalendar.EventStatus
import com.weldsuite.weldcalendar.EventType
import com.weldsuite.weldcalendar.GuestResponse
import com.weldsuite.weldcalendar.R
import com.weldsuite.weldcalendar.RRule
import com.weldsuite.weldcalendar.RelativeDay
import com.weldsuite.weldcalendar.RepeatPreset
import com.weldsuite.weldcalendar.ScheduleGroup
import com.weldsuite.weldcalendar.TODAY_HEX
import com.weldsuite.weldcalendar.parseHex
import com.weldsuite.weldcalendar.relativeDay
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

/** A `#RRGGBB` string as a colour; the platform's default calendar blue for anything else. */
fun hexColor(hex: String?): Color {
    val value = parseHex(hex) ?: parseHex(DEFAULT_CALENDAR_HEX) ?: 0
    return Color(0xFF000000 or value)
}

/** The platform's today blue, the same in light and dark. */
val TodayBlue: Color = hexColor(TODAY_HEX)

@Composable
@ReadOnlyComposable
fun currentLocale(): Locale = LocalConfiguration.current.locales[0] ?: Locale.getDefault()

/** "09:00", or "9:00 AM", as the phone shows times. */
@Composable
@ReadOnlyComposable
fun timeText(instant: Instant, zone: ZoneId = ZoneId.systemDefault()): String =
    instant.atZone(zone).format(DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(currentLocale()))

/** A date in the locale's order from a skeleton (`EEEMMMd` → "Wed, Aug 5"). */
@Composable
@ReadOnlyComposable
fun dateText(day: LocalDate, skeleton: String): String {
    val locale = currentLocale()
    return day.format(DateTimeFormatter.ofPattern(DateFormat.getBestDateTimePattern(locale, skeleton), locale))
}

/**
 * A day as the platform's list groups name it: "Today · Saturday, November
 * 28" for today, tomorrow and yesterday, else the date alone.
 */
@Composable
@ReadOnlyComposable
fun dayLabel(day: LocalDate, today: LocalDate): String {
    val date = dateText(day, "EEEEMMMMd")
    val relative = when (relativeDay(day, today)) {
        RelativeDay.TODAY -> R.string.weldcalendar_schedule_today
        RelativeDay.TOMORROW -> R.string.weldcalendar_schedule_tomorrow
        RelativeDay.YESTERDAY -> R.string.weldcalendar_schedule_yesterday
        else -> return date
    }
    return "${stringResource(relative)} · $date"
}

/** The schedule group's heading, as the platform's list writes it. */
@Composable
@ReadOnlyComposable
fun scheduleGroupLabel(group: ScheduleGroup, today: LocalDate): String = when (group) {
    ScheduleGroup.EARLIER -> stringResource(R.string.weldcalendar_schedule_earlier)
    ScheduleGroup.YESTERDAY -> dayLabel(today.minusDays(1), today)
    ScheduleGroup.TODAY -> dayLabel(today, today)
    ScheduleGroup.TOMORROW -> dayLabel(today.plusDays(1), today)
    ScheduleGroup.THIS_WEEK -> stringResource(R.string.weldcalendar_schedule_this_week)
    ScheduleGroup.NEXT_WEEK -> stringResource(R.string.weldcalendar_schedule_next_week)
    ScheduleGroup.THIS_MONTH -> dateText(today, "LLLL").replaceFirstChar { it.titlecase(currentLocale()) }
    ScheduleGroup.LATER -> stringResource(R.string.weldcalendar_schedule_later)
}

/** The list's date column: "Mon, Oct 5", or "Mon, Oct 5 – Thu, Oct 8" for an event over several days. */
@Composable
@ReadOnlyComposable
fun scheduleDateText(event: CalendarEvent, zone: ZoneId = ZoneId.systemDefault()): String {
    val (first, last) = EventLists.dayRange(event, zone)
    if (!EventLists.spansDays(event) || last == first) return dateText(CalendarDates.dayOf(event.start, zone), "EEEMMMd")
    return "${dateText(first, "EEEMMMd")} – ${dateText(last, "EEEMMMd")}"
}

/**
 * The row's time: the all-day label, "10:00 – 10:30 AM" (the phone's compact
 * range when both ends fall on one day), or only the start without a later end.
 */
@Composable
@ReadOnlyComposable
fun scheduleTimeText(event: CalendarEvent, zone: ZoneId = ZoneId.systemDefault()): String {
    if (event.allDay) return stringResource(R.string.weldcalendar_agenda_all_day)
    val end = event.end?.takeIf { it.isAfter(event.start) } ?: return timeText(event.start, zone)
    if (CalendarDates.dayOf(event.start, zone) == CalendarDates.dayOf(end, zone)) {
        return DateUtils.formatDateRange(LocalContext.current, event.start.toEpochMilli(), end.toEpochMilli(), DateUtils.FORMAT_SHOW_TIME)
    }
    return "${timeText(event.start, zone)} – ${timeText(end, zone)}"
}

/**
 * The detail's "When", as the platform's `formatEventWhen`: the date (or
 * dates) of an all-day event, else the date and the times, naming the end's
 * day when it differs.
 */
@Composable
@ReadOnlyComposable
fun whenText(event: CalendarEvent, zone: ZoneId = ZoneId.systemDefault()): String {
    val startDay = CalendarDates.dayOf(event.start, zone)
    val end = event.end?.takeIf { it.isAfter(event.start) }
    val endDay = end?.let { CalendarDates.dayOf(it, zone) }
    if (event.allDay) {
        if (endDay != null && endDay.isAfter(startDay)) return "${dateText(startDay, "EEEMMMd")} – ${dateText(endDay, "EEEMMMd")}"
        return dateText(startDay, "EEEEMMMMd")
    }
    val day = dateText(startDay, "EEEMMMd")
    if (end == null || endDay == null) return "$day · ${timeText(event.start, zone)}"
    if (endDay == startDay) return "$day · ${timeText(event.start, zone)} – ${timeText(end, zone)}"
    return "$day · ${timeText(event.start, zone)} – ${dateText(endDay, "EEEMMMd")} · ${timeText(end, zone)}"
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

/** The event's type, "Task" for one WeldSuite placed from a task, as the platform's list names it. */
@Composable
@ReadOnlyComposable
fun eventTypeLabel(event: CalendarEvent): String =
    if (event.isTask) stringResource(R.string.weldcalendar_event_task) else typeLabel(event.type)

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

/** A small round colour sample, as the platform puts next to a calendar's name. */
@Composable
fun ColorDot(hex: String?, modifier: Modifier = Modifier, size: Int = 10) {
    Box(modifier.size(size.dp).background(hexColor(hex), CircleShape))
}

/**
 * The event's dot in a list: solid in its colour, a dashed ring for a
 * tentative event (`statusDotStyle`).
 */
@Composable
fun EventDot(color: Color, tentative: Boolean, modifier: Modifier = Modifier) {
    Canvas(modifier.size(8.dp)) {
        if (tentative) {
            val stroke = 1.5.dp.toPx()
            drawCircle(
                color = color,
                radius = size.minDimension / 2 - stroke / 2,
                style = Stroke(width = stroke, pathEffect = PathEffect.dashPathEffect(floatArrayOf(2.dp.toPx(), 1.5.dp.toPx()))),
            )
        } else {
            drawCircle(color = color)
        }
    }
}

/**
 * A group's heading in a list, as the platform's lists draw it: a small
 * muted label and a count on a light band, with a hairline under it.
 */
@Composable
fun GroupHeader(label: String, count: Int?, modifier: Modifier = Modifier) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Column(modifier.fillMaxWidth().background(MaterialTheme.colorScheme.background)) {
        Row(
            Modifier
                .fillMaxWidth()
                .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f))
                .heightIn(min = 32.dp)
                .padding(horizontal = Tokens.Spacing.m),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
        ) {
            Text(
                label,
                style = MaterialTheme.typography.labelMedium,
                color = muted,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false),
            )
            if (count != null) CountPill(count)
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.7f))
    }
}

/** The count next to a group's label: small mono digits on the muted fill, with a border. */
@Composable
fun CountPill(count: Int) {
    val shape = RoundedCornerShape(5.dp)
    Box(
        Modifier
            .defaultMinSize(minWidth = 16.dp, minHeight = 16.dp)
            .background(MaterialTheme.colorScheme.surfaceVariant, shape)
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant, shape)
            .padding(horizontal = 4.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            count.toString(),
            fontSize = 10.sp,
            lineHeight = 12.sp,
            fontFamily = FontFamily.Monospace,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/**
 * One row of the schedule list, stacked for a phone: the event's dot and its
 * title (with the status when it isn't confirmed), then a muted line with the
 * date and the time, then the type and the place. The date is left out when
 * the group's heading already names the day ([showDate] false), except for an
 * event over several days. A cancelled event is faded and struck through.
 */
@Composable
fun EventRow(event: CalendarEvent, color: Color, showDate: Boolean, onClick: () -> Unit) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val status = event.status
    val cancelled = status == EventStatus.CANCELLED
    val statusText = when (status) {
        EventStatus.CANCELLED, EventStatus.TENTATIVE -> statusLabel(status)
        else -> null
    }
    val zone = ZoneId.systemDefault()
    val multiDay = EventLists.spansDays(event) && EventLists.dayRange(event, zone).let { (first, last) -> first != last }
    val date = if (showDate || multiDay) scheduleDateText(event, zone) else null
    val whenLine = listOfNotNull(date, scheduleTimeText(event, zone)).joinToString(" · ")
    val subtitle = listOfNotNull(eventTypeLabel(event), event.location).joinToString(" · ")
    val description = listOfNotNull(event.title, statusText, whenLine, subtitle).joinToString(", ")
    Column {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable(onClick = onClick)
                .semantics(mergeDescendants = true) { contentDescription = description }
                .tagged("event-row")
                .alpha(if (cancelled) 0.6f else 1f)
                .padding(horizontal = Tokens.Spacing.m, vertical = Tokens.Spacing.m),
            verticalAlignment = Alignment.Top,
            horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m),
        ) {
            // As tall as the title's first line, so the dot sits beside it.
            Box(Modifier.height(20.dp), contentAlignment = Alignment.Center) {
                EventDot(color, tentative = status == EventStatus.TENTATIVE)
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
                    Text(
                        event.title,
                        style = MaterialTheme.typography.titleSmall,
                        textDecoration = if (cancelled) TextDecoration.LineThrough else null,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                    if (statusText != null) {
                        Text(statusText, style = MaterialTheme.typography.bodySmall, color = muted, maxLines = 1, modifier = Modifier.padding(top = 2.dp))
                    }
                }
                Text(whenLine, style = MaterialTheme.typography.bodySmall, color = muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(subtitle, style = MaterialTheme.typography.bodySmall, color = muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
    }
}

/**
 * What an empty list shows, as on the platform: the icon in a muted rounded
 * square, a semibold title and a muted description.
 */
@Composable
fun CalendarEmptyState(icon: ImageVector, title: String, description: String?, modifier: Modifier = Modifier) {
    org.weldsuite.ui.EmptyState(
        title = title,
        description = description,
        modifier = modifier,
        icon = {
            Box(
                Modifier
                    .size(48.dp)
                    .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(Tokens.Radius.large)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(icon, null, Modifier.size(24.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Spacer(Modifier.height(Tokens.Spacing.xs))
        },
    )
}

/** A badge on the muted fill, as the platform shows a priority or a status in the event's details. */
@Composable
fun MutedBadge(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        style = MaterialTheme.typography.labelMedium,
        maxLines = 1,
        modifier = modifier
            .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(4.dp))
            .padding(horizontal = Tokens.Spacing.s, vertical = 3.dp),
    )
}

/** A badge tinted with a colour, as the platform shows an event's type: the colour at 12.5% under it. */
@Composable
fun TintBadge(text: String, color: Color, modifier: Modifier = Modifier) {
    Text(
        text,
        color = color,
        style = MaterialTheme.typography.labelMedium,
        maxLines = 1,
        modifier = modifier
            .background(color.copy(alpha = 0.125f), RoundedCornerShape(4.dp))
            .padding(horizontal = Tokens.Spacing.s, vertical = 3.dp),
    )
}

/** The palette the platform draws an attendee's initial on when there's no picture. */
private val AttendeePalette = listOf(
    0xFF0D9488, 0xFF16A34A, 0xFF2563EB, 0xFF7C3AED, 0xFFDB2777,
    0xFFDC2626, 0xFFEA580C, 0xFFCA8A04, 0xFF0891B2, 0xFF4F46E5,
).map { Color(it) }

/**
 * The calendar's attendee colour for [seed] (`attendeeFallbackColor`): a
 * 32-bit `hash * 31 + codePoint` over the UTF-16 units, as JavaScript does it.
 */
fun attendeeColor(seed: String): Color {
    var hash = 0
    for (index in seed.indices) hash = (hash.toLong() * 31 + seed.codePointAt(index)).toInt()
    return AttendeePalette[(kotlin.math.abs(hash.toLong()) % AttendeePalette.size).toInt()]
}

/** An attendee's initial on their colour, as the calendar's event panel draws it. */
@Composable
fun AttendeeAvatar(email: String, name: String?, modifier: Modifier = Modifier, size: Int = 24) {
    val seed = email.ifEmpty { name.orEmpty() }.ifEmpty { "?" }
    val initial = (name?.takeIf { it.isNotEmpty() } ?: email.ifEmpty { "?" }).take(1).uppercase()
    Box(modifier.size(size.dp).background(attendeeColor(seed), CircleShape), contentAlignment = Alignment.Center) {
        Text(initial, color = Color.White, fontSize = (size * 0.45f).sp, fontWeight = FontWeight.Medium)
    }
}

/** A failed action's message: what failed, then why ("Couldn't save the event", "You're offline…"). */
fun failureText(what: String, why: String): String = "$what\n$why"
