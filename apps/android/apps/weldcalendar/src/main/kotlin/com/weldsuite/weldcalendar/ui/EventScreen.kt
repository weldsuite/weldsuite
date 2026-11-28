package com.weldsuite.weldcalendar.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.Flag
import androidx.compose.material.icons.outlined.Group
import androidx.compose.material.icons.outlined.LocationOn
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.RadioButtonChecked
import androidx.compose.material.icons.outlined.Repeat
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.Videocam
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.weldsuite.weldcalendar.CalendarAccess
import com.weldsuite.weldcalendar.CalendarEvent
import com.weldsuite.weldcalendar.CalendarInfo
import com.weldsuite.weldcalendar.CalendarRepository
import com.weldsuite.weldcalendar.EventStatus
import com.weldsuite.weldcalendar.R
import com.weldsuite.weldcalendar.eventColor
import kotlinx.coroutines.launch
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.LoadState
import org.weldsuite.core.api.ApiException
import org.weldsuite.core.apiErrorMessage
import org.weldsuite.core.R as CoreR
import org.weldsuite.ui.CenteredProgress
import org.weldsuite.ui.LoadErrorState
import org.weldsuite.ui.MessageAction
import org.weldsuite.ui.MessageScreen
import org.weldsuite.ui.RealtimeRefresh
import org.weldsuite.ui.StatusBadge
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged
import java.time.ZoneId

/**
 * One event, as the platform's event panel shows it: the colour and the
 * title, the description, then the details (type, calendar, when, priority,
 * status, location, meeting, attendees, created). Edit and delete for
 * calendars the person may write to; a view-only calendar's events open here
 * too, with a note saying why there's nothing to change.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EventScreen(
    env: AppEnvironment,
    repository: CalendarRepository,
    eventId: String,
    onBack: () -> Unit,
    onEdit: (String) -> Unit,
) {
    var state by remember(eventId) { mutableStateOf(LoadState<CalendarEvent>()) }
    val calendars by repository.calendars.collectAsStateWithLifecycle()
    val changes by repository.changes.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val notify = LocalNotify.current
    val context = LocalContext.current
    var confirmDelete by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf(false) }

    val load: suspend () -> Unit = {
        state = state.copy(loading = true, error = null)
        state = runCatching { repository.event(eventId) }.fold(
            onSuccess = { LoadState(it) },
            onFailure = { LoadState(state.data, error = it) },
        )
    }
    LaunchedEffect(eventId, changes) { load() }
    RealtimeRefresh(env, CALENDAR_TOPICS) { if (!deleting) load() }

    val event = state.data
    val editable = event != null && CalendarAccess.canEdit(event, calendars.data.orEmpty())
    val deleteFailed = stringResource(R.string.weldcalendar_event_delete_failed)

    Scaffold(
        topBar = {
            TopAppBar(
                title = {},
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(CoreR.string.core_common_close)) }
                },
                actions = {
                    if (event != null && editable) {
                        IconButton(onClick = { onEdit(event.id) }, modifier = Modifier.tagged("event-edit")) {
                            Icon(Icons.Outlined.Edit, stringResource(R.string.weldcalendar_event_edit))
                        }
                        IconButton(onClick = { confirmDelete = true }, enabled = !deleting, modifier = Modifier.tagged("event-delete")) {
                            Icon(Icons.Outlined.Delete, stringResource(R.string.weldcalendar_event_delete), tint = Tokens.Status.danger.current())
                        }
                    }
                },
            )
        },
    ) { padding ->
        val error = state.error
        when {
            event != null -> EventDetails(
                event = event,
                calendars = calendars.data.orEmpty(),
                editable = editable,
                onEdit = { onEdit(event.id) },
                modifier = Modifier.padding(padding),
            )
            state.isFirstLoad || (state.loading && error == null) -> CenteredProgress(Modifier.padding(padding))
            (error as? ApiException)?.status == 404 -> MessageScreen(
                title = stringResource(R.string.weldcalendar_event_not_found),
                description = null,
                primary = MessageAction(stringResource(CoreR.string.core_common_try_again), "retry") { scope.launch { load() } },
                modifier = Modifier.padding(padding),
            )
            else -> LoadErrorState(error, onRetry = { scope.launch { load() } }, modifier = Modifier.padding(padding))
        }
    }

    if (confirmDelete && event != null) {
        val delete: (Boolean) -> Unit = { notifyGuests ->
            confirmDelete = false
            deleting = true
            scope.launch {
                runCatching { repository.delete(event.id, notifyGuests) }
                    .onSuccess { onBack() }
                    .onFailure { failure ->
                        deleting = false
                        notify(failureText(deleteFailed, context.getString(apiErrorMessage(failure))))
                    }
            }
        }
        val hasGuests = event.guests.isNotEmpty()
        val danger = Tokens.Status.danger.current()
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text(stringResource(R.string.weldcalendar_event_delete_title)) },
            text = {
                Text(
                    if (hasGuests) {
                        stringResource(R.string.weldcalendar_event_delete_attendees_message)
                    } else {
                        stringResource(R.string.weldcalendar_event_delete_message, event.title)
                    },
                )
            },
            confirmButton = {
                Column(horizontalAlignment = Alignment.End) {
                    if (hasGuests) {
                        TextButton(onClick = { delete(true) }, modifier = Modifier.tagged("event-delete-notify")) {
                            Text(stringResource(R.string.weldcalendar_event_delete_and_notify), color = danger)
                        }
                        TextButton(onClick = { delete(false) }, modifier = Modifier.tagged("event-delete-confirm")) {
                            Text(stringResource(R.string.weldcalendar_event_delete_quietly), color = danger)
                        }
                    } else {
                        TextButton(onClick = { delete(false) }, modifier = Modifier.tagged("event-delete-confirm")) {
                            Text(stringResource(R.string.weldcalendar_event_delete), color = danger)
                        }
                    }
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmDelete = false }) {
                    Text(stringResource(CoreR.string.core_common_cancel), color = MaterialTheme.colorScheme.onSurface)
                }
            },
        )
    }
}

@Composable
private fun EventDetails(
    event: CalendarEvent,
    calendars: List<CalendarInfo>,
    editable: Boolean,
    onEdit: () -> Unit,
    modifier: Modifier,
) {
    val calendar = calendars.firstOrNull { it.id == event.calendarId }
    val zone = remember { ZoneId.systemDefault() }
    val uri = LocalUriHandler.current
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val color = hexColor(eventColor(event.color, event.type, calendar?.color))
    // An empty field invites a value where it can be changed, as the platform's panel does.
    val edit: (() -> Unit)? = if (editable) onEdit else null

    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = Tokens.Spacing.xl)) {
        Row(
            Modifier.fillMaxWidth().padding(start = Tokens.Spacing.l, end = Tokens.Spacing.l, top = Tokens.Spacing.s),
            horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
        ) {
            Box(Modifier.padding(top = 6.dp).size(12.dp).background(color, RoundedCornerShape(4.dp)))
            Text(event.title, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f).tagged("event-title-text"))
        }

        val description = event.description
        if (description != null || editable) {
            Text(
                description ?: stringResource(R.string.weldcalendar_event_add_description),
                style = MaterialTheme.typography.bodyMedium,
                color = muted,
                modifier = Modifier
                    .fillMaxWidth()
                    .let { if (description == null && edit != null) it.clickable(onClick = edit) else it }
                    .padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.s),
            )
        }

        if (!editable) {
            Notice(Icons.Outlined.Lock, stringResource(R.string.weldcalendar_event_read_only), stringResource(R.string.weldcalendar_event_read_only_hint))
        }
        if (event.autoScheduled) {
            Notice(Icons.Outlined.AutoAwesome, stringResource(R.string.weldcalendar_event_auto_scheduled), stringResource(R.string.weldcalendar_event_auto_scheduled_hint))
        }

        DetailsTab()

        Column(Modifier.padding(Tokens.Spacing.l), verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.xs)) {
            Field(Icons.Outlined.RadioButtonChecked, stringResource(R.string.weldcalendar_event_type)) {
                TintBadge(eventTypeLabel(event), color)
            }
            Field(Icons.Outlined.CalendarMonth, stringResource(R.string.weldcalendar_event_calendar)) {
                if (calendar != null) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
                        ColorDot(calendar.color)
                        Text(calendar.name, style = MaterialTheme.typography.bodyMedium)
                    }
                } else {
                    Empty(stringResource(R.string.weldcalendar_common_dash))
                }
            }
            Field(Icons.Outlined.Schedule, stringResource(R.string.weldcalendar_event_when), onClick = edit) {
                Text(whenText(event, zone), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.tagged("event-when"))
            }
            repeatText(event.recurrenceRule)?.let { repeats ->
                Field(Icons.Outlined.Repeat, stringResource(R.string.weldcalendar_event_repeats), onClick = edit) {
                    Text(repeats, style = MaterialTheme.typography.bodyMedium)
                }
            }
            val priority = event.priority
            Field(Icons.Outlined.Flag, stringResource(R.string.weldcalendar_event_priority), onClick = edit.takeIf { priority == null }) {
                if (priority != null) MutedBadge(priorityLabel(priority)) else Placeholder(R.string.weldcalendar_event_set_priority, editable)
            }
            Field(Icons.Outlined.RadioButtonChecked, stringResource(R.string.weldcalendar_event_status)) {
                MutedBadge(statusLabel(event.status ?: EventStatus.CONFIRMED))
            }
            val location = event.location
            Field(Icons.Outlined.LocationOn, stringResource(R.string.weldcalendar_event_location), onClick = edit.takeIf { location == null }) {
                if (location != null) Text(location, style = MaterialTheme.typography.bodyMedium) else Placeholder(R.string.weldcalendar_event_set_location, editable)
            }
            val meeting = event.meetingUrl
            Field(Icons.Outlined.Videocam, stringResource(R.string.weldcalendar_event_meeting)) {
                if (meeting != null) {
                    Text(
                        meeting,
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.primary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.clickable { runCatching { uri.openUri(meeting) } }.tagged("join-meeting"),
                    )
                } else {
                    Empty(stringResource(R.string.weldcalendar_common_dash))
                }
            }
            Field(Icons.Outlined.Group, stringResource(R.string.weldcalendar_event_attendees), onClick = edit.takeIf { event.guests.isEmpty() }) {
                if (event.guests.isEmpty()) {
                    Placeholder(R.string.weldcalendar_event_add_attendees, editable)
                } else {
                    Column(verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.xs)) {
                        event.guests.forEach { guest ->
                            Row(
                                Modifier.tagged("guest"),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
                            ) {
                                AttendeeAvatar(guest.email, guest.name)
                                Text(
                                    guest.label,
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = muted,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.weight(1f, fill = false),
                                )
                                if (guest.status != null) StatusBadge(responseLabel(guest.response), responseColor(guest.response))
                            }
                        }
                    }
                }
            }
            Field(Icons.Outlined.Schedule, stringResource(R.string.weldcalendar_event_created)) {
                val created = event.createdAt
                if (created != null) {
                    Text(dateText(created.atZone(zone).toLocalDate(), "yMMMd"), style = MaterialTheme.typography.bodyMedium)
                } else {
                    Empty(stringResource(R.string.weldcalendar_common_dash))
                }
            }
        }
    }
}

/** The panel's single "Details" tab: its label over a 2dp line, on a hairline across. */
@Composable
private fun DetailsTab() {
    Column(Modifier.fillMaxWidth().padding(top = Tokens.Spacing.s)) {
        Column(Modifier.padding(start = Tokens.Spacing.l), horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
                stringResource(R.string.weldcalendar_event_details),
                style = MaterialTheme.typography.labelLarge,
                modifier = Modifier.padding(horizontal = Tokens.Spacing.xs, vertical = Tokens.Spacing.s),
            )
            Box(Modifier.height(2.dp).fillMaxWidth().background(MaterialTheme.colorScheme.onSurface))
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
    }
}

/**
 * A row of the panel's details: the icon and label in a fixed column, the
 * value beside it. [onClick] opens the form, where the value is changed.
 */
@Composable
private fun Field(icon: ImageVector, label: String, onClick: (() -> Unit)? = null, value: @Composable () -> Unit) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 36.dp)
            .let { if (onClick != null) it.clickable(onClick = onClick) else it }
            .padding(vertical = Tokens.Spacing.xs),
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m),
    ) {
        Row(
            Modifier.width(128.dp).heightIn(min = 28.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
        ) {
            Icon(icon, null, Modifier.size(16.dp), tint = muted)
            Text(label, style = MaterialTheme.typography.bodyMedium, color = muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Box(Modifier.weight(1f).heightIn(min = 28.dp), contentAlignment = Alignment.CenterStart) { value() }
    }
}

/** An empty value: the platform's invitation ("Set Location") where it can be changed, a dash where it can't. */
@Composable
private fun Placeholder(text: Int, editable: Boolean) {
    Empty(if (editable) stringResource(text) else stringResource(R.string.weldcalendar_common_dash))
}

@Composable
private fun Empty(text: String) {
    Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

/** A note under the title: view only, scheduled automatically. */
@Composable
private fun Notice(icon: ImageVector, title: String, text: String) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.xs),
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
    ) {
        Icon(icon, null, Modifier.padding(top = 2.dp).size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(
            "$title · $text",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
