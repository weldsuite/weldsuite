package com.weldsuite.weldcalendar.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.weldsuite.weldcalendar.CalendarDates
import com.weldsuite.weldcalendar.CalendarEvent
import com.weldsuite.weldcalendar.CalendarRepository
import com.weldsuite.weldcalendar.DayDots
import com.weldsuite.weldcalendar.EventLists
import com.weldsuite.weldcalendar.R
import kotlinx.coroutines.launch
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.R as CoreR
import org.weldsuite.ui.CenteredProgress
import org.weldsuite.ui.EmptyState
import org.weldsuite.ui.LoadErrorState
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged
import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.YearMonth
import java.time.ZoneId
import java.time.format.TextStyle

/**
 * The month grid over the chosen day's events. It asks for the whole grid,
 * not just the month: the first and last rows spill into the neighbouring
 * months, and their squares should show their dots too.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MonthScreen(
    env: AppEnvironment,
    repository: CalendarRepository,
    onOpen: (String) -> Unit,
    onNew: (LocalDate) -> Unit,
) {
    val zone = remember { ZoneId.systemDefault() }
    val today = LocalDate.now(zone)
    var month by rememberSaveable { mutableYearMonth(YearMonth.from(today)) }
    var selected by rememberSaveable { mutableDate(today) }
    val window = remember(month) { CalendarDates.monthWindow(month, zone) }
    val data = rememberWindow(env, repository, window.first, window.second)
    val scope = rememberCoroutineScope()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(dateText(month.atDay(1), "LLLLyyyy").replaceFirstChar { it.titlecase(currentLocale()) }) },
                actions = {
                    IconButton(onClick = { month = month.minusMonths(1) }, modifier = Modifier.tagged("month-previous")) {
                        Icon(Icons.AutoMirrored.Filled.KeyboardArrowLeft, stringResource(R.string.weldcalendar_month_previous_month))
                    }
                    IconButton(onClick = { month = month.plusMonths(1) }, modifier = Modifier.tagged("month-next")) {
                        Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, stringResource(R.string.weldcalendar_month_next_month))
                    }
                    IconButton(onClick = { onNew(selected) }, modifier = Modifier.tagged("month-new-event")) {
                        Icon(Icons.Filled.Add, stringResource(R.string.weldcalendar_agenda_new_event))
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
                val dots = remember(events) { EventLists.dots(events, zone) }
                val dayEvents = remember(events, selected) { EventLists.on(selected, events, zone) }
                val now = Instant.now()
                LazyColumn(Modifier.fillMaxSize()) {
                    item("grid") {
                        MonthGrid(
                            month = month,
                            selected = selected,
                            today = today,
                            dots = dots,
                            onSelect = { day ->
                                selected = day
                                // A spill-over square moves the grid to its month.
                                if (YearMonth.from(day) != month) month = YearMonth.from(day)
                            },
                        )
                    }
                    item("day") {
                        HorizontalDivider(Modifier.padding(top = 10.dp))
                        Row(
                            Modifier.fillMaxWidth().padding(start = Tokens.Spacing.l, end = Tokens.Spacing.s, top = Tokens.Spacing.s),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.SpaceBetween,
                        ) {
                            Text(dayHeading(selected, today), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                            if (selected != today) {
                                TextButton(
                                    onClick = {
                                        selected = today
                                        month = YearMonth.from(today)
                                    },
                                    modifier = Modifier.tagged("month-today"),
                                ) { Text(stringResource(CoreR.string.core_common_today)) }
                            } else {
                                Box(Modifier.height(48.dp))
                            }
                        }
                    }
                    if (dayEvents.isEmpty()) {
                        item("empty") {
                            EmptyState(
                                title = stringResource(R.string.weldcalendar_month_no_events_title),
                                description = stringResource(R.string.weldcalendar_month_no_events_description),
                                icon = { Icon(Icons.Outlined.CalendarMonth, null, tint = MaterialTheme.colorScheme.onSurfaceVariant) },
                            )
                        }
                    }
                    items(dayEvents, key = CalendarEvent::id) { event ->
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

/** Monday-first, six rows always, at most three dots a day and a "+n". */
@Composable
private fun MonthGrid(
    month: YearMonth,
    selected: LocalDate,
    today: LocalDate,
    dots: Map<LocalDate, DayDots>,
    onSelect: (LocalDate) -> Unit,
) {
    val locale = currentLocale()
    val weeks = remember(month) { CalendarDates.monthMatrix(month) }
    val brand = MaterialTheme.colorScheme.primary
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Column(Modifier.padding(horizontal = Tokens.Spacing.s).tagged("month-grid")) {
        Row(Modifier.fillMaxWidth().padding(bottom = 4.dp)) {
            (0 until 7).forEach { index ->
                val day = DayOfWeek.MONDAY.plus(index.toLong())
                Text(
                    day.getDisplayName(TextStyle.NARROW, locale).uppercase(locale),
                    modifier = Modifier.weight(1f),
                    style = MaterialTheme.typography.labelSmall,
                    fontWeight = FontWeight.Bold,
                    color = muted,
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                )
            }
        }
        weeks.forEach { week ->
            Row(Modifier.fillMaxWidth()) {
                week.forEach { day ->
                    val inMonth = YearMonth.from(day) == month
                    val isSelected = day == selected
                    val isToday = day == today
                    val entry = dots[day]
                    val label = dateText(day, "EEEEdMMMM")
                    Column(
                        modifier = Modifier
                            .weight(1f)
                            .heightIn(min = 48.dp)
                            .clickable { onSelect(day) }
                            .semantics {
                                contentDescription = label
                                this.selected = isSelected
                            }
                            .tagged("month-day-$day")
                            .padding(vertical = 3.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Box(
                            Modifier
                                .size(32.dp)
                                .then(
                                    when {
                                        isSelected -> Modifier.background(brand, CircleShape)
                                        isToday -> Modifier.border(1.5.dp, brand, CircleShape)
                                        else -> Modifier
                                    },
                                ),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                day.dayOfMonth.toString(),
                                fontSize = 15.sp,
                                fontWeight = if (isSelected || isToday) FontWeight.Bold else FontWeight.Normal,
                                color = when {
                                    isSelected -> MaterialTheme.colorScheme.onPrimary
                                    isToday -> brand
                                    inMonth -> MaterialTheme.colorScheme.onSurface
                                    else -> muted
                                },
                                modifier = Modifier.alpha(if (!inMonth && !isSelected) 0.45f else 1f),
                            )
                        }
                        Row(
                            Modifier.height(9.dp).padding(top = 2.dp).alpha(if (inMonth) 1f else 0.35f),
                            horizontalArrangement = Arrangement.spacedBy(3.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            entry?.colors?.forEach { hex ->
                                Box(Modifier.size(5.dp).background(hexColor(hex), CircleShape))
                            }
                            if (entry != null && entry.overflow > 0) {
                                Text("+${entry.overflow}", fontSize = 8.sp, color = muted, lineHeight = 8.sp)
                            }
                        }
                    }
                }
            }
        }
    }
}

/** `rememberSaveable` for a month: a `YearMonth` is serializable, so it survives as one. */
private fun mutableYearMonth(value: YearMonth) = androidx.compose.runtime.mutableStateOf(value)

private fun mutableDate(value: LocalDate) = androidx.compose.runtime.mutableStateOf(value)
