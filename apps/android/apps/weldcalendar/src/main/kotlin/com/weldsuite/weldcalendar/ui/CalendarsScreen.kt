package com.weldsuite.weldcalendar.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import org.weldsuite.ui.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
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
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.weldsuite.weldcalendar.CalendarAccess
import com.weldsuite.weldcalendar.CalendarInfo
import com.weldsuite.weldcalendar.CalendarRepository
import com.weldsuite.weldcalendar.CalendarSwatch
import com.weldsuite.weldcalendar.R
import kotlinx.coroutines.launch
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.apiErrorMessage
import org.weldsuite.core.R as CoreR
import org.weldsuite.ui.Button
import org.weldsuite.ui.CenteredProgress
import org.weldsuite.ui.LoadErrorState
import org.weldsuite.ui.OutlinedButton
import org.weldsuite.ui.RealtimeRefresh
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged

/**
 * The person's calendars and the ones shared with them, as the platform's
 * sidebar lists them: each with a checkbox in its colour that decides whether
 * the agenda and the grid show it. A member who owns none gets the default
 * one made for them.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
fun CalendarsScreen(env: AppEnvironment, repository: CalendarRepository) {
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
                            CalendarEmptyState(
                                icon = Icons.Outlined.CalendarMonth,
                                title = stringResource(R.string.weldcalendar_calendars_empty_title),
                                description = stringResource(R.string.weldcalendar_calendars_empty_description),
                            )
                        }
                    }
                    if (own.isNotEmpty()) {
                        stickyHeader("own") { GroupHeader(stringResource(R.string.weldcalendar_calendars_mine), own.size) }
                        items(own, key = { "own-${it.id}" }) { calendar ->
                            CalendarRow(calendar, visible = calendar.id !in hidden) { repository.toggleHidden(calendar.id) }
                        }
                    }
                    if (shared.isNotEmpty()) {
                        stickyHeader("shared") { GroupHeader(stringResource(R.string.weldcalendar_calendars_shared), shared.size) }
                        items(shared, key = { "shared-${it.id}" }) { calendar ->
                            CalendarRow(calendar, visible = calendar.id !in hidden) { repository.toggleHidden(calendar.id) }
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

/** A calendar: its checkbox, filled with its colour while it shows, and its name. */
@Composable
private fun CalendarRow(calendar: CalendarInfo, visible: Boolean, onToggle: () -> Unit) {
    Column {
        Row(
            Modifier
                .fillMaxWidth()
                .toggleable(value = visible, role = Role.Checkbox, onValueChange = { onToggle() })
                .tagged("calendar-visible-${calendar.id}")
                .padding(horizontal = Tokens.Spacing.l, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m),
        ) {
            CalendarCheckbox(hexColor(calendar.color), visible)
            Text(calendar.name, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
    }
}

/** The platform sidebar's checkbox: the calendar's colour with a white tick when checked, its outline when not. */
@Composable
private fun CalendarCheckbox(color: Color, checked: Boolean) {
    val shape = RoundedCornerShape(4.dp)
    Box(
        Modifier
            .size(18.dp)
            .then(if (checked) Modifier.background(color, shape) else Modifier.border(1.5.dp, color, shape)),
        contentAlignment = Alignment.Center,
    ) {
        if (checked) Icon(Icons.Filled.Check, null, Modifier.size(14.dp), tint = Color.White)
    }
}

/** The platform's "Create Calendar": a name and one of its ten colours, blue by default. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun NewCalendarSheet(repository: CalendarRepository, onDismiss: () -> Unit) {
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    val notify = LocalNotify.current
    var name by remember { mutableStateOf("") }
    var color by remember { mutableStateOf(CalendarSwatch.BLUE) }
    var saving by remember { mutableStateOf(false) }
    val failed = stringResource(R.string.weldcalendar_calendars_create_failed)
    val context = androidx.compose.ui.platform.LocalContext.current

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet) {
        Column(
            Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l).padding(bottom = Tokens.Spacing.xl).imePadding(),
            verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.l),
        ) {
            Text(stringResource(R.string.weldcalendar_calendars_new_calendar), style = MaterialTheme.typography.titleLarge)
            Column(verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
                Text(stringResource(R.string.weldcalendar_calendars_name_label), style = MaterialTheme.typography.labelLarge)
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    placeholder = { Text(stringResource(R.string.weldcalendar_calendars_name_placeholder)) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth().tagged("calendar-name"),
                )
            }
            Column(verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
                Text(stringResource(R.string.weldcalendar_calendars_color_label), style = MaterialTheme.typography.labelLarge)
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    CalendarSwatch.entries.forEach { option ->
                        val label = swatchName(option)
                        val chosen = option == color
                        Box(
                            Modifier
                                .scale(if (chosen) 1.1f else 1f)
                                .size(28.dp)
                                .background(hexColor(option.hex), RoundedCornerShape(Tokens.Radius.medium))
                                .border(2.dp, if (chosen) MaterialTheme.colorScheme.onSurface else Color.Transparent, RoundedCornerShape(Tokens.Radius.medium))
                                .clickable { color = option }
                                .semantics {
                                    contentDescription = label
                                    selected = chosen
                                }
                                .tagged("calendar-color-${option.ordinal}"),
                        )
                    }
                }
            }
            Spacer(Modifier.height(Tokens.Spacing.xs))
            Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s), modifier = Modifier.align(Alignment.End)) {
                OutlinedButton(onClick = onDismiss) { Text(stringResource(CoreR.string.core_common_cancel)) }
                Button(
                    onClick = {
                        saving = true
                        scope.launch {
                            runCatching { repository.createCalendar(name.trim(), "", color.hex) }
                                .onSuccess {
                                    sheet.hide()
                                    onDismiss()
                                }
                                .onFailure { error -> notify(failureText(failed, context.getString(apiErrorMessage(error)))) }
                            saving = false
                        }
                    },
                    // Without a name there is nothing to create, as on the platform.
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

@Composable
private fun swatchName(swatch: CalendarSwatch): String = stringResource(
    when (swatch) {
        CalendarSwatch.BLUE -> R.string.weldcalendar_calendars_color_names_blue
        CalendarSwatch.RED -> R.string.weldcalendar_calendars_color_names_red
        CalendarSwatch.GREEN -> R.string.weldcalendar_calendars_color_names_green
        CalendarSwatch.AMBER -> R.string.weldcalendar_calendars_color_names_amber
        CalendarSwatch.VIOLET -> R.string.weldcalendar_calendars_color_names_violet
        CalendarSwatch.PINK -> R.string.weldcalendar_calendars_color_names_pink
        CalendarSwatch.CYAN -> R.string.weldcalendar_calendars_color_names_cyan
        CalendarSwatch.ORANGE -> R.string.weldcalendar_calendars_color_names_orange
        CalendarSwatch.TEAL -> R.string.weldcalendar_calendars_color_names_teal
        CalendarSwatch.INDIGO -> R.string.weldcalendar_calendars_color_names_indigo
    },
)
