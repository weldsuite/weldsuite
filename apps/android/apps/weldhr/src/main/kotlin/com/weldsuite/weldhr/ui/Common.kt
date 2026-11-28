package com.weldsuite.weldhr.ui

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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material.icons.filled.FilterList
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import org.weldsuite.ui.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import org.weldsuite.ui.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SecondaryScrollableTabRow
import androidx.compose.material3.SelectableDates
import androidx.compose.material3.Switch
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRowDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.weldsuite.weldhr.HrDays
import com.weldsuite.weldhr.R
import com.weldsuite.weldhr.Swatches
import com.weldsuite.weldhr.Tone
import com.weldsuite.weldhr.Tones
import org.weldsuite.core.R as CoreR
import org.weldsuite.ui.EmptyState
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset

private fun argb(value: Long) = Color(value.toInt())

/** Secondary text under a row's title: 13sp, as the platform's list meta lines. */
private val SubtitleSize = 13.sp

/** The hairline under each list row and group head (`border-border/70`). */
@Composable
fun rowRule(): Color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.7f)

/** Whether the app is drawn dark (some platform colours have a dark variant). */
@Composable
fun isDark(): Boolean = MaterialTheme.colorScheme.background.luminance() < 0.5f

/**
 * The platform's badge (`@weldsuite/ui` Badge): a pill in one of its four
 * variants. WeldHR's statuses use these, not tinted colours.
 */
@Composable
fun ToneBadge(text: String, tone: Tone, modifier: Modifier = Modifier) {
    val scheme = MaterialTheme.colorScheme
    val dark = isDark()
    val fill: Color
    val ink: Color
    var edge: Color? = null
    when (tone) {
        Tone.DEFAULT -> {
            fill = scheme.primary
            ink = scheme.onPrimary
        }
        Tone.SECONDARY -> {
            fill = Tokens.Palette.secondary.current()
            ink = Tokens.Palette.secondaryForeground.current()
        }
        Tone.DESTRUCTIVE -> {
            val danger = Tokens.Status.danger.current()
            fill = if (dark) danger.copy(alpha = 0.6f) else danger
            ink = Color.White
        }
        Tone.OUTLINE -> {
            fill = Color.Transparent
            ink = scheme.onSurface
            edge = scheme.outlineVariant
        }
    }
    Text(
        text,
        style = MaterialTheme.typography.labelMedium,
        color = ink,
        maxLines = 1,
        softWrap = false,
        modifier = modifier
            .background(fill, CircleShape)
            .then(if (edge != null) Modifier.border(1.dp, edge, CircleShape) else Modifier)
            .padding(horizontal = 8.dp, vertical = 2.dp),
    )
}

/** A WeldHR status as the platform's badge: its label, in the variant the platform gives it. */
@Composable
fun StatusTag(status: String, label: String, modifier: Modifier = Modifier) = ToneBadge(label, Tones.of(status), modifier)

/** A leave type's colour dot (the platform's `ColorDot`); neutral grey without a colour. */
@Composable
fun ColorDot(color: String?, size: Dp = 8.dp) {
    Box(Modifier.size(size).background(argb(Swatches.dot(color)), CircleShape))
}

/** An evaluation score (0-100) in its colour band, as the platform's `ScoreBadge`. */
@Composable
fun ScoreBadge(score: Double?) {
    if (score == null) {
        Text(stringResource(R.string.weldhr_common_dash), color = MaterialTheme.colorScheme.onSurfaceVariant)
        return
    }
    val dark = isDark()
    // emerald, sky, amber and red: -100 fill and -800 text, -950 and -300 when dark.
    val (fill, ink) = when (Swatches.scoreBand(score)) {
        0 -> if (dark) 0xFF022C22 to 0xFF6EE7B7 else 0xFFD1FAE5 to 0xFF065F46
        1 -> if (dark) 0xFF082F49 to 0xFF7DD3FC else 0xFFE0F2FE to 0xFF075985
        2 -> if (dark) 0xFF451A03 to 0xFFFCD34D else 0xFFFEF3C7 to 0xFF92400E
        else -> if (dark) 0xFF450A0A to 0xFFFCA5A5 else 0xFFFEE2E2 to 0xFF991B1B
    }
    Text(
        String.format(java.util.Locale.ROOT, "%.1f", score),
        style = MaterialTheme.typography.labelMedium,
        color = argb(ink),
        modifier = Modifier.background(argb(fill), RoundedCornerShape(Tokens.Radius.small)).padding(horizontal = 6.dp, vertical = 2.dp),
    )
}

/** The coloured bar in front of a shift: its client's colour, the default blue without one. */
@Composable
fun ShiftBar(client: String?) {
    Box(Modifier.width(4.dp).height(36.dp).background(argb(Swatches.shift(client)), RoundedCornerShape(2.dp)))
}

/** A count in the platform's small mono chip, beside a group head or a tab. */
@Composable
fun CountChip(count: Int) {
    val shape = RoundedCornerShape(5.dp)
    Box(
        Modifier
            .defaultMinSize(minWidth = 16.dp, minHeight = 16.dp)
            .background(MaterialTheme.colorScheme.surfaceVariant, shape)
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant, shape)
            .padding(horizontal = 4.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(count.toString(), fontSize = 10.sp, lineHeight = 12.sp, fontFamily = FontFamily.Monospace, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/**
 * A row of the app's lists, as the platform's list rows: what is on the
 * left, the title (medium, with a dot or pin in front) over a muted line,
 * and a value, detail and badge on the right; a hairline under it.
 */
@Composable
fun HrRow(
    title: String,
    modifier: Modifier = Modifier,
    leading: (@Composable () -> Unit)? = null,
    marker: (@Composable () -> Unit)? = null,
    subtitle: String? = null,
    subtitleMarker: (@Composable () -> Unit)? = null,
    subtitleColor: Color? = null,
    subtitleLines: Int = 1,
    value: String? = null,
    valueContent: (@Composable () -> Unit)? = null,
    detail: String? = null,
    detailColor: Color? = null,
    badge: (@Composable () -> Unit)? = null,
    muted: Boolean = false,
    strike: Boolean = false,
    unread: Boolean = false,
    divider: Boolean = true,
    tag: String? = null,
    onClick: (() -> Unit)? = null,
) {
    val muteColor = MaterialTheme.colorScheme.onSurfaceVariant
    Column(
        modifier
            .fillMaxWidth()
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .tagged(tag),
    ) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.m),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m),
        ) {
            leading?.invoke()
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    marker?.invoke()
                    Text(
                        title,
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = if (unread) FontWeight.SemiBold else FontWeight.Medium,
                        color = if (muted) muteColor else MaterialTheme.colorScheme.onSurface,
                        textDecoration = if (strike) TextDecoration.LineThrough else null,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                }
                subtitle?.takeIf { it.isNotEmpty() }?.let {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        subtitleMarker?.invoke()
                        Text(
                            it,
                            style = MaterialTheme.typography.bodyMedium.copy(fontSize = SubtitleSize, lineHeight = 18.sp),
                            color = subtitleColor ?: muteColor,
                            maxLines = subtitleLines,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
            if (value != null || valueContent != null || detail != null || badge != null) {
                Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (valueContent != null) valueContent() else if (value != null) Text(value, style = MaterialTheme.typography.bodyMedium, maxLines = 1)
                    if (detail != null) Text(detail, style = MaterialTheme.typography.bodySmall, color = detailColor ?: muteColor, maxLines = 1)
                    badge?.invoke()
                }
            }
        }
        if (divider) HorizontalDivider(color = rowRule())
    }
}

/** A label and its value, as the platform's property rows: the label in a muted column, the value beside it. */
@Composable
fun DetailRow(label: String, value: String, valueContent: (@Composable () -> Unit)? = null) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 36.dp).padding(horizontal = Tokens.Spacing.l, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.width(128.dp))
        Box(Modifier.weight(1f)) {
            if (valueContent != null) valueContent() else Text(value, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

/**
 * A group's head, as the platform's list groups: a small muted label with
 * its count in a chip, and a figure on the right (a total, a range).
 */
@Composable
fun SectionHead(title: String, count: Int? = null, figure: String? = null, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth()) {
        Row(
            Modifier
                .fillMaxWidth()
                .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f))
                .heightIn(min = 32.dp)
                .padding(horizontal = Tokens.Spacing.l, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
        ) {
            Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
                Text(
                    title,
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                if (count != null) CountChip(count)
            }
            if (figure != null) Text(figure, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
        }
        HorizontalDivider(color = rowRule())
    }
}

/** A day's head in a grouped list: "Ma 26 okt" and the day's figure. */
@Composable
fun DayHead(day: String, figure: String? = null, count: Int? = null) {
    SectionHead("${Fmt.weekdayShort(day)} ${Fmt.shortDate(day)}", count = count, figure = figure)
}

/**
 * An empty list, as the platform's: the icon in a muted rounded square, a
 * semibold title and a muted description, with the action under it.
 */
@Composable
fun HrEmpty(title: String, description: String? = null, icon: ImageVector? = null, action: String? = null, actionTag: String? = null, onAction: (() -> Unit)? = null) {
    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
        EmptyState(
            title,
            description,
            icon = icon?.let {
                {
                    Box(
                        Modifier.size(48.dp).background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(Tokens.Radius.large)),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(it, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(24.dp))
                    }
                }
            },
        )
        if (action != null && onAction != null) {
            Button(onClick = onAction, modifier = Modifier.padding(bottom = Tokens.Spacing.xl).tagged(actionTag)) {
                Icon(Icons.Filled.Add, contentDescription = null, modifier = Modifier.size(16.dp))
                Text(action, modifier = Modifier.padding(start = 4.dp))
            }
        }
    }
}

/** A short note under the tabs ("Requesting time off from the app is turned off"). */
@Composable
fun Note(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.s),
    )
}

/** A week, a year or a day, with the arrows to go back and forth. */
@Composable
fun PeriodNav(label: String, sublabel: String? = null, onPrevious: () -> Unit, onNext: (() -> Unit)?, onLabel: (() -> Unit)? = null) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.s),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconButton(onClick = onPrevious, modifier = Modifier.tagged("period-previous")) {
            Icon(Icons.AutoMirrored.Filled.KeyboardArrowLeft, contentDescription = stringResource(R.string.weldhr_calendar_previous))
        }
        Column(
            Modifier.weight(1f).then(if (onLabel != null) Modifier.clickable(onClick = onLabel) else Modifier).tagged("period-label"),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(label, style = MaterialTheme.typography.titleMedium)
            if (sublabel != null) Text(sublabel, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        IconButton(onClick = { onNext?.invoke() }, enabled = onNext != null, modifier = Modifier.tagged("period-next")) {
            Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = stringResource(R.string.weldhr_calendar_next))
        }
    }
}

/** A view of a tab; [count] is work waiting there, shown in a chip. */
data class Segment<T>(val value: T, val label: String, val tag: String? = null, val count: Int = 0)

/**
 * The views of a tab (My week / Team), as the platform's page tabs: medium
 * labels, muted until picked, a 2dp foreground underline; nothing when
 * there is only one.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun <T> Segments(options: List<Segment<T>>, selected: T, onSelect: (T) -> Unit) {
    if (options.size < 2) return
    val index = options.indexOfFirst { it.value == selected }.coerceAtLeast(0)
    val foreground = MaterialTheme.colorScheme.onSurface
    SecondaryScrollableTabRow(
        selectedTabIndex = index,
        edgePadding = Tokens.Spacing.s,
        containerColor = MaterialTheme.colorScheme.background,
        contentColor = foreground,
        indicator = {
            TabRowDefaults.SecondaryIndicator(Modifier.tabIndicatorOffset(index, matchContentSize = true), height = 2.dp, color = foreground)
        },
        divider = { HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant) },
    ) {
        options.forEachIndexed { position, option ->
            Tab(
                selected = position == index,
                onClick = { onSelect(option.value) },
                selectedContentColor = foreground,
                unselectedContentColor = MaterialTheme.colorScheme.onSurfaceVariant,
                text = {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
                        Text(option.label, style = MaterialTheme.typography.labelLarge, maxLines = 1)
                        if (option.count > 0) CountChip(option.count)
                    }
                },
                modifier = Modifier.tagged(option.tag),
            )
        }
    }
}

/** The search field over a list, with the filter button beside it. */
@Composable
fun SearchField(
    value: String,
    onChange: (String) -> Unit,
    placeholder: String,
    filtered: Boolean,
    onFilter: (() -> Unit)?,
    tag: String,
) {
    Row(Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.s), verticalAlignment = Alignment.CenterVertically) {
        OutlinedTextField(
            value = value,
            onValueChange = onChange,
            placeholder = { Text(placeholder) },
            leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
            trailingIcon = if (value.isNotEmpty()) {
                { IconButton(onClick = { onChange("") }) { Icon(Icons.Filled.Clear, contentDescription = stringResource(R.string.weldhr_common_clear_search)) } }
            } else {
                null
            },
            singleLine = true,
            modifier = Modifier.weight(1f).tagged("$tag-search"),
        )
        if (onFilter != null) {
            IconButton(onClick = onFilter, modifier = Modifier.tagged("$tag-filter")) {
                BadgedBox(badge = { if (filtered) Badge() }) {
                    Icon(Icons.Filled.FilterList, contentDescription = stringResource(R.string.weldhr_common_filter))
                }
            }
        }
    }
}


/** A switch per option, all on to begin with; [off] are the ones switched off. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FilterSheet(options: List<Pair<String, String>>, off: Set<String>, onApply: (Set<String>) -> Unit, onDismiss: () -> Unit) {
    var hidden by remember { mutableStateOf(off) }
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.padding(bottom = Tokens.Spacing.xl)) {
            Row(Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l), verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.weldhr_common_filter), style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
                TextButton(onClick = { hidden = if (hidden.isEmpty()) options.map { it.first }.toSet() else emptySet() }) {
                    Text(stringResource(if (hidden.isEmpty()) R.string.weldhr_common_disable_all else R.string.weldhr_common_enable_all))
                }
            }
            options.forEach { (value, label) ->
                ListItem(
                    headlineContent = { Text(label) },
                    trailingContent = {
                        Switch(checked = value !in hidden, onCheckedChange = { on -> hidden = if (on) hidden - value else hidden + value })
                    },
                    modifier = Modifier.tagged("filter-$value"),
                )
            }
            Button(
                onClick = {
                    onApply(hidden)
                    onDismiss()
                },
                modifier = Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.m).tagged("filter-apply"),
            ) { Text(stringResource(R.string.weldhr_common_apply)) }
        }
    }
}

/** Are you sure? A destructive confirm (withdraw, cancel) or a plain one. */
@Composable
fun Confirm(
    title: String,
    message: String?,
    confirm: String,
    dismiss: String,
    destructive: Boolean = true,
    busy: Boolean = false,
    tag: String? = null,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = message?.let { { Text(it) } },
        confirmButton = {
            TextButton(onClick = onConfirm, enabled = !busy, modifier = Modifier.tagged(tag)) {
                Text(confirm, color = if (destructive) Tokens.Status.danger.current() else Color.Unspecified)
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(dismiss) } },
    )
}

/** A full-width destructive button at the foot of a detail page. */
@Composable
fun DangerButton(label: String, tag: String, onClick: () -> Unit) {
    Button(
        onClick = onClick,
        colors = ButtonDefaults.buttonColors(containerColor = Tokens.Status.danger.current(), contentColor = Color.White),
        modifier = Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.m).tagged(tag),
    ) { Text(label) }
}

/** A pushed page's top bar, with the way back. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BackBar(title: String, onBack: () -> Unit, actions: @Composable () -> Unit = {}) {
    TopAppBar(
        title = { Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        navigationIcon = {
            IconButton(onClick = onBack, modifier = Modifier.tagged("back")) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = null)
            }
        },
        actions = { actions() },
    )
}

/** A day picked from the calendar, as `yyyy-MM-dd`, within [min] and [max]. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DateField(label: String, value: String, onChange: (String) -> Unit, min: String? = null, max: String? = null, tag: String? = null, modifier: Modifier = Modifier) {
    var open by remember { mutableStateOf(false) }
    Column(modifier.clickable { open = true }.tagged(tag).padding(vertical = Tokens.Spacing.s)) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(Fmt.day(value), style = MaterialTheme.typography.bodyLarge)
    }
    if (open) {
        fun millis(iso: String?) = HrDays.parse(iso)?.atStartOfDay(ZoneOffset.UTC)?.toInstant()?.toEpochMilli()
        val lower = millis(min)
        val upper = millis(max)
        val state = rememberDatePickerState(
            initialSelectedDateMillis = millis(value),
            selectableDates = object : SelectableDates {
                override fun isSelectableDate(utcTimeMillis: Long): Boolean =
                    (lower == null || utcTimeMillis >= lower) && (upper == null || utcTimeMillis <= upper)
            },
        )
        DatePickerDialog(
            onDismissRequest = { open = false },
            confirmButton = {
                TextButton(onClick = {
                    state.selectedDateMillis?.let { picked ->
                        onChange(Instant.ofEpochMilli(picked).atZone(ZoneOffset.UTC).toLocalDate().toString())
                    }
                    open = false
                }) { Text(stringResource(CoreR.string.core_common_done)) }
            },
            dismissButton = { TextButton(onClick = { open = false }) { Text(stringResource(CoreR.string.core_common_cancel)) } },
        ) { DatePicker(state = state) }
    }
}

/** A time of day, `HH:mm`. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TimeField(label: String, value: String, onChange: (String) -> Unit, tag: String? = null, modifier: Modifier = Modifier) {
    var open by remember { mutableStateOf(false) }
    Column(modifier.clickable { open = true }.tagged(tag).padding(vertical = Tokens.Spacing.s)) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, style = MaterialTheme.typography.bodyLarge)
    }
    if (open) {
        val (hour, minute) = value.split(':').let { (it.getOrNull(0)?.toIntOrNull() ?: 9) to (it.getOrNull(1)?.toIntOrNull() ?: 0) }
        val state = rememberTimePickerState(initialHour = hour, initialMinute = minute, is24Hour = true)
        AlertDialog(
            onDismissRequest = { open = false },
            confirmButton = {
                TextButton(onClick = {
                    onChange("${state.hour.toString().padStart(2, '0')}:${state.minute.toString().padStart(2, '0')}")
                    open = false
                }) { Text(stringResource(CoreR.string.core_common_done)) }
            },
            dismissButton = { TextButton(onClick = { open = false }) { Text(stringResource(CoreR.string.core_common_cancel)) } },
            text = { TimePicker(state = state) },
        )
    }
}

/** A thin rule between groups of a page. */
@Composable
fun Rule() = HorizontalDivider(Modifier.padding(vertical = Tokens.Spacing.xs))

@Composable
fun VSpace(height: Dp = Tokens.Spacing.l) = Spacer(Modifier.height(height))

/** Today, for the forms' defaults. */
fun today(): String = LocalDate.now().toString()

