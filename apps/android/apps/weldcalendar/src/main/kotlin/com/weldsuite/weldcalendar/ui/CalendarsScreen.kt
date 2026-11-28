package com.weldsuite.weldcalendar.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.outlined.DateRange
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.weldsuite.weldcalendar.CALENDAR_COLORS
import com.weldsuite.weldcalendar.CalendarAccess
import com.weldsuite.weldcalendar.CalendarInfo
import com.weldsuite.weldcalendar.CalendarPermission
import com.weldsuite.weldcalendar.CalendarRepository
import com.weldsuite.weldcalendar.R
import kotlinx.coroutines.launch
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.apiErrorMessage
import org.weldsuite.core.R as CoreR
import org.weldsuite.ui.CenteredProgress
import org.weldsuite.ui.EmptyState
import org.weldsuite.ui.LoadErrorState
import org.weldsuite.ui.RealtimeRefresh
import org.weldsuite.ui.StatusBadge
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged

/**
 * The person's calendars and the ones shared with them, each with a switch
 * that decides whether the agenda and the grid show it. A member who owns
 * none gets the default one made for them.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CalendarsScreen(env: AppEnvironment, repository: CalendarRepository, workspaceName: String) {
    val state by repository.calendars.collectAsStateWithLifecycle()
    val hidden by repository.hidden.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val notify = LocalNotify.current
    var creating by remember { mutableStateOf(false) }
    val ensureFailed = stringResource(R.string.weldcalendar_calendars_ensure_failed)

    RealtimeRefresh(env, CALENDAR_TOPICS) { repository.refreshCalendars() }
    val loaded = state.data != null
    LaunchedEffect(loaded) {
        if (loaded) repository.ensureDefaultIfNeeded().onFailure { notify(ensureFailed) }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.weldcalendar_calendars_title)) },
                actions = {
                    IconButton(onClick = { creating = true }, modifier = Modifier.tagged("new-calendar")) {
                        Icon(Icons.Filled.Add, stringResource(R.string.weldcalendar_calendars_new_calendar))
                    }
                },
            )
        },
    ) { padding ->
        val calendars = state.data
        when {
            state.isFirstLoad -> CenteredProgress(Modifier.padding(padding))
            calendars == null -> LoadErrorState(state.error, onRetry = { scope.launch { repository.refreshCalendars() } }, modifier = Modifier.padding(padding))
            else -> PullToRefreshBox(
                isRefreshing = state.loading,
                onRefresh = { scope.launch { repository.refreshCalendars() } },
                modifier = Modifier.padding(padding).fillMaxSize(),
            ) {
                val (own, shared) = CalendarAccess.sections(calendars)
                LazyColumn(Modifier.fillMaxSize()) {
                    if (calendars.isEmpty()) {
                        item("empty") {
                            EmptyState(
                                title = stringResource(R.string.weldcalendar_calendars_empty_title),
                                description = stringResource(R.string.weldcalendar_calendars_empty_description),
                                icon = { Icon(Icons.Outlined.DateRange, null, tint = MaterialTheme.colorScheme.onSurfaceVariant) },
                            )
                        }
                    }
                    if (own.isNotEmpty()) {
                        item("own") { SectionTitle(workspaceName.ifBlank { stringResource(R.string.weldcalendar_calendars_workspace) }) }
                        items(own, key = { "own-${it.id}" }) { calendar ->
                            CalendarRow(calendar, visible = calendar.id !in hidden) { repository.toggleHidden(calendar.id) }
                        }
                    }
                    if (shared.isNotEmpty()) {
                        item("shared") { SectionTitle(stringResource(R.string.weldcalendar_calendars_shared)) }
                        items(shared, key = { "shared-${it.id}" }) { calendar ->
                            CalendarRow(calendar, visible = calendar.id !in hidden) { repository.toggleHidden(calendar.id) }
                        }
                    }
                    if (calendars.isNotEmpty()) {
                        item("hint") {
                            Text(
                                stringResource(R.string.weldcalendar_calendars_visibility_hint),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.l),
                            )
                        }
                    }
                }
            }
        }
    }

    if (creating) {
        NewCalendarSheet(repository = repository, onDismiss = { creating = false })
    }
}

@Composable
private fun CalendarRow(calendar: CalendarInfo, visible: Boolean, onToggle: () -> Unit) {
    val subtitle = if (calendar.isOwn) {
        calendar.description ?: permissionLabel(CalendarPermission.MANAGE)
    } else {
        permissionLabel(calendar.permission)
    }
    val show = stringResource(R.string.weldcalendar_calendars_show, calendar.name)
    ListItem(
        leadingContent = { ColorDot(calendar.color, size = 18) },
        headlineContent = {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
                Text(calendar.name, maxLines = 1, modifier = Modifier.weight(1f, fill = false))
                if (calendar.isDefault) {
                    StatusBadge(stringResource(R.string.weldcalendar_calendars_default_badge), MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        },
        supportingContent = { Text(subtitle, maxLines = 1) },
        trailingContent = {
            Switch(
                checked = visible,
                onCheckedChange = { onToggle() },
                modifier = Modifier.semantics { contentDescription = show }.tagged("calendar-visible-${calendar.id}"),
            )
        },
        modifier = Modifier.clickable(onClick = onToggle).tagged("calendar-${calendar.id}"),
    )
}

/** A new calendar: a name, an optional description and one of the palette's colours. */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
private fun NewCalendarSheet(repository: CalendarRepository, onDismiss: () -> Unit) {
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    val notify = LocalNotify.current
    var name by remember { mutableStateOf("") }
    var description by remember { mutableStateOf("") }
    var color by remember { mutableStateOf(CALENDAR_COLORS.first()) }
    var nameError by remember { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    val failed = stringResource(R.string.weldcalendar_calendars_create_failed)
    val context = androidx.compose.ui.platform.LocalContext.current

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet) {
        Column(
            Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l).padding(bottom = Tokens.Spacing.xl).imePadding(),
            verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.m),
        ) {
            Text(stringResource(R.string.weldcalendar_calendars_new_calendar), style = MaterialTheme.typography.titleLarge)
            OutlinedTextField(
                value = name,
                onValueChange = {
                    name = it
                    nameError = false
                },
                label = { Text(stringResource(R.string.weldcalendar_calendars_name_label)) },
                placeholder = { Text(stringResource(R.string.weldcalendar_calendars_name_placeholder)) },
                isError = nameError,
                supportingText = if (nameError) {
                    { Text(stringResource(R.string.weldcalendar_calendars_name_required)) }
                } else {
                    null
                },
                singleLine = true,
                modifier = Modifier.fillMaxWidth().tagged("calendar-name"),
            )
            OutlinedTextField(
                value = description,
                onValueChange = { description = it },
                label = { Text(stringResource(R.string.weldcalendar_calendars_description_label)) },
                placeholder = { Text(stringResource(R.string.weldcalendar_calendars_description_placeholder)) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth().tagged("calendar-description"),
            )
            Text(stringResource(R.string.weldcalendar_calendars_color_label), style = MaterialTheme.typography.labelLarge)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                CALENDAR_COLORS.forEachIndexed { index, option ->
                    val label = stringResource(R.string.weldcalendar_calendars_color_option, (index + 1).toString())
                    Box(
                        Modifier
                            .size(36.dp)
                            .background(hexColor(option), CircleShape)
                            .border(2.dp, if (option == color) MaterialTheme.colorScheme.onSurface else Color.Transparent, CircleShape)
                            .clickable { color = option }
                            .semantics {
                                contentDescription = label
                                selected = option == color
                            }
                            .tagged("calendar-color-$index"),
                        contentAlignment = Alignment.Center,
                    ) {
                        if (option == color) Icon(Icons.Filled.Check, null, tint = Color.White, modifier = Modifier.size(18.dp))
                    }
                }
            }
            Spacer(Modifier.height(Tokens.Spacing.s))
            Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s), modifier = Modifier.align(Alignment.End)) {
                OutlinedButton(onClick = onDismiss) { Text(stringResource(CoreR.string.core_common_cancel)) }
                Button(
                    onClick = {
                        if (name.isBlank()) {
                            nameError = true
                            return@Button
                        }
                        saving = true
                        scope.launch {
                            runCatching { repository.createCalendar(name, description, color) }
                                .onSuccess {
                                    sheet.hide()
                                    onDismiss()
                                }
                                .onFailure { error -> notify(failureText(failed, context.getString(apiErrorMessage(error)))) }
                            saving = false
                        }
                    },
                    enabled = !saving && name.isNotBlank(),
                    modifier = Modifier.tagged("create-calendar"),
                ) {
                    if (saving) {
                        CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                    } else {
                        Text(stringResource(R.string.weldcalendar_common_create))
                    }
                }
            }
        }
    }
}
