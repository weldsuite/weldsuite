package com.weldsuite.weldcalendar.ui

import android.text.format.DateFormat
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.weldsuite.weldcalendar.CalendarAccess
import com.weldsuite.weldcalendar.CalendarDates
import com.weldsuite.weldcalendar.CalendarEvent
import com.weldsuite.weldcalendar.CalendarInfo
import com.weldsuite.weldcalendar.CalendarRepository
import com.weldsuite.weldcalendar.DraftTimes
import com.weldsuite.weldcalendar.EventDraft
import com.weldsuite.weldcalendar.EventPriority
import com.weldsuite.weldcalendar.EventStatus
import com.weldsuite.weldcalendar.EventType
import com.weldsuite.weldcalendar.Guest
import com.weldsuite.weldcalendar.GuestProblem
import com.weldsuite.weldcalendar.R
import com.weldsuite.weldcalendar.RepeatPreset
import com.weldsuite.weldcalendar.guestProblem
import com.weldsuite.weldcalendar.problemsOf
import kotlinx.coroutines.launch
import org.weldsuite.core.LoadState
import org.weldsuite.core.apiErrorMessage
import org.weldsuite.core.R as CoreR
import org.weldsuite.ui.Button
import org.weldsuite.ui.CenteredProgress
import org.weldsuite.ui.LoadErrorState
import org.weldsuite.ui.MessageScreen
import org.weldsuite.ui.OutlinedButton
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZoneOffset

private enum class PickerKind { START_DATE, START_TIME, END_DATE, END_TIME }

/**
 * A new event ([eventId] null, starting on [day] when the month tab handed
 * one over) or an edit, with the platform's event dialog's fields in its
 * order. Only calendars the person may write to are offered.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EventFormScreen(repository: CalendarRepository, eventId: String?, day: LocalDate?, onDone: () -> Unit) {
    val calendarsState by repository.calendars.collectAsStateWithLifecycle()
    var original by remember(eventId) { mutableStateOf(LoadState<CalendarEvent>()) }
    val scope = rememberCoroutineScope()
    val zone = remember { ZoneId.systemDefault() }

    val loadEvent: suspend () -> Unit = {
        if (eventId != null) {
            original = original.copy(loading = true, error = null)
            original = runCatching { repository.event(eventId) }.fold(
                onSuccess = { LoadState(it) },
                onFailure = { LoadState(original.data, error = it) },
            )
        }
    }
    LaunchedEffect(eventId) { loadEvent() }

    val title = stringResource(if (eventId == null) R.string.weldcalendar_event_form_new_title else R.string.weldcalendar_event_form_edit_title)
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(title) },
                navigationIcon = {
                    IconButton(onClick = onDone) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(CoreR.string.core_common_cancel)) }
                },
            )
        },
    ) { padding ->
        val calendars = calendarsState.data
        val event = original.data
        when {
            calendars == null && calendarsState.error != null ->
                LoadErrorState(calendarsState.error, onRetry = { scope.launch { repository.refreshCalendars() } }, modifier = Modifier.padding(padding))
            calendars == null -> CenteredProgress(Modifier.padding(padding))
            eventId != null && event == null && original.error != null ->
                LoadErrorState(original.error, onRetry = { scope.launch { loadEvent() } }, modifier = Modifier.padding(padding))
            eventId != null && event == null -> CenteredProgress(Modifier.padding(padding))
            // A link (or a share made view-only meanwhile) can lead here without write access.
            event != null && !CalendarAccess.canEdit(event, calendars) -> MessageScreen(
                title = stringResource(R.string.weldcalendar_event_read_only),
                description = stringResource(R.string.weldcalendar_event_read_only_hint),
                modifier = Modifier.padding(padding),
            )
            else -> {
                val writable = CalendarAccess.writable(calendars)
                if (writable.isEmpty()) {
                    MessageScreen(
                        title = stringResource(R.string.weldcalendar_event_form_no_writable_calendar),
                        description = null,
                        modifier = Modifier.padding(padding),
                    )
                } else {
                    EventForm(
                        repository = repository,
                        original = event,
                        initial = remember(event?.id) {
                            event?.let { EventDraft.of(it, zone) }
                                ?: EventDraft.new(writable, CalendarDates.startFor(day, LocalDateTime.now(zone)))
                        },
                        calendars = writable,
                        onDone = onDone,
                        modifier = Modifier.padding(padding),
                    )
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun EventForm(
    repository: CalendarRepository,
    original: CalendarEvent?,
    initial: EventDraft,
    calendars: List<CalendarInfo>,
    onDone: () -> Unit,
    modifier: Modifier,
) {
    var draft by remember(initial) { mutableStateOf(initial) }
    // The platform's "Virtual meeting" switch: the link field shows while it's on, and turning it off clears the link.
    var virtual by remember(initial) { mutableStateOf(initial.meetingUrl.isNotBlank()) }
    var showProblems by remember { mutableStateOf(false) }
    var picker by remember { mutableStateOf<PickerKind?>(null) }
    var saving by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val notify = LocalNotify.current
    val context = LocalContext.current
    val zone = remember { ZoneId.systemDefault() }
    val problems = problemsOf(draft)
    val failed = stringResource(if (original == null) R.string.weldcalendar_event_form_create_failed else R.string.weldcalendar_event_form_update_failed)
    val titleFocus = remember { FocusRequester() }

    LaunchedEffect(Unit) { if (original == null) runCatching { titleFocus.requestFocus() } }

    Column(
        modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .imePadding()
            .padding(Tokens.Spacing.l),
        verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.l),
    ) {
        if (calendars.size > 1) {
            FormField(stringResource(R.string.weldcalendar_event_form_calendar_label)) {
                ChoiceField(
                    options = calendars,
                    selected = calendars.firstOrNull { it.id == draft.calendarId },
                    text = { it?.name ?: stringResource(R.string.weldcalendar_common_not_set) },
                    leading = { ColorDot(it?.color) },
                    tag = "event-calendar",
                    onSelect = { draft = draft.copy(calendarId = it.id) },
                )
            }
        }

        FormField(stringResource(R.string.weldcalendar_event_form_title_label)) {
            OutlinedTextField(
                value = draft.title,
                onValueChange = { draft = draft.copy(title = it) },
                placeholder = { Text(stringResource(R.string.weldcalendar_event_form_title_placeholder)) },
                isError = showProblems && problems.titleMissing,
                singleLine = true,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Next),
                modifier = Modifier.fillMaxWidth().focusRequester(titleFocus).tagged("event-title"),
            )
            if (showProblems && problems.titleMissing) FieldError(stringResource(R.string.weldcalendar_event_form_title_required))
        }

        Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m)) {
            FormField(stringResource(R.string.weldcalendar_event_form_type_label), Modifier.weight(1f)) {
                ChoiceField(
                    options = EventType.entries,
                    selected = draft.type,
                    text = { typeLabel(it ?: EventType.OTHER) },
                    tag = "event-type",
                    onSelect = { draft = draft.copy(type = it) },
                )
            }
            FormField(stringResource(R.string.weldcalendar_event_form_priority_label), Modifier.weight(1f)) {
                ChoiceField(
                    options = EventPriority.entries,
                    selected = draft.priority,
                    text = { priorityLabel(it ?: EventPriority.NORMAL) },
                    tag = "event-priority",
                    onSelect = { draft = draft.copy(priority = it) },
                )
            }
        }

        SwitchRow(
            label = stringResource(R.string.weldcalendar_event_form_all_day_label),
            checked = draft.allDay,
            tag = "event-all-day",
            onChange = { draft = DraftTimes.allDay(draft, it) },
        )

        FormField(stringResource(R.string.weldcalendar_event_form_starts_label)) {
            DateTimeRow(
                value = draft.start,
                allDay = draft.allDay,
                error = false,
                tag = "event-start",
                onDate = { picker = PickerKind.START_DATE },
                onTime = { picker = PickerKind.START_TIME },
            )
        }
        FormField(stringResource(R.string.weldcalendar_event_form_ends_label)) {
            DateTimeRow(
                value = draft.end,
                allDay = draft.allDay,
                error = showProblems && problems.endBeforeStart,
                tag = "event-end",
                onDate = { picker = PickerKind.END_DATE },
                onTime = { picker = PickerKind.END_TIME },
            )
            if (showProblems && problems.endBeforeStart) FieldError(stringResource(R.string.weldcalendar_event_form_end_before_start))
        }

        FormField(stringResource(R.string.weldcalendar_event_form_repeat_label)) {
            RepeatField(draft.recurrenceRule) { draft = draft.copy(recurrenceRule = it) }
        }

        FormField(stringResource(R.string.weldcalendar_event_form_location_label)) {
            OutlinedTextField(
                value = draft.location,
                onValueChange = { draft = draft.copy(location = it) },
                placeholder = { Text(stringResource(R.string.weldcalendar_event_form_location_placeholder)) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth().tagged("event-location"),
            )
        }

        SwitchRow(
            label = stringResource(R.string.weldcalendar_event_form_virtual_label),
            checked = virtual,
            tag = "event-virtual",
            onChange = { on ->
                virtual = on
                if (!on) draft = draft.copy(meetingUrl = "")
            },
        )
        if (virtual) {
            FormField(stringResource(R.string.weldcalendar_event_form_meeting_url_label)) {
                OutlinedTextField(
                    value = draft.meetingUrl,
                    onValueChange = { draft = draft.copy(meetingUrl = it) },
                    placeholder = { Text(stringResource(R.string.weldcalendar_event_form_meeting_url_placeholder)) },
                    isError = showProblems && problems.badMeetingUrl,
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false),
                    modifier = Modifier.fillMaxWidth().tagged("event-meeting-url"),
                )
                if (showProblems && problems.badMeetingUrl) FieldError(stringResource(R.string.weldcalendar_event_form_meeting_url_invalid))
            }
        }

        FormField(stringResource(R.string.weldcalendar_event_form_attendees_label)) {
            GuestsField(draft.guests) { draft = draft.copy(guests = it) }
        }

        FormField(stringResource(R.string.weldcalendar_event_form_description_label)) {
            OutlinedTextField(
                value = draft.description,
                onValueChange = { draft = draft.copy(description = it) },
                placeholder = { Text(stringResource(R.string.weldcalendar_event_form_description_placeholder)) },
                minLines = 3,
                modifier = Modifier.fillMaxWidth().tagged("event-description"),
            )
        }

        // The platform offers the status once the event exists.
        if (original != null) {
            FormField(stringResource(R.string.weldcalendar_event_form_status_label)) {
                ChoiceField(
                    options = EventStatus.entries,
                    selected = draft.status,
                    text = { statusLabel(it ?: EventStatus.CONFIRMED) },
                    tag = "event-status",
                    onSelect = { draft = draft.copy(status = it) },
                )
            }
        }

        if (original != null && (original.guests.isNotEmpty() || draft.guests.isNotEmpty())) {
            SwitchRow(
                label = stringResource(R.string.weldcalendar_event_form_notify_label),
                checked = draft.notifyGuests,
                tag = "event-notify",
                onChange = { draft = draft.copy(notifyGuests = it) },
            )
        }

        Row(Modifier.padding(top = Tokens.Spacing.s), horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
            OutlinedButton(onClick = onDone, enabled = !saving, modifier = Modifier.weight(1f).height(44.dp)) {
                Text(stringResource(CoreR.string.core_common_cancel))
            }
            Button(
                onClick = {
                    if (!problems.isEmpty) {
                        showProblems = true
                        return@Button
                    }
                    saving = true
                    scope.launch {
                        runCatching {
                            if (original == null) repository.create(draft, zone) else repository.update(original, draft, zone)
                        }
                            .onSuccess { onDone() }
                            .onFailure { error ->
                                saving = false
                                notify(failureText(failed, context.getString(apiErrorMessage(error))))
                            }
                    }
                },
                enabled = !saving,
                modifier = Modifier.weight(1f).height(44.dp).tagged("event-submit"),
            ) {
                if (saving) {
                    CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                } else {
                    Text(stringResource(if (original == null) R.string.weldcalendar_event_form_submit_create else R.string.weldcalendar_event_form_submit_save))
                }
            }
        }
        Spacer(Modifier.height(Tokens.Spacing.l))
    }

    when (picker) {
        PickerKind.START_DATE -> DateDialog(draft.start.toLocalDate(), onDismiss = { picker = null }) {
            draft = DraftTimes.startDate(draft, it)
            picker = null
        }
        PickerKind.END_DATE -> DateDialog(draft.end.toLocalDate(), onDismiss = { picker = null }) {
            draft = DraftTimes.endDate(draft, it)
            picker = null
        }
        PickerKind.START_TIME -> TimeDialog(draft.start.toLocalTime(), onDismiss = { picker = null }) {
            draft = DraftTimes.startTime(draft, it)
            picker = null
        }
        PickerKind.END_TIME -> TimeDialog(draft.end.toLocalTime(), onDismiss = { picker = null }) {
            draft = DraftTimes.endTime(draft, it)
            picker = null
        }
        null -> {}
    }
}

/** A field as the platform's forms lay it out: the label above, the control under it. */
@Composable
private fun FormField(label: String, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
        Text(label, style = MaterialTheme.typography.labelLarge)
        content()
    }
}

/** A field's validation message, in the destructive colour. */
@Composable
private fun FieldError(text: String) {
    Text(text, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
}

/** A switch with its label after it, as the platform's dialog puts "All day event" and "Virtual meeting". */
@Composable
private fun SwitchRow(label: String, checked: Boolean, tag: String, onChange: (Boolean) -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable { onChange(!checked) },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m),
    ) {
        Switch(checked = checked, onCheckedChange = onChange, modifier = Modifier.semantics { contentDescription = label }.tagged(tag))
        Text(label, style = MaterialTheme.typography.labelLarge)
    }
}

/** A select, as Material's exposed menu: the value in a field, the options under it. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun <T> ChoiceField(
    options: List<T>,
    selected: T?,
    text: @Composable (T?) -> String,
    tag: String,
    onSelect: (T) -> Unit,
    modifier: Modifier = Modifier,
    leading: (@Composable (T?) -> Unit)? = null,
) {
    var open by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(expanded = open, onExpandedChange = { open = it }, modifier = modifier) {
        OutlinedTextField(
            value = text(selected),
            onValueChange = {},
            readOnly = true,
            leadingIcon = leading?.let { draw -> { draw(selected) } },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = open) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth().menuAnchor(MenuAnchorType.PrimaryNotEditable).tagged(tag),
        )
        ExposedDropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            options.forEachIndexed { index, option ->
                DropdownMenuItem(
                    text = { Text(text(option)) },
                    leadingIcon = leading?.let { draw -> { draw(option) } },
                    onClick = {
                        onSelect(option)
                        open = false
                    },
                    modifier = Modifier.tagged("$tag-option-$index"),
                )
            }
        }
    }
}

/** The repeat presets, plus "keep" for a rule the app didn't write. */
@Composable
private fun RepeatField(rule: String, onChange: (String) -> Unit) {
    val preset = RepeatPreset.of(rule)
    val options: List<String> = buildList {
        if (preset == null) add(rule)
        RepeatPreset.entries.forEach { add(it.rule) }
    }
    ChoiceField(
        options = options,
        selected = rule,
        text = { option ->
            val known = RepeatPreset.of(option)
            if (known != null) repeatPresetLabel(known) else repeatText(option) ?: stringResource(R.string.weldcalendar_repeat_keep_custom)
        },
        tag = "event-repeat",
        onSelect = onChange,
    )
}

/** The platform's date-time field: an outline date button and, unless all day, an outline time button. */
@Composable
private fun DateTimeRow(
    value: LocalDateTime,
    allDay: Boolean,
    error: Boolean,
    tag: String,
    onDate: () -> Unit,
    onTime: () -> Unit,
) {
    val colors = ButtonDefaults.outlinedButtonColors(
        contentColor = if (error) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
    )
    Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
        OutlinedButton(onClick = onDate, colors = colors, modifier = Modifier.weight(1f).tagged("$tag-date")) {
            Text(dateText(value.toLocalDate(), "EEEdMMMyyyy"), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.fillMaxWidth())
        }
        if (!allDay) {
            OutlinedButton(onClick = onTime, colors = colors, modifier = Modifier.widthIn(min = 104.dp).tagged("$tag-time")) {
                Text(timeText(value.atZone(ZoneId.systemDefault()).toInstant()), maxLines = 1)
            }
        }
    }
}

/** Material's date picker. It works in UTC days, so the day goes in and out at UTC midnight. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DateDialog(initial: LocalDate, onDismiss: () -> Unit, onPick: (LocalDate) -> Unit) {
    val state = rememberDatePickerState(initialSelectedDateMillis = initial.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli())
    DatePickerDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton(
                onClick = {
                    val millis = state.selectedDateMillis
                    if (millis == null) onDismiss() else onPick(Instant.ofEpochMilli(millis).atZone(ZoneOffset.UTC).toLocalDate())
                },
                modifier = Modifier.tagged("picker-done"),
            ) { Text(stringResource(CoreR.string.core_common_done)) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(CoreR.string.core_common_cancel)) } },
    ) {
        DatePicker(state = state, title = { Text(stringResource(R.string.weldcalendar_event_form_pick_date), Modifier.padding(start = 24.dp, top = 16.dp)) })
    }
}

/** Material's time picker, 12 or 24 hours as the phone is set. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TimeDialog(initial: LocalTime, onDismiss: () -> Unit, onPick: (LocalTime) -> Unit) {
    val context = LocalContext.current
    val state = rememberTimePickerState(initialHour = initial.hour, initialMinute = initial.minute, is24Hour = DateFormat.is24HourFormat(context))
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.weldcalendar_event_form_pick_time)) },
        text = { TimePicker(state = state) },
        confirmButton = {
            TextButton(onClick = { onPick(LocalTime.of(state.hour, state.minute)) }, modifier = Modifier.tagged("picker-done")) {
                Text(stringResource(CoreR.string.core_common_done))
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(CoreR.string.core_common_cancel)) } },
    )
}

/**
 * The platform's guest field: the guests as muted chips with a remove
 * button, and "Add guests", which opens a field to type an address in.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun GuestsField(guests: List<Guest>, onChange: (List<Guest>) -> Unit) {
    var adding by remember { mutableStateOf(false) }
    var email by remember { mutableStateOf("") }
    var problem by remember { mutableStateOf<GuestProblem?>(null) }
    val add: () -> Unit = {
        val issue = guestProblem(email, guests)
        if (issue != null) {
            problem = issue
        } else {
            onChange(guests + Guest(email = email.trim(), name = null, status = null, role = null))
            email = ""
            problem = null
        }
    }
    Column(verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
        if (guests.isNotEmpty()) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                guests.forEach { guest -> GuestChip(guest) { onChange(guests - guest) } }
            }
        }
        if (adding) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
                OutlinedTextField(
                    value = email,
                    onValueChange = {
                        email = it
                        problem = null
                    },
                    placeholder = { Text(stringResource(R.string.weldcalendar_event_form_attendee_email_placeholder)) },
                    isError = problem != null,
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, autoCorrectEnabled = false, imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { add() }),
                    modifier = Modifier.weight(1f).tagged("attendee-email"),
                )
                TextButton(onClick = add, enabled = email.isNotBlank(), modifier = Modifier.tagged("attendee-add")) {
                    Text(stringResource(R.string.weldcalendar_event_form_add_attendee))
                }
            }
            problem?.let { issue ->
                FieldError(
                    stringResource(
                        when (issue) {
                            GuestProblem.INVALID -> R.string.weldcalendar_event_form_attendee_invalid
                            GuestProblem.DUPLICATE -> R.string.weldcalendar_event_form_attendee_duplicate
                            GuestProblem.LIMIT -> R.string.weldcalendar_event_form_attendee_limit
                        },
                    ),
                )
            }
        } else {
            OutlinedButton(onClick = { adding = true }, modifier = Modifier.tagged("attendees-open")) {
                Icon(Icons.Filled.Add, null, Modifier.size(14.dp))
                Spacer(Modifier.size(Tokens.Spacing.xs))
                Text(stringResource(R.string.weldcalendar_event_form_add_guests), style = MaterialTheme.typography.labelLarge)
            }
        }
    }
}

/** One guest, as the platform's dialog lists them: the name (or address) on the muted fill, with an x. */
@Composable
private fun GuestChip(guest: Guest, onRemove: () -> Unit) {
    Row(
        Modifier
            .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(Tokens.Radius.small))
            .padding(start = Tokens.Spacing.s)
            .tagged("guest-${guest.email}"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(guest.label, style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 220.dp))
        IconButton(onClick = onRemove, modifier = Modifier.size(28.dp)) {
            Icon(
                Icons.Outlined.Close,
                stringResource(R.string.weldcalendar_event_form_remove_attendee, guest.label),
                Modifier.size(14.dp),
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
