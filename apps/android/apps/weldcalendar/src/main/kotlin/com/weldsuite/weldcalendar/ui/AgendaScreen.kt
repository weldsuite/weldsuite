package com.weldsuite.weldcalendar.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import com.weldsuite.weldcalendar.CalendarDates
import com.weldsuite.weldcalendar.CalendarRepository
import com.weldsuite.weldcalendar.EventLists
import com.weldsuite.weldcalendar.R
import com.weldsuite.weldcalendar.ScheduleGroup
import com.weldsuite.weldcalendar.eventColor
import kotlinx.coroutines.launch
import org.weldsuite.core.AppEnvironment
import org.weldsuite.ui.CenteredProgress
import org.weldsuite.ui.LoadErrorState
import org.weldsuite.ui.tagged
import java.time.LocalDate
import java.time.ZoneId

/** The groups whose heading names a single day. */
private val DAY_GROUPS = setOf(ScheduleGroup.YESTERDAY, ScheduleGroup.TODAY, ScheduleGroup.TOMORROW)

/**
 * The home tab: the next two weeks as the platform's schedule list, in its
 * groups (today, tomorrow, this week, next week, …). It reads the range
 * rather than "upcoming" so the meeting you're in and tentative holds show
 * too, and the hidden calendars stay out.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
fun AgendaScreen(
    env: AppEnvironment,
    repository: CalendarRepository,
    onOpen: (String) -> Unit,
    onNew: () -> Unit,
) {
    val zone = remember { ZoneId.systemDefault() }
    val today = LocalDate.now(zone)
    val window = remember(today) { CalendarDates.agendaWindow(today, zone) }
    val data = rememberWindow(env, repository, window.first, window.second)
    val scope = rememberCoroutineScope()

    Scaffold(
        topBar = {
            // The platform's name for this view, left-aligned like its page headers.
            TopAppBar(
                title = { Text(stringResource(R.string.weldcalendar_agenda_title), maxLines = 1, overflow = TextOverflow.Ellipsis) },
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
                val colors = remember(calendars) { calendars.associate { it.id to it.color } }
                val sections = remember(events, today) { EventLists.scheduleSections(events, today, zone) }
                LazyColumn(Modifier.fillMaxSize().tagged("agenda-list")) {
                    if (sections.isEmpty()) {
                        item("empty") {
                            CalendarEmptyState(
                                icon = Icons.Outlined.CalendarMonth,
                                title = stringResource(R.string.weldcalendar_agenda_empty_title),
                                description = stringResource(R.string.weldcalendar_agenda_empty_description),
                            )
                        }
                    }
                    sections.forEach { section ->
                        stickyHeader("group-${section.group}") {
                            GroupHeader(scheduleGroupLabel(section.group, today), section.events.size)
                        }
                        items(section.events, key = { "${section.group}-${it.id}" }) { event ->
                            EventRow(
                                event = event,
                                color = hexColor(eventColor(event.color, event.type, colors[event.calendarId])),
                                // Today, tomorrow and yesterday are named in the heading; the other groups span days.
                                showDate = section.group !in DAY_GROUPS,
                                onClick = { onOpen(event.id) },
                            )
                        }
                    }
                }
            }
        }
    }
}
