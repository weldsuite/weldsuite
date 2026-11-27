package com.weldsuite.welddesk.ui

import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Inbox
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
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
import com.weldsuite.welddesk.DeskLinks
import com.weldsuite.welddesk.DeskLogic
import com.weldsuite.welddesk.DeskRepository
import com.weldsuite.welddesk.DeskRoute
import com.weldsuite.welddesk.R
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.SessionState
import org.weldsuite.push.NotificationPermissionRequest
import org.weldsuite.push.WeldPush
import org.weldsuite.ui.AppearancePreference
import org.weldsuite.ui.ToastHost
import org.weldsuite.ui.Toaster
import org.weldsuite.ui.WorkspacePicker
import org.weldsuite.ui.tagged

private enum class Tab(val route: String, val label: Int, val icon: ImageVector, val tag: String) {
    Inbox("inbox", R.string.welddesk_tabs_inbox, Icons.Outlined.Inbox, "tab-inbox"),
    Settings("settings", R.string.welddesk_tabs_settings, Icons.Outlined.Settings, "tab-settings"),
}

private const val CONVERSATION_ROUTE = "conversation/{id}"

/** WeldDesk once signed in, in a workspace and unlocked: the inbox, a conversation, settings. */
@Composable
fun WeldDeskApp(env: AppEnvironment, repository: DeskRepository, session: SessionState.Ready, appearance: AppearancePreference) {
    NotificationPermissionRequest()
    val toaster = remember { Toaster() }
    val scope = rememberCoroutineScope()
    val notify: (String) -> Unit = { toaster.show(it, scope) }
    var switching by remember { mutableStateOf(false) }

    // A push about the conversation on screen doesn't pop up over it.
    DisposableEffect(Unit) {
        WeldPush.shouldShow = { payload ->
            val open = OpenConversation.id
            open == null || DeskLogic.conversationIdFromPush(payload.values) != open
        }
        onDispose { WeldPush.shouldShow = { true } }
    }

    if (switching) {
        WorkspacePicker(session.workspaces, onChoose = {
            env.chooseWorkspace(it)
            switching = false
        })
        return
    }

    ToastHost(toaster) {
        // Another workspace starts over: its own inbox, threads and roster.
        key(session.workspace.id) {
            LaunchedEffect(Unit) { repository.clear() }
            DeskNavigation(env, repository, session, appearance, notify, onSwitchWorkspace = { switching = true })
        }
    }
}

@Composable
private fun DeskNavigation(
    env: AppEnvironment,
    repository: DeskRepository,
    session: SessionState.Ready,
    appearance: AppearancePreference,
    notify: (String) -> Unit,
    onSwitchWorkspace: () -> Unit,
) {
    val nav = rememberNavController()
    val userId = session.person.id
    val open: (DeskRoute) -> Unit = { route -> navigate(nav, route) }

    // A tapped notification: its conversation (a ticket opens the inbox).
    val tap by WeldPush.pendingTap.collectAsStateWithLifecycle()
    LaunchedEffect(tap) {
        if (tap != null) WeldPush.takeTap()?.let { open(DeskLogic.routeForPush(it.values)) }
    }
    // A welddesk:// link.
    val link by DeskLinks.pending.collectAsStateWithLifecycle()
    LaunchedEffect(link) {
        if (link != null) DeskLinks.take()?.let(open)
    }

    val entry by nav.currentBackStackEntryAsState()
    val showTabs = entry?.destination?.route != CONVERSATION_ROUTE
    Scaffold(
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        bottomBar = { if (showTabs) TabBar(nav) },
    ) { padding ->
        NavHost(nav, startDestination = Tab.Inbox.route, modifier = Modifier.padding(padding).consumeWindowInsets(padding)) {
            composable(Tab.Inbox.route) {
                InboxScreen(env, rememberInboxModel(repository, userId), onOpen = { id -> open(DeskRoute.Conversation(id)) })
            }
            composable(Tab.Settings.route) {
                SettingsScreen(env, session, appearance, onSwitchWorkspace)
            }
            composable(CONVERSATION_ROUTE) { backStack ->
                val id = backStack.arguments?.getString("id").orEmpty()
                ConversationScreen(
                    env = env,
                    model = rememberConversationModel(env, repository, id, userId),
                    userId = userId,
                    onBack = { nav.popBackStack() },
                    notify = notify,
                )
            }
        }
    }
}

private fun navigate(nav: NavHostController, route: DeskRoute) {
    when (route) {
        DeskRoute.Inbox -> nav.popBackStack(Tab.Inbox.route, inclusive = false)
        DeskRoute.Settings -> nav.navigate(Tab.Settings.route) {
            popUpTo(nav.graph.findStartDestination().id) { saveState = true }
            launchSingleTop = true
            restoreState = true
        }
        is DeskRoute.Conversation -> nav.navigate("conversation/${route.id}") { launchSingleTop = true }
    }
}

@Composable
private fun TabBar(nav: NavHostController) {
    val entry by nav.currentBackStackEntryAsState()
    val route = entry?.destination?.route
    NavigationBar {
        Tab.entries.forEach { tab ->
            NavigationBarItem(
                selected = route == tab.route,
                onClick = {
                    nav.navigate(tab.route) {
                        popUpTo(nav.graph.findStartDestination().id) { saveState = true }
                        launchSingleTop = true
                        restoreState = true
                    }
                },
                icon = { Icon(tab.icon, contentDescription = null) },
                label = { Text(stringResource(tab.label)) },
                modifier = Modifier.tagged(tab.tag),
            )
        }
    }
}
