package com.weldsuite.weldcalendar.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.weldsuite.weldcalendar.CalendarDates
import com.weldsuite.weldcalendar.CalendarEvent
import com.weldsuite.weldcalendar.CalendarRepository
import com.weldsuite.weldcalendar.EventLists
import com.weldsuite.weldcalendar.R
import com.weldsuite.weldcalendar.eventColor
import kotlinx.coroutines.launch
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.R as CoreR
import org.weldsuite.ui.CenteredProgress
import org.weldsuite.ui.LoadErrorState
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged
import java.time.LocalDate
import java.time.YearMonth
import java.time.ZoneId
import java.time.format.TextStyle

/**
 * The month as the platform's phone month view draws it, over the chosen
 * day's events. It asks for the whole six-week grid, with a day of slack.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
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
    // Paging moves the selection into the new month: today there, else its first day.
    val showMonth: (YearMonth) -> Unit = { next ->
        month = next
        selected = if (YearMonth.from(today) == next) today else next.atDay(1)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(dateText(month.atDay(1), "LLLLyyyy").replaceFirstChar { it.titlecase(currentLocale()) }) },
                actions = {
                    TextButton(
                        onClick = {
                            month = YearMonth.from(today)
                            selected = today
                        },
                        modifier = Modifier.tagged("month-today"),
                    ) { Text(stringResource(CoreR.string.core_common_today), color = MaterialTheme.colorScheme.onSurface) }
                    IconButton(onClick = { showMonth(month.minusMonths(1)) }, modifier = Modifier.tagged("month-previous")) {
                        Icon(Icons.AutoMirrored.Filled.KeyboardArrowLeft, stringResource(R.string.weldcalendar_month_previous_month))
                    }
                    IconButton(onClick = { showMonth(month.plusMonths(1)) }, modifier = Modifier.tagged("month-next")) {
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
                val colors = remember(calendars) { calendars.associate { it.id to it.color } }
                val counts = remember(events) { EventLists.dayCounts(events, zone) }
                val dayEvents = remember(events, selected) { EventLists.on(selected, events, zone) }
                LazyColumn(Modifier.fillMaxSize()) {
                    item("grid") {
                        MonthGrid(month = month, selected = selected, today = today, counts = counts, onSelect = { selected = it })
                    }
                    stickyHeader("day") {
                        GroupHeader(dayLabel(selected, today), dayEvents.size)
                    }
                    if (dayEvents.isEmpty()) {
                        item("empty") {
                            CalendarEmptyState(
                                icon = Icons.Outlined.CalendarMonth,
                                title = stringResource(R.string.weldcalendar_month_no_events_title),
                                description = stringResource(R.string.weldcalendar_month_no_events_description),
                            )
                        }
                    }
                    items(dayEvents, key = CalendarEvent::id) { event ->
                        EventRow(
                            event = event,
                            color = hexColor(eventColor(event.color, event.type, colors[event.calendarId])),
                            // The heading names the day.
                            showDate = false,
                            onClick = { onOpen(event.id) },
                        )
                    }
                }
            }
        }
    }
}

/**
 * Monday-first weeks of [month], as the platform's phone month: the
 * neighbouring months' days left blank, today in the platform's blue, the
 * selected day filled (blue when it's today), and a muted dot under a day
 * with events.
 */
@Composable
private fun MonthGrid(
    month: YearMonth,
    selected: LocalDate,
    today: LocalDate,
    counts: Map<LocalDate, Int>,
    onSelect: (LocalDate) -> Unit,
) {
    val locale = currentLocale()
    val weeks = remember(month) { CalendarDates.monthMatrix(month).filter { week -> week.any { YearMonth.from(it) == month } } }
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val foreground = MaterialTheme.colorScheme.onSurface
    val background = MaterialTheme.colorScheme.background
    Column(Modifier.tagged("month-grid")) {
        Row(Modifier.fillMaxWidth()) {
            (0 until 7).forEach { index ->
                val day = CalendarDates.WEEK_START.plus(index.toLong())
                Text(
                    day.getDisplayName(TextStyle.NARROW, locale).uppercase(locale),
                    modifier = Modifier.weight(1f).padding(vertical = Tokens.Spacing.s),
                    style = MaterialTheme.typography.labelSmall,
                    color = muted,
                    textAlign = TextAlign.Center,
                )
            }
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        Spacer(Modifier.height(Tokens.Spacing.xs))
        weeks.forEach { week ->
            Row(Modifier.fillMaxWidth()) {
                week.forEach { day ->
                    if (YearMonth.from(day) != month) {
                        Spacer(Modifier.weight(1f).height(48.dp))
                    } else {
                        DayCell(
                            day = day,
                            isToday = day == today,
                            isSelected = day == selected,
                            count = counts[day] ?: 0,
                            foreground = foreground,
                            background = background,
                            muted = muted,
                            onSelect = onSelect,
                            modifier = Modifier.weight(1f),
                        )
                    }
                }
            }
        }
        Spacer(Modifier.height(Tokens.Spacing.s))
    }
}

@Composable
private fun DayCell(
    day: LocalDate,
    isToday: Boolean,
    isSelected: Boolean,
    count: Int,
    foreground: Color,
    background: Color,
    muted: Color,
    onSelect: (LocalDate) -> Unit,
    modifier: Modifier,
) {
    val date = dateText(day, "EEEEMMMMd")
    val label = if (count > 0) "$date, ${pluralStringResource(R.plurals.weldcalendar_agenda_event_count, count, count)}" else date
    Box(
        modifier = modifier
            .height(48.dp)
            .clickable { onSelect(day) }
            .semantics {
                contentDescription = label
                this.selected = isSelected
            }
            .tagged("month-day-$day"),
        contentAlignment = Alignment.TopCenter,
    ) {
        val fill = when {
            isSelected && isToday -> TodayBlue
            isSelected -> foreground
            else -> Color.Transparent
        }
        Box(
            Modifier.padding(top = 6.dp).size(32.dp).background(fill, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                day.dayOfMonth.toString(),
                fontSize = 14.sp,
                fontWeight = if (isToday && !isSelected) FontWeight.SemiBold else FontWeight.Normal,
                color = when {
                    isSelected && isToday -> Color.White
                    isSelected -> background
                    isToday -> TodayBlue
                    else -> foreground
                },
            )
        }
        if (count > 0) {
            Box(Modifier.align(Alignment.BottomCenter).padding(bottom = 4.dp).size(4.dp).background(muted, CircleShape))
        }
    }
}

/** `rememberSaveable` for a month: a `YearMonth` is serializable, so it survives as one. */
private fun mutableYearMonth(value: YearMonth) = androidx.compose.runtime.mutableStateOf(value)

private fun mutableDate(value: LocalDate) = androidx.compose.runtime.mutableStateOf(value)
