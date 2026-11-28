package com.weldsuite.weldcalendar.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.OpenInNew
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material3.AlertDialog
import org.weldsuite.ui.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.weldsuite.weldcalendar.CalendarAccess
import com.weldsuite.weldcalendar.CalendarDates
import com.weldsuite.weldcalendar.CalendarEvent
import com.weldsuite.weldcalendar.CalendarRepository
import com.weldsuite.weldcalendar.R
import com.weldsuite.weldcalendar.eventColor
import com.weldsuite.weldcalendar.guestAnswers
import kotlinx.coroutines.launch
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.LoadState
import org.weldsuite.core.api.ApiException
import org.weldsuite.core.apiErrorMessage
import org.weldsuite.core.R as CoreR
import org.weldsuite.ui.Avatar
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
 * One event: when, where, who, and edit and delete for calendars the person
 * may write to. A view-only calendar's events open here too, with a note
 * saying why there's nothing to change.
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
                title = { Text(event?.title ?: stringResource(R.string.weldcalendar_event_detail_title), maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(CoreR.string.core_common_close)) }
                },
                actions = {
                    if (event != null && editable) {
                        IconButton(onClick = { onEdit(event.id) }, modifier = Modifier.tagged("event-edit")) {
                            Icon(Icons.Outlined.Edit, stringResource(R.string.weldcalendar_event_edit))
                        }
                        IconButton(onClick = { confirmDelete = true }, enabled = !deleting, modifier = Modifier.tagged("event-delete")) {
                            Icon(Icons.Outlined.Delete, stringResource(CoreR.string.core_common_delete), tint = MaterialTheme.colorScheme.error)
                        }
                    }
                },
            )
        },
    ) { padding ->
        val error = state.error
        when {
            event != null -> EventDetails(event, repository, Modifier.padding(padding), editable)
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
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text(stringResource(R.string.weldcalendar_event_delete_title)) },
            text = {
                Text(
                    stringResource(
                        if (hasGuests) R.string.weldcalendar_event_delete_attendees_message else R.string.weldcalendar_event_delete_message,
                    ),
                )
            },
            confirmButton = {
                Column(horizontalAlignment = Alignment.End) {
                    if (hasGuests) {
                        TextButton(onClick = { delete(true) }, modifier = Modifier.tagged("event-delete-notify")) {
                            Text(stringResource(R.string.weldcalendar_event_delete_and_notify), color = MaterialTheme.colorScheme.error)
                        }
                        TextButton(onClick = { delete(false) }, modifier = Modifier.tagged("event-delete-confirm")) {
                            Text(stringResource(R.string.weldcalendar_event_delete_quietly), color = MaterialTheme.colorScheme.error)
                        }
                    } else {
                        TextButton(onClick = { delete(false) }, modifier = Modifier.tagged("event-delete-confirm")) {
                            Text(stringResource(CoreR.string.core_common_delete), color = MaterialTheme.colorScheme.error)
                        }
                    }
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmDelete = false }) { Text(stringResource(CoreR.string.core_common_cancel)) }
            },
        )
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun EventDetails(event: CalendarEvent, repository: CalendarRepository, modifier: Modifier, editable: Boolean) {
    val calendars by repository.calendars.collectAsStateWithLifecycle()
    val calendar = calendars.data?.firstOrNull { it.id == event.calendarId }
    val zone = remember { ZoneId.systemDefault() }
    val uri = LocalUriHandler.current
    val accent = hexColor(eventColor(event.color, event.type))

    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = Tokens.Spacing.xl)) {
        FlowRow(
            Modifier.padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.s),
            horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
            verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
        ) {
            if (event.isTask) TaskChip() else TypeChip(event.type)
            StatePill(event)
            PriorityBadge(event.priority)
        }

        Card(Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.m, vertical = Tokens.Spacing.s)) {
            Row(Modifier.height(IntrinsicSize.Min).padding(14.dp), horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m)) {
                Box(Modifier.width(4.dp).fillMaxHeight().background(accent, RoundedCornerShape(2.dp)))
                Column(Modifier.weight(1f)) {
                    Text(dayHeading(CalendarDates.dayOf(event.start, zone)), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                    val duration = durationText(event)
                    Text(
                        listOfNotNull(timeRangeText(event, zone), duration).joinToString(" · "),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.tagged("event-when"),
                    )
                }
            }
        }

        if (!editable) {
            Notice(stringResource(R.string.weldcalendar_event_read_only), stringResource(R.string.weldcalendar_event_read_only_hint))
        }
        if (event.autoScheduled) {
            Notice(stringResource(R.string.weldcalendar_event_auto_scheduled), stringResource(R.string.weldcalendar_event_auto_scheduled_hint))
        }

        event.description?.let { Block(stringResource(R.string.weldcalendar_event_description)) { Text(it) } }

        Block(stringResource(R.string.weldcalendar_event_details)) {
            Field(stringResource(R.string.weldcalendar_event_calendar), calendar?.name ?: stringResource(R.string.weldcalendar_common_dash))
            Field(stringResource(R.string.weldcalendar_event_when), dateText(CalendarDates.dayOf(event.start, zone), "EEEdMMM"))
            repeatText(event.recurrenceRule)?.let { Field(stringResource(R.string.weldcalendar_event_repeats), it) }
            event.location?.let { Field(stringResource(R.string.weldcalendar_event_location), it) }
            event.timezone?.let { scheduledIn ->
                Field(stringResource(R.string.weldcalendar_event_timezone), scheduledIn)
                if (scheduledIn != zone.id) {
                    Text(
                        stringResource(R.string.weldcalendar_event_timezone_shown, scheduledIn),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }

        event.meetingUrl?.let { url ->
            Block(stringResource(R.string.weldcalendar_event_meeting_link)) {
                Row(
                    Modifier.fillMaxWidth().clickable { runCatching { uri.openUri(url) } }.tagged("join-meeting").padding(vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Text(stringResource(R.string.weldcalendar_event_join_meeting), color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.SemiBold)
                    Icon(Icons.AutoMirrored.Filled.OpenInNew, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(16.dp))
                }
                Text(url, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }

        if (event.guests.isNotEmpty()) {
            Block(pluralStringResource(R.plurals.weldcalendar_event_attendee_count, event.guests.size, event.guests.size)) {
                val answers = guestAnswers(event.guests)
                Text(
                    stringResource(R.string.weldcalendar_event_attendee_answers, answers.accepted, answers.tentative, answers.declined, answers.pending),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                event.guests.forEach { guest ->
                    Row(
                        Modifier.fillMaxWidth().padding(vertical = 6.dp).tagged("guest"),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m),
                    ) {
                        Avatar(guest.label, size = 32.dp)
                        Column(Modifier.weight(1f)) {
                            Text(guest.label, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            if (guest.name != null) {
                                Text(guest.email, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                            }
                        }
                        StatusBadge(responseLabel(guest.response), responseColor(guest.response))
                    }
                }
            }
        }

        event.notes?.let { Block(stringResource(R.string.weldcalendar_event_notes)) { Text(it) } }
    }
}

/** A titled card of details. */
@Composable
private fun Block(title: String, content: @Composable () -> Unit) {
    Card(
        Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.m, vertical = Tokens.Spacing.s),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
    ) {
        Column(Modifier.padding(Tokens.Spacing.l), verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.xs)) {
            Text(title, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
            content()
        }
    }
}

@Composable
private fun Field(label: String, value: String) {
    Row(Modifier.fillMaxWidth().padding(vertical = 2.dp), horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m)) {
        Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.width(110.dp))
        Text(value, modifier = Modifier.weight(1f))
    }
}

/** An informational banner: view only, scheduled automatically. */
@Composable
private fun Notice(title: String, text: String) {
    Card(
        Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.m, vertical = Tokens.Spacing.s),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer),
    ) {
        Row(Modifier.padding(Tokens.Spacing.m), horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m)) {
            Icon(Icons.Outlined.Info, null, tint = MaterialTheme.colorScheme.onPrimaryContainer)
            Column {
                Text(title, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onPrimaryContainer)
                Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onPrimaryContainer)
            }
        }
    }
}
