package com.weldsuite.weldchat.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavBackStackEntry
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.weldsuite.weldchat.ChatStore
import com.weldsuite.weldchat.DeepLink
import com.weldsuite.weldchat.DeepLinks
import com.weldsuite.weldchat.PushRoute
import com.weldsuite.weldchat.calls.CallManager
import com.weldsuite.weldchat.calls.CallOverlay
import com.weldsuite.weldchat.calls.CallsScreen
import com.weldsuite.weldchat.ui.channel.ChannelInfoScreen
import com.weldsuite.weldchat.ui.channel.ChannelScreen
import com.weldsuite.weldchat.ui.channel.InvitePeopleScreen
import com.weldsuite.weldchat.ui.channel.ThreadScreen
import com.weldsuite.weldchat.ui.screens.DraftsScreen
import com.weldsuite.weldchat.ui.screens.MemberScreen
import com.weldsuite.weldchat.ui.screens.NewCategoryScreen
import com.weldsuite.weldchat.ui.screens.NewChannelScreen
import com.weldsuite.weldchat.ui.screens.NewDmScreen
import com.weldsuite.weldchat.ui.screens.NewMessageScreen
import com.weldsuite.weldchat.ui.screens.RecordsScreen
import com.weldsuite.weldchat.ui.screens.SavedScreen
import com.weldsuite.weldchat.ui.screens.SearchScreen
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.SessionState
import org.weldsuite.core.push.PushPayload
import org.weldsuite.push.NotificationPermissionRequest
import org.weldsuite.push.WeldPush
import org.weldsuite.ui.AppearancePreference
import org.weldsuite.ui.ToastHost
import org.weldsuite.ui.Toaster
import org.weldsuite.ui.tagged

/**
 * WeldChat once signed in, in a workspace and unlocked: Home, Direct
 * messages, Activity and (where the server has calls) Calls, the call over
 * everything, push taps and `weldchat://` links. A workspace switch starts
 * the navigation afresh.
 */
@Composable
fun WeldChatApp(
    env: AppEnvironment,
    session: SessionState.Ready,
    appearance: AppearancePreference,
    store: ChatStore,
    calls: CallManager,
) {
    NotificationPermissionRequest()
    val toaster = remember { Toaster() }
    val scope = rememberCoroutineScope()
    val notify: (String) -> Unit = { toaster.show(it, scope) }
    val person = session.person
    val workspace = session.workspace

    LaunchedEffect(workspace.id, person.id) {
        store.use(workspace.id, person.id)
        store.followPersonalEvents(person.id)
        if (env.isAvailable("chat-calls")) calls.start(person.id)
        store.loadHome()
        store.loadRoster()
        store.loadActivityUnread()
    }

    CompositionLocalProvider(LocalNotify provides notify) {
        ToastHost(toaster) {
            key(workspace.id) {
                ChatNavigationHost(env, session, appearance, store, calls)
            }
        }
    }
}

@Composable
private fun ChatNavigationHost(
    env: AppEnvironment,
    session: SessionState.Ready,
    appearance: AppearancePreference,
    store: ChatStore,
    calls: CallManager,
) {
    val controller = rememberNavController()
    val nav = remember(controller) { ChatNavigator(controller) }
    val userId = session.person.id
    val callsAvailable = env.isAvailable("chat-calls")
    val entry by controller.currentBackStackEntryAsState()
    val route = entry?.destination?.route
    LaunchedEffect(route) { ChatTab.of(route)?.let { nav.tab = it } }

    // A tapped notification: the ring, or the conversation it is about.
    val tap by WeldPush.pendingTap.collectAsStateWithLifecycle()
    LaunchedEffect(tap) {
        if (tap != null) WeldPush.takeTap()?.let { routePush(it, nav, calls) }
    }
    // A weldchat:// link.
    val link by DeepLinks.pending.collectAsStateWithLifecycle()
    LaunchedEffect(link) {
        if (link != null) DeepLink.parse(DeepLinks.take())?.let { open(it, nav) }
    }

    Box(Modifier.fillMaxSize()) {
        Scaffold(
            contentWindowInsets = WindowInsets(0, 0, 0, 0),
            bottomBar = {
                if (ChatTab.of(route) != null) TabBar(nav, store, callsAvailable)
            },
        ) { padding ->
            NavHost(controller, startDestination = ChatTab.HOME.route, modifier = Modifier.padding(padding).consumeWindowInsets(padding)) {
                composable(ChatTab.HOME.route) { HomeScreen(env, store, calls, session, nav) }
                composable(ChatTab.DMS.route) { DmsScreen(store, nav) }
                composable(ChatTab.ACTIVITY.route) { ActivityScreen(env, store, userId, nav) }
                composable(ChatTab.CALLS.route) {
                    CallsScreen(env, calls) { channelId, name, isDm -> nav.openConversation(channelId, name, if (isDm) "dm" else null) }
                }
                composable(
                    ChatRoutes.CHANNEL,
                    arguments = listOf(required("channelId"), optional("name"), optional("type"), optional("entityType")),
                ) { back ->
                    ChannelScreen(
                        env = env,
                        store = store,
                        calls = calls,
                        userId = userId,
                        channelId = back.text("channelId").orEmpty(),
                        name = back.text("name"),
                        type = back.text("type"),
                        entityType = back.text("entityType"),
                        nav = nav,
                    )
                }
                composable(ChatRoutes.THREAD, arguments = listOf(required("messageId"), optional("channelId"), optional("draft"))) { back ->
                    ThreadScreen(env, store, userId, back.text("messageId").orEmpty(), back.text("channelId").orEmpty(), back.text("draft"), nav)
                }
                composable(ChatRoutes.CHANNEL_INFO, arguments = listOf(required("channelId"), optional("name"))) { back ->
                    ChannelInfoScreen(store, userId, back.text("channelId").orEmpty(), back.text("name").orEmpty(), nav)
                }
                composable(ChatRoutes.MEMBER, arguments = listOf(required("userId"))) { back ->
                    MemberScreen(env, store, calls, userId, back.text("userId").orEmpty(), nav)
                }
                composable(ChatRoutes.DRAFTS) { DraftsScreen(store, nav) }
                composable(ChatRoutes.SAVED) { SavedScreen(store, nav) }
                composable(ChatRoutes.RECORDS, arguments = listOf(optional("type"))) { back -> RecordsScreen(env, store, back.text("type"), nav) }
                composable(ChatRoutes.SEARCH) { SearchScreen(store, nav) }
                composable(ChatRoutes.SETTINGS) { SettingsScreen(env, session, appearance, nav) }
                composable(ChatRoutes.PROFILE) { ProfileScreen(env, store, session.person, nav) }
                composable(ChatRoutes.NEW_CHANNEL, arguments = listOf(optional("sectionId"))) { back ->
                    NewChannelScreen(store, session, back.text("sectionId"), nav)
                }
                composable(ChatRoutes.NEW_CATEGORY) { NewCategoryScreen(store, nav) }
                composable(
                    ChatRoutes.NEW_DM,
                    arguments = listOf(navArgument("group") { type = NavType.BoolType; defaultValue = false }),
                ) { back -> NewDmScreen(store, userId, back.arguments?.getBoolean("group") ?: false, nav) }
                composable(ChatRoutes.NEW_MESSAGE) { NewMessageScreen(env, store, userId, nav) }
                composable(ChatRoutes.INVITE_PEOPLE, arguments = listOf(required("channelId"), optional("name"))) { back ->
                    InvitePeopleScreen(store, back.text("channelId").orEmpty(), back.text("name").orEmpty(), nav)
                }
            }
        }
        // The ring and the call, over everything.
        CallOverlay(calls) { channelId, isDirect -> nav.openConversation(channelId, type = if (isDirect) "dm" else null) }
    }
}

@Composable
private fun TabBar(nav: ChatNavigator, store: ChatStore, callsAvailable: Boolean) {
    NavigationBar {
        ChatTab.entries.filter { it != ChatTab.CALLS || callsAvailable }.forEach { tab ->
            NavigationBarItem(
                selected = nav.tab == tab,
                onClick = { if (nav.tab == tab) nav.popToRoot() else nav.selectTab(tab) },
                icon = {
                    val unread = store.activityUnread
                    if (tab == ChatTab.ACTIVITY && unread > 0) {
                        BadgedBox(badge = { Badge { Text(if (unread > 99) "99+" else unread.toString()) } }) {
                            Icon(tab.icon, contentDescription = null)
                        }
                    } else {
                        Icon(tab.icon, contentDescription = null)
                    }
                },
                label = { Text(stringResource(tab.label)) },
                modifier = Modifier.tagged(tab.tag),
            )
        }
    }
}

private fun required(name: String) = navArgument(name) { type = NavType.StringType }

private fun optional(name: String) = navArgument(name) {
    type = NavType.StringType
    nullable = true
    defaultValue = null
}

private fun NavBackStackEntry.text(name: String): String? = arguments?.getString(name)?.takeIf { it.isNotEmpty() }

/** Where a tapped notification leads: the ring, or the conversation. */
private fun routePush(payload: PushPayload, nav: ChatNavigator, calls: CallManager) {
    when (val target = PushRoute.of(payload.values)) {
        PushRoute.IncomingCall -> calls.presentIncoming(payload)
        is PushRoute.Conversation -> nav.openConversation(target.channelId, type = if (target.isDm) "dm" else null)
        PushRoute.None -> Unit
    }
}

private fun open(link: DeepLink, nav: ChatNavigator) {
    when (link) {
        is DeepLink.Channel -> nav.openConversation(link.id)
        is DeepLink.Dm -> nav.openConversation(link.id, type = "dm")
        is DeepLink.User -> nav.openMember(link.id)
        is DeepLink.Thread -> nav.openThread(link.messageId, link.channelId)
        DeepLink.Search -> nav.openSearch()
        DeepLink.Records -> nav.openRecords()
        DeepLink.Drafts -> nav.openDrafts()
        DeepLink.Saved -> nav.openSaved()
        DeepLink.Settings -> nav.openSettings()
    }
}
