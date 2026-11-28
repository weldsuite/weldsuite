package com.weldsuite.weldcalendar.ui

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.DateRange
import androidx.compose.material.icons.outlined.MoreHoriz
import androidx.compose.material.icons.outlined.ViewAgenda
import androidx.compose.material3.Icon
import org.weldsuite.ui.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.weldsuite.weldcalendar.CalendarDates
import com.weldsuite.weldcalendar.CalendarLink
import com.weldsuite.weldcalendar.CalendarRepository
import com.weldsuite.weldcalendar.R
import com.weldsuite.weldcalendar.eventIdFromPush
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.SessionState
import org.weldsuite.push.NotificationPermissionRequest
import org.weldsuite.push.WeldPush
import org.weldsuite.ui.TabLabel
import org.weldsuite.ui.AppearancePreference
import org.weldsuite.ui.RealtimeRefresh
import org.weldsuite.ui.ToastHost
import org.weldsuite.ui.Toaster
import org.weldsuite.ui.tagged

/** Shows a short message at the bottom of the screen ("Couldn't delete the event"). */
val LocalNotify = staticCompositionLocalOf<(String) -> Unit> { {} }

private enum class Tab(val route: String, val label: Int, val icon: ImageVector, val tag: String) {
    Agenda("agenda", R.string.weldcalendar_tabs_agenda, Icons.Outlined.ViewAgenda, "tab-agenda"),
    Month("month", R.string.weldcalendar_tabs_month, Icons.Outlined.CalendarMonth, "tab-month"),
    Calendars("calendars", R.string.weldcalendar_tabs_calendars, Icons.Outlined.DateRange, "tab-calendars"),
    More("more", R.string.weldcalendar_tabs_more, Icons.Outlined.MoreHoriz, "tab-more"),
}

/** WeldCalendar once signed in, in a workspace and unlocked. */
@Composable
fun WeldCalendarApp(
    env: AppEnvironment,
    repository: CalendarRepository,
    session: SessionState.Ready,
    appearance: AppearancePreference,
    link: CalendarLink?,
    onLinkTaken: () -> Unit,
) {
    NotificationPermissionRequest()
    val nav = rememberNavController()
    val toaster = remember { Toaster() }
    val scope = rememberCoroutineScope()
    val notify: (String) -> Unit = { message -> toaster.show(message, scope) }

    LaunchedEffect(session.workspace.id) {
        repository.useWorkspace(session.workspace.id)
        repository.refreshCalendars()
    }
    RealtimeRefresh(env, CALENDAR_TOPICS) { repository.refreshCalendars() }

    // A tapped notification opens its event, as the Expo app's handler did.
    val tap by WeldPush.pendingTap.collectAsStateWithLifecycle()
    LaunchedEffect(tap) {
        if (tap == null) return@LaunchedEffect
        val payload = WeldPush.takeTap() ?: return@LaunchedEffect
        eventIdFromPush(payload.values)?.let { nav.navigate("event/$it") }
    }
    LaunchedEffect(link) {
        val target = link ?: return@LaunchedEffect
        onLinkTaken()
        when (target) {
            is CalendarLink.Event -> nav.navigate("event/${target.id}")
            is CalendarLink.EditEvent -> nav.navigate("event/edit/${target.id}")
            is CalendarLink.NewEvent -> nav.navigate("event/new?date=${target.day?.toString().orEmpty()}")
            is CalendarLink.Tab -> Tab.entries.firstOrNull { it.route == target.route }?.let { nav.openTab(it) }
        }
    }

    val entry by nav.currentBackStackEntryAsState()
    val route = entry?.destination?.route
    val onTab = route == null || Tab.entries.any { it.route == route }

    CompositionLocalProvider(LocalNotify provides notify) {
        ToastHost(toaster) {
            Scaffold(
                contentWindowInsets = WindowInsets(0),
                bottomBar = { if (onTab) TabBar(nav, route) },
            ) { padding ->
                val bottom = PaddingValues(bottom = padding.calculateBottomPadding())
                NavHost(nav, startDestination = Tab.Agenda.route, modifier = Modifier.padding(bottom).consumeWindowInsets(bottom)) {
                    composable(Tab.Agenda.route) {
                        AgendaScreen(
                            env = env,
                            repository = repository,
                            onOpen = { nav.navigate("event/$it") },
                            onNew = { nav.navigate("event/new?date=") },
                        )
                    }
                    composable(Tab.Month.route) {
                        MonthScreen(
                            env = env,
                            repository = repository,
                            onOpen = { nav.navigate("event/$it") },
                            onNew = { day -> nav.navigate("event/new?date=$day") },
                        )
                    }
                    composable(Tab.Calendars.route) {
                        CalendarsScreen(env = env, repository = repository)
                    }
                    composable(Tab.More.route) {
                        SettingsScreen(env = env, session = session, appearance = appearance)
                    }
                    composable("event/{eventId}") { backStack ->
                        EventScreen(
                            env = env,
                            repository = repository,
                            eventId = backStack.arguments?.getString("eventId").orEmpty(),
                            onBack = { nav.popBackStack() },
                            onEdit = { nav.navigate("event/edit/$it") },
                        )
                    }
                    composable(
                        "event/new?date={date}",
                        arguments = listOf(navArgument("date") { defaultValue = "" }),
                    ) { backStack ->
                        EventFormScreen(
                            repository = repository,
                            eventId = null,
                            day = CalendarDates.parseDay(backStack.arguments?.getString("date")),
                            onDone = { nav.popBackStack() },
                        )
                    }
                    composable("event/edit/{eventId}") { backStack ->
                        EventFormScreen(
                            repository = repository,
                            eventId = backStack.arguments?.getString("eventId").orEmpty(),
                            day = null,
                            onDone = { nav.popBackStack() },
                        )
                    }
                }
            }
        }
    }
}

private fun NavHostController.openTab(tab: Tab) {
    navigate(tab.route) {
        popUpTo(graph.findStartDestination().id) { saveState = true }
        launchSingleTop = true
        restoreState = true
    }
}

@Composable
private fun TabBar(nav: NavHostController, route: String?) {
    NavigationBar {
        Tab.entries.forEach { tab ->
            NavigationBarItem(
                selected = route == tab.route || (route == null && tab == Tab.Agenda),
                onClick = { nav.openTab(tab) },
                icon = { Icon(tab.icon, contentDescription = null) },
                label = { TabLabel(stringResource(tab.label)) },
                modifier = Modifier.tagged(tab.tag),
            )
        }
    }
}
