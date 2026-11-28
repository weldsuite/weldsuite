package com.weldsuite.weldcalendar.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.outlined.ViewAgenda
import androidx.compose.material3.Card
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.weldsuite.weldcalendar.CalendarDates
import com.weldsuite.weldcalendar.CalendarRepository
import com.weldsuite.weldcalendar.EventLists
import com.weldsuite.weldcalendar.R
import kotlinx.coroutines.launch
import org.weldsuite.core.AppEnvironment
import org.weldsuite.ui.CenteredProgress
import org.weldsuite.ui.EmptyState
import org.weldsuite.ui.LoadErrorState
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/**
 * The home tab: everything in the next two weeks, by day, under the day's
 * numbers. It reads the range rather than "upcoming" so the meeting you're
 * in and tentative holds show too, and the hidden calendars stay out.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AgendaScreen(
    env: AppEnvironment,
    repository: CalendarRepository,
    title: String,
    onOpen: (String) -> Unit,
    onNew: () -> Unit,
    onCalendars: () -> Unit,
) {
    val zone = remember { ZoneId.systemDefault() }
    val today = LocalDate.now(zone)
    val window = remember(today) { CalendarDates.agendaWindow(today, zone) }
    val data = rememberWindow(env, repository, window.first, window.second)
    val scope = rememberCoroutineScope()

    Scaffold(
        topBar = {
            CenterAlignedTopAppBar(
                title = { Text(title.ifBlank { stringResource(R.string.weldcalendar_agenda_title) }, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                actions = {
                    IconButton(onClick = onNew, modifier = Modifier.tagged("new-event")) {
                        Icon(Icons.Filled.Add, contentDescription = stringResource(R.string.weldcalendar_agenda_new_event))
                    }
                },
            )
        },
    ) { padding ->
        val failed = data.failed
        when {
            data.firstLoad -> CenteredProgress(Modifier.padding(padding))
            failed != null -> LoadErrorState(failed, onRetry = { scope.launch { data.reload() } }, modifier = Modifier.padding(padding))
            else -> PullToRefreshBox(
                isRefreshing = data.refreshing,
                onRefresh = { scope.launch { data.reload() } },
                modifier = Modifier.padding(padding).fillMaxSize(),
            ) {
                val events = data.events.data.orEmpty()
                val calendars = data.calendars.data.orEmpty()
                val names = remember(calendars) { calendars.associate { it.id to it.name } }
                val sections = remember(events) { EventLists.groupByDay(events, zone) }
                val counts = remember(events, today) { EventLists.counts(events, today, zone) }
                val now = Instant.now()
                LazyColumn(Modifier.fillMaxSize().tagged("agenda-list")) {
                    item("kpis") {
                        Row(
                            Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.s),
                            horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
                        ) {
                            Kpi(
                                label = stringResource(R.string.weldcalendar_agenda_today),
                                value = counts.today,
                                sub = pluralStringResource(R.plurals.weldcalendar_agenda_event_count, counts.today, counts.today),
                                tag = "kpi-today",
                                modifier = Modifier.weight(1f),
                            )
                            Kpi(
                                label = stringResource(R.string.weldcalendar_agenda_next7_days),
                                value = counts.nextSevenDays,
                                sub = pluralStringResource(R.plurals.weldcalendar_agenda_event_count, counts.nextSevenDays, counts.nextSevenDays),
                                tag = "kpi-week",
                                modifier = Modifier.weight(1f),
                            )
                            Kpi(
                                label = stringResource(R.string.weldcalendar_tabs_calendars),
                                value = calendars.size,
                                sub = pluralStringResource(R.plurals.weldcalendar_agenda_calendar_count, calendars.size, calendars.size),
                                tag = "kpi-calendars",
                                modifier = Modifier.weight(1f),
                                onClick = onCalendars,
                            )
                        }
                    }
                    if (sections.isEmpty()) {
                        item("empty") {
                            EmptyState(
                                title = stringResource(R.string.weldcalendar_agenda_empty_title),
                                description = stringResource(R.string.weldcalendar_agenda_empty_description),
                                icon = { Icon(Icons.Outlined.ViewAgenda, null, tint = MaterialTheme.colorScheme.onSurfaceVariant) },
                            )
                        }
                    }
                    sections.forEach { section ->
                        item("day-${section.day}") {
                            Row(
                                Modifier.fillMaxWidth().padding(start = Tokens.Spacing.l, end = Tokens.Spacing.l, top = 22.dp, bottom = 6.dp),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.Bottom,
                            ) {
                                Text(
                                    dayHeading(section.day, today),
                                    style = MaterialTheme.typography.titleSmall,
                                    fontWeight = FontWeight.Bold,
                                    color = if (section.day == today) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
                                )
                                Text(
                                    pluralStringResource(R.plurals.weldcalendar_agenda_event_count, section.events.size, section.events.size),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                        items(section.events, key = { "${section.day}-${it.id}" }) { event ->
                            EventRow(
                                event = event,
                                calendarName = if (calendars.size > 1) names[event.calendarId] else null,
                                now = now,
                                onClick = { onOpen(event.id) },
                            )
                        }
                    }
                }
            }
        }
    }
}

/** One of the agenda's numbers, in a card. */
@Composable
private fun Kpi(label: String, value: Int, sub: String, tag: String, modifier: Modifier = Modifier, onClick: (() -> Unit)? = null) {
    Card(modifier = modifier.tagged(tag).let { if (onClick != null) it.clickable(onClick = onClick) else it }) {
        Column(Modifier.padding(Tokens.Spacing.m)) {
            Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
            Text(value.toString(), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
            Text(sub, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
        }
    }
}
