package com.weldsuite.weldmail.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AccessTime
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Coffee
import androidx.compose.material.icons.outlined.EditCalendar
import androidx.compose.material.icons.outlined.WbSunny
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import org.weldsuite.ui.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SelectableDates
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.weldsuite.weldmail.CustomLabel
import com.weldsuite.weldmail.MailLogic
import com.weldsuite.weldmail.R
import kotlinx.coroutines.launch
import org.weldsuite.core.R as CoreR
import org.weldsuite.core.api.ApiException
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.ZonedDateTime

/** One choice in a "when" sheet. */
private data class TimeChoice(val label: String, val detail: String, val icon: ImageVector, val at: ZonedDateTime)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TimeSheet(
    title: String,
    choices: List<TimeChoice>,
    tint: Color,
    onDismiss: () -> Unit,
    onChoose: (ZonedDateTime) -> Unit,
    footer: (@Composable () -> Unit)? = null,
) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.navigationBarsPadding().padding(bottom = Tokens.Spacing.l)) {
            Text(title, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.s))
            choices.forEach { choice ->
                ListItem(
                    headlineContent = { Text(choice.label) },
                    supportingContent = { Text(choice.detail) },
                    leadingContent = { Icon(choice.icon, contentDescription = null, tint = tint) },
                    modifier = Modifier.clickable { onChoose(choice.at) },
                )
            }
            footer?.invoke()
        }
    }
}

/** "Snooze until": in an hour, four hours, tomorrow morning, next Monday. */
@Composable
fun SnoozeSheet(onDismiss: () -> Unit, onChoose: (ZonedDateTime) -> Unit) {
    val now = remember { ZonedDateTime.now() }
    val choices = MailLogic.snoozePresets(now).map { (preset, at) ->
        val (label, icon) = when (preset) {
            MailLogic.SnoozePreset.IN_ONE_HOUR -> R.string.weldmail_snooze_in_one_hour to Icons.Outlined.AccessTime
            MailLogic.SnoozePreset.IN_FOUR_HOURS -> R.string.weldmail_snooze_in_four_hours to Icons.Outlined.AccessTime
            MailLogic.SnoozePreset.TOMORROW_MORNING -> R.string.weldmail_snooze_tomorrow_morning to Icons.Outlined.WbSunny
            MailLogic.SnoozePreset.NEXT_MONDAY -> R.string.weldmail_snooze_next_monday to Icons.Outlined.CalendarMonth
        }
        TimeChoice(stringResource(label), momentText(at.toInstant()), icon, at)
    }
    TimeSheet(stringResource(R.string.weldmail_snooze_title), choices, MailColors.snooze, onDismiss, onChoose)
}

/** "Send later" / "Schedule send": the quick choices and "Pick date & time". */
@Composable
fun SendLaterSheet(title: String, onDismiss: () -> Unit, onChoose: (ZonedDateTime) -> Unit, onPick: () -> Unit) {
    val now = remember { ZonedDateTime.now() }
    val choices = MailLogic.sendLaterPresets(now).map { (preset, at) ->
        val (label, icon) = when (preset) {
            MailLogic.SendLaterPreset.IN_ONE_HOUR -> R.string.weldmail_send_later_in_one_hour to Icons.Outlined.AccessTime
            MailLogic.SendLaterPreset.IN_TWO_HOURS -> R.string.weldmail_send_later_in_two_hours to Icons.Outlined.AccessTime
            MailLogic.SendLaterPreset.TOMORROW_MORNING -> R.string.weldmail_send_later_tomorrow_morning to Icons.Outlined.Coffee
            MailLogic.SendLaterPreset.TOMORROW_AFTERNOON -> R.string.weldmail_send_later_tomorrow_afternoon to Icons.Outlined.WbSunny
        }
        TimeChoice(stringResource(label), momentText(at.toInstant()), icon, at)
    }
    TimeSheet(title, choices, MaterialTheme.colorScheme.primary, onDismiss, onChoose) {
        ListItem(
            headlineContent = { Text(stringResource(R.string.weldmail_send_later_pick)) },
            supportingContent = { Text(stringResource(R.string.weldmail_send_later_pick_hint)) },
            leadingContent = { Icon(Icons.Outlined.EditCalendar, contentDescription = null, tint = MaterialTheme.colorScheme.primary) },
            modifier = Modifier.clickable(onClick = onPick).tagged("send-later-pick"),
        )
    }
}

/**
 * A day, then a time: the moment a message goes out. Days before today
 * can't be picked; a time outside the server's window (the past, or more
 * than a year out) is refused here instead of by the server.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DateTimeDialog(onDismiss: () -> Unit, onConfirm: (ZonedDateTime) -> Unit) {
    val zone = ZoneId.systemDefault()
    val tomorrow = remember { LocalDate.now(zone).plusDays(1) }
    var day by remember { mutableStateOf<LocalDate?>(null) }
    val today = remember { LocalDate.now(zone) }
    val dateState = rememberDatePickerState(
        initialSelectedDateMillis = tomorrow.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli(),
        selectableDates = object : SelectableDates {
            override fun isSelectableDate(utcTimeMillis: Long): Boolean {
                val date = Instant.ofEpochMilli(utcTimeMillis).atZone(ZoneOffset.UTC).toLocalDate()
                return !date.isBefore(today) && !date.isAfter(today.plusDays(MailLogic.MAX_SCHEDULE_DAYS))
            }
        },
    )
    val picked = day
    if (picked == null) {
        DatePickerDialog(
            onDismissRequest = onDismiss,
            confirmButton = {
                TextButton(
                    onClick = {
                        dateState.selectedDateMillis?.let { day = Instant.ofEpochMilli(it).atZone(ZoneOffset.UTC).toLocalDate() }
                    },
                    enabled = dateState.selectedDateMillis != null,
                ) { Text(stringResource(CoreR.string.core_common_continue)) }
            },
            dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(CoreR.string.core_common_cancel)) } },
        ) {
            DatePicker(state = dateState)
        }
        return
    }
    val timeState = rememberTimePickerState(initialHour = 9, initialMinute = 0)
    val moment = MailLogic.combine(picked, LocalTime.of(timeState.hour, timeState.minute), zone)
    val valid = MailLogic.isWithinScheduleWindow(moment.toInstant(), Instant.now())
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.weldmail_send_later_pick_title)) },
        text = {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                TimePicker(state = timeState)
                Text(momentText(moment.toInstant()), style = MaterialTheme.typography.bodyMedium)
                if (!valid) {
                    Text(
                        stringResource(if (moment.toInstant().isAfter(Instant.now())) R.string.weldmail_send_later_too_far else R.string.weldmail_send_later_in_past),
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.padding(top = Tokens.Spacing.s),
                    )
                }
            }
        },
        confirmButton = {
            TextButton(onClick = { onConfirm(moment) }, enabled = valid, modifier = Modifier.tagged("date-time-done")) {
                Text(stringResource(CoreR.string.core_common_done))
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(CoreR.string.core_common_cancel)) } },
    )
}

/** The mailbox's own labels, checked where the message has them. */
@Composable
fun LabelPickerDialog(
    labels: List<CustomLabel>,
    current: List<String>,
    onDismiss: () -> Unit,
    onSave: suspend (add: List<String>, remove: List<String>) -> Unit,
) {
    var selected by remember(current) { mutableStateOf(current.toSet()) }
    var saving by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    AlertDialog(
        onDismissRequest = { if (!saving) onDismiss() },
        title = { Text(stringResource(R.string.weldmail_label_picker_title)) },
        text = {
            if (labels.isEmpty()) {
                Text(stringResource(R.string.weldmail_label_picker_empty))
            } else {
                Column(Modifier.verticalScroll(rememberScrollState())) {
                    labels.forEach { label ->
                        val checked = label.name in selected
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable { selected = if (checked) selected - label.name else selected + label.name }
                                .tagged("label-${label.name}"),
                        ) {
                            Checkbox(checked = checked, onCheckedChange = null)
                            Box(
                                Modifier
                                    .padding(horizontal = Tokens.Spacing.s)
                                    .size(10.dp)
                                    .background(labelTint(label.name, label.color), CircleShape),
                            )
                            Text(label.name, modifier = Modifier.padding(vertical = Tokens.Spacing.m))
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(
                enabled = !saving,
                onClick = {
                    val add = (selected - current.toSet()).toList()
                    val remove = current.filter { it !in selected && !MailLogic.isSystemLabel(it) }
                    if (add.isEmpty() && remove.isEmpty()) {
                        onDismiss()
                    } else {
                        saving = true
                        scope.launch {
                            onSave(add, remove)
                            saving = false
                        }
                    }
                },
                modifier = Modifier.tagged("labels-save"),
            ) {
                if (saving) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp) else Text(stringResource(CoreR.string.core_common_save))
            }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !saving) { Text(stringResource(CoreR.string.core_common_cancel)) } },
    )
}

/** A new label: a name and, optionally, a colour. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun CreateLabelDialog(aiAvailable: Boolean, onDismiss: () -> Unit, onCreate: suspend (name: String, color: String?) -> Unit) {
    var name by remember { mutableStateOf("") }
    var color by remember { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    AlertDialog(
        onDismissRequest = { if (!saving) onDismiss() },
        title = { Text(stringResource(R.string.weldmail_create_label_title)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.m)) {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it.take(100) },
                    label = { Text(stringResource(R.string.weldmail_create_label_name)) },
                    placeholder = { Text(stringResource(R.string.weldmail_create_label_name_placeholder)) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth().tagged("label-name"),
                )
                Text(stringResource(R.string.weldmail_create_label_color), style = MaterialTheme.typography.labelLarge)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s), verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
                    MailLogic.LABEL_CHOICES.forEach { (key, value) ->
                        val hex = String.format(java.util.Locale.ROOT, "#%06X", value)
                        val chosen = color == hex
                        val description = colorName(key)
                        Box(
                            Modifier
                                .size(32.dp)
                                .background(rgb(value), CircleShape)
                                .then(if (chosen) Modifier.border(3.dp, MaterialTheme.colorScheme.onSurface, CircleShape) else Modifier)
                                .clickable { color = if (chosen) null else hex }
                                .semantics { contentDescription = description },
                            contentAlignment = Alignment.Center,
                        ) {
                            if (chosen) Icon(Icons.Outlined.Check, contentDescription = null, tint = Color.White, modifier = Modifier.size(16.dp))
                        }
                    }
                }
                if (aiAvailable) {
                    Text(stringResource(R.string.weldmail_create_label_ai_note), style = MaterialTheme.typography.bodySmall)
                }
                error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            }
        },
        confirmButton = {
            TextButton(
                enabled = name.isNotBlank() && !saving,
                onClick = {
                    saving = true
                    error = null
                    scope.launch {
                        try {
                            onCreate(name.trim(), color)
                            onDismiss()
                        } catch (failure: Exception) {
                            error = context.getString(
                                if ((failure as? ApiException)?.status == 409) R.string.weldmail_create_label_exists else R.string.weldmail_create_label_failed,
                            )
                        } finally {
                            saving = false
                        }
                    }
                },
                modifier = Modifier.tagged("label-create"),
            ) { Text(stringResource(R.string.weldmail_create_label_create)) }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !saving) { Text(stringResource(CoreR.string.core_common_cancel)) } },
    )
}

@Composable
private fun colorName(key: String): String = stringResource(
    when (key) {
        "red" -> R.string.weldmail_colors_red
        "orange" -> R.string.weldmail_colors_orange
        "yellow" -> R.string.weldmail_colors_yellow
        "green" -> R.string.weldmail_colors_green
        "teal" -> R.string.weldmail_colors_teal
        "blue" -> R.string.weldmail_colors_blue
        "purple" -> R.string.weldmail_colors_purple
        else -> R.string.weldmail_colors_pink
    },
)
