package com.weldsuite.weldhr.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.BedroomParent
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material.icons.filled.DirectionsCar
import androidx.compose.material.icons.filled.Flight
import androidx.compose.material.icons.filled.FilterList
import androidx.compose.material.icons.filled.Laptop
import androidx.compose.material.icons.filled.Receipt
import androidx.compose.material.icons.filled.Restaurant
import androidx.compose.material.icons.filled.School
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Thermostat
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
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SecondaryScrollableTabRow
import androidx.compose.material3.SelectableDates
import androidx.compose.material3.Switch
import androidx.compose.material3.Tab
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
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.weldsuite.weldhr.HrDays
import com.weldsuite.weldhr.R
import com.weldsuite.weldhr.Swatches
import org.weldsuite.core.R as CoreR
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset

/** The size of the tiles in front of a row. */
val ROW_TILE = 36.dp

/** A coloured tile with an icon: a leave type, a sick day, an expense category. */
@Composable
fun IconTile(icon: ImageVector, background: Color, tint: Color, size: Dp = ROW_TILE) {
    Box(
        Modifier.size(size).background(background, RoundedCornerShape(size * 0.28f)),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(size * 0.5f))
    }
}

/** A plain tile in the surface's tint. */
@Composable
fun PlainTile(icon: ImageVector, size: Dp = ROW_TILE) =
    IconTile(icon, MaterialTheme.colorScheme.surfaceVariant, MaterialTheme.colorScheme.onSurfaceVariant, size)

private fun argb(value: Long) = Color(value.toInt())

/** A leave type's tile: a plane on the colour HR picked, else the brand's. */
@Composable
fun LeaveTypeTile(color: String?, size: Dp = ROW_TILE) {
    val hex = Swatches.hex(color)
    val background = hex?.let(::argb) ?: Tokens.Palette.primary.current()
    val tint = if (hex != null && Swatches.prefersDarkText(hex)) Color.Black else Color.White
    IconTile(Icons.Filled.Flight, background, tint, size)
}

@Composable
fun SickTile(size: Dp = ROW_TILE) = IconTile(Icons.Filled.Thermostat, Tokens.Status.danger.current(), Color.White, size)

/** An expense category's icon on its colour. */
@Composable
fun CategoryTile(category: String, size: Dp = ROW_TILE) {
    val accent = Swatches.CATEGORY[category] ?: Swatches.CATEGORY.getValue("other")
    val icon = when (category) {
        "travel" -> Icons.Filled.DirectionsCar
        "meals" -> Icons.Filled.Restaurant
        "accommodation" -> Icons.Filled.BedroomParent
        "equipment" -> Icons.Filled.Laptop
        "training" -> Icons.Filled.School
        else -> Icons.Filled.Receipt
    }
    IconTile(icon, argb(accent), if (Swatches.prefersDarkText(accent)) Color.Black else Color.White, size)
}

/** The coloured bar in front of a shift. */
@Composable
fun ShiftBar(key: String?) {
    Box(Modifier.width(4.dp).height(36.dp).background(argb(Swatches.shift(key)), RoundedCornerShape(2.dp)))
}

/**
 * A row of the app's lists: what is on the left, the title with a coloured
 * subtitle, and a value with a detail on the right.
 */
@Composable
fun HrRow(
    title: String,
    modifier: Modifier = Modifier,
    leading: (@Composable () -> Unit)? = null,
    subtitle: String? = null,
    subtitleColor: Color? = null,
    subtitleLines: Int = 1,
    value: String? = null,
    valueContent: (@Composable () -> Unit)? = null,
    detail: String? = null,
    detailColor: Color? = null,
    muted: Boolean = false,
    strike: Boolean = false,
    unread: Boolean = false,
    tag: String? = null,
    onClick: (() -> Unit)? = null,
) {
    val muteColor = MaterialTheme.colorScheme.onSurfaceVariant
    ListItem(
        modifier = modifier
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .tagged(tag),
        colors = if (unread) ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.secondaryContainer.copy(alpha = 0.45f)) else ListItemDefaults.colors(),
        leadingContent = leading,
        headlineContent = {
            Text(
                title,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                fontWeight = FontWeight.SemiBold,
                color = if (muted) muteColor else Color.Unspecified,
                textDecoration = if (strike) TextDecoration.LineThrough else null,
            )
        },
        supportingContent = subtitle?.takeIf { it.isNotEmpty() }?.let {
            { Text(it, color = subtitleColor ?: muteColor, maxLines = subtitleLines, overflow = TextOverflow.Ellipsis) }
        },
        trailingContent = if (value != null || valueContent != null || detail != null) {
            {
                Column(horizontalAlignment = Alignment.End) {
                    if (valueContent != null) valueContent() else if (value != null) Text(value, style = MaterialTheme.typography.bodyMedium, maxLines = 1)
                    if (detail != null) Text(detail, style = MaterialTheme.typography.bodySmall, color = detailColor ?: muteColor, maxLines = 1)
                }
            }
        } else {
            null
        },
    )
}

/** A label and its value, in a list of facts. */
@Composable
fun DetailRow(label: String, value: String) {
    ListItem(
        headlineContent = { Text(value) },
        overlineContent = { Text(label) },
    )
}

/** A list section's head, with a figure on the right (a count, a total). */
@Composable
fun SectionHead(title: String, figure: String? = null, modifier: Modifier = Modifier) {
    Row(
        modifier.fillMaxWidth().padding(start = Tokens.Spacing.l, end = Tokens.Spacing.l, top = Tokens.Spacing.l, bottom = Tokens.Spacing.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(title, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary, modifier = Modifier.weight(1f))
        if (figure != null) Text(figure, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** A day's head in a grouped list: "Ma 26 okt" and the day's figure. */
@Composable
fun DayHead(day: String, figure: String?) {
    SectionHead("${Fmt.weekdayShort(day)} ${Fmt.shortDate(day)}", figure)
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

data class Segment<T>(val value: T, val label: String, val tag: String? = null)

/** The views of a tab (My week / Team); nothing when there is only one. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun <T> Segments(options: List<Segment<T>>, selected: T, onSelect: (T) -> Unit) {
    if (options.size < 2) return
    val index = options.indexOfFirst { it.value == selected }.coerceAtLeast(0)
    SecondaryScrollableTabRow(selectedTabIndex = index, edgePadding = Tokens.Spacing.l) {
        options.forEachIndexed { position, option ->
            Tab(
                selected = position == index,
                onClick = { onSelect(option.value) },
                text = { Text(option.label) },
                modifier = Modifier.tagged(option.tag),
            )
        }
    }
}

/** "Time off (2)" for a segment with work waiting. */
fun withCount(label: String, count: Int): String = if (count > 0) "$label ($count)" else label

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

