package com.weldsuite.weldcalendar.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.weldsuite.weldcalendar.CalendarEvent
import com.weldsuite.weldcalendar.CalendarInfo
import com.weldsuite.weldcalendar.CalendarRepository
import com.weldsuite.weldcalendar.Visibility
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.LoadState
import org.weldsuite.ui.RealtimeRefresh
import java.time.Instant

/** The events of one window (the agenda's two weeks, the month grid), and how loading them went. */
class EventWindow(private val repository: CalendarRepository) {
    var state by mutableStateOf(LoadState<List<CalendarEvent>>())
        private set

    /** Bumped per request: a slow answer for a month already paged past is dropped. */
    private var request = 0

    suspend fun load(start: Instant, end: Instant, calendarIds: String?) {
        val mine = ++request
        state = state.copy(loading = true, error = null)
        val result = runCatching { repository.events(start, end, calendarIds) }
        if (mine != request) return
        state = result.fold(
            onSuccess = { LoadState(it) },
            onFailure = { LoadState(state.data, error = it) },
        )
    }
}

/** What a window screen reads: the calendars, the window's events, and a reload for both. */
class WindowData(
    val calendars: LoadState<List<CalendarInfo>>,
    val events: LoadState<List<CalendarEvent>>,
    val reload: suspend () -> Unit,
) {
    val refreshing: Boolean get() = (calendars.loading && calendars.data != null) || (events.loading && events.data != null)
    val firstLoad: Boolean get() = calendars.isFirstLoad || (calendars.data != null && events.isFirstLoad)
    val failed: Throwable? get() = if (events.data == null) events.error ?: calendars.error.takeIf { calendars.data == null } else null
}

/**
 * The events between [start] and [end] on the calendars that aren't hidden,
 * held until the calendars are known (asking first would show the hidden
 * ones and then drop them), reloaded after a change, on the workspace hub's
 * word and with the visibility switches.
 */
@Composable
fun rememberWindow(env: AppEnvironment, repository: CalendarRepository, start: Instant, end: Instant): WindowData {
    val window = remember(repository) { EventWindow(repository) }
    val calendars by repository.calendars.collectAsStateWithLifecycle()
    val hidden by repository.hidden.collectAsStateWithLifecycle()
    val changes by repository.changes.collectAsStateWithLifecycle()
    val list = calendars.data
    val ids = list?.let { Visibility.calendarIdsParam(it, hidden) }
    val known = list != null
    LaunchedEffect(start, end, ids, changes, known) {
        if (known) window.load(start, end, ids)
    }
    RealtimeRefresh(env, CALENDAR_TOPICS) { if (known) window.load(start, end, ids) }
    return WindowData(calendars, window.state) {
        repository.refreshCalendars()
        val fresh = repository.calendars.value.data ?: return@WindowData
        window.load(start, end, Visibility.calendarIdsParam(fresh, repository.hidden.value))
    }
}
