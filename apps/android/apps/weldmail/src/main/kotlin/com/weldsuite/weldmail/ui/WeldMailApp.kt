package com.weldsuite.weldmail.ui

import android.net.Uri
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Mail
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.Icon
import org.weldsuite.ui.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
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
import com.weldsuite.weldmail.Attachments
import com.weldsuite.weldmail.ComposePrefill
import com.weldsuite.weldmail.MailLogic
import com.weldsuite.weldmail.MailStore
import com.weldsuite.weldmail.NotificationTarget
import com.weldsuite.weldmail.R
import kotlinx.coroutines.launch
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.SessionState
import org.weldsuite.push.NotificationPermissionRequest
import org.weldsuite.push.WeldPush
import org.weldsuite.ui.TabLabel
import org.weldsuite.ui.AppearancePreference
import org.weldsuite.ui.RealtimeRefresh
import org.weldsuite.ui.WorkspacePicker
import org.weldsuite.ui.tagged

private enum class Tab(val route: String, val label: Int, val icon: ImageVector, val tag: String) {
    Mail("mail", R.string.weldmail_tabs_mail, Icons.Outlined.Mail, "tab-mail"),
    Search("search", R.string.weldmail_tabs_search, Icons.Outlined.Search, "tab-search"),
    Settings("settings", R.string.weldmail_tabs_settings, Icons.Outlined.Settings, "tab-settings"),
}

/** A message opened from a notification: what it said, to paint before the message loads. */
data class MessagePreview(val fromName: String?, val fromEmail: String?, val subject: String?, val preview: String?)

/** WeldMail once signed in, in a workspace and unlocked. */
@Composable
fun WeldMailApp(
    env: AppEnvironment,
    store: MailStore,
    attachments: Attachments,
    session: SessionState.Ready,
    appearance: AppearancePreference,
    deepLink: Uri?,
    onDeepLinkTaken: () -> Unit,
    onOpenEmail: (String?) -> Unit,
) {
    NotificationPermissionRequest()
    val nav = rememberNavController()
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val notify = remember(snackbar) {
        Notify { message, action, onAction ->
            scope.launch {
                snackbar.currentSnackbarData?.dismiss()
                val result = snackbar.showSnackbar(message, action, duration = if (action != null) SnackbarDuration.Long else SnackbarDuration.Short)
                if (result == SnackbarResult.ActionPerformed) onAction?.invoke()
            }
        }
    }
    var switching by remember { mutableStateOf(false) }
    var composing by remember { mutableStateOf(ComposePrefill()) }
    var previews by remember { mutableStateOf(mapOf<String, MessagePreview>()) }

    LaunchedEffect(session.workspace.id) { store.useWorkspace(session.workspace.id) }
    // New mail for this person (`mail:new`) and changes to messages in shared mailboxes.
    RealtimeRefresh(env, listOf("mail.${session.person.id}", "email")) { store.refresh() }

    val openMessage: (String) -> Unit = { id -> nav.navigate("message/$id") }
    val compose: (ComposePrefill) -> Unit = { prefill ->
        composing = prefill
        nav.navigate("compose")
    }
    fun openTarget(target: NotificationTarget) {
        store.followAccount(target.accountId)
        store.expect(target.emailId)
        val id = target.emailId ?: return
        previews = previews + (id to MessagePreview(target.fromName, target.fromEmail, target.subject, target.preview))
        nav.navigate("message/$id") { launchSingleTop = true }
    }

    // A tapped notification: the mailbox it arrived in, then the email.
    val tap by WeldPush.pendingTap.collectAsStateWithLifecycle()
    LaunchedEffect(tap) {
        val payload = tap ?: return@LaunchedEffect
        WeldPush.takeTap()
        MailLogic.notificationTarget(payload.values)?.let(::openTarget)
    }

    // weldmail://message/<id>, weldmail://compose?to=…, weldmail://search, …/settings, …/subscriptions.
    LaunchedEffect(deepLink) {
        val link = deepLink ?: return@LaunchedEffect
        onDeepLinkTaken()
        when (link.host) {
            "message" -> MailLogic.safeId(link.pathSegments.firstOrNull())?.let(openMessage)
            "compose" -> compose(ComposePrefill(to = MailLogic.splitAddresses(link.getQueryParameter("to").orEmpty()), subject = link.getQueryParameter("subject").orEmpty()))
            "search" -> selectTab(nav, Tab.Search)
            "settings" -> selectTab(nav, Tab.Settings)
            "subscriptions" -> nav.navigate("subscriptions")
        }
    }

    if (switching) {
        WorkspacePicker(session.workspaces, onChoose = {
            env.chooseWorkspace(it)
            switching = false
        })
        return
    }

    CompositionLocalProvider(LocalNotify provides notify) {
        // The screens' own top bars take the status bar; this one only makes room
        // for the tab bar, so the inset isn't applied twice (a band above the top bar).
        Scaffold(
            contentWindowInsets = WindowInsets(0, 0, 0, 0),
            snackbarHost = { SnackbarHost(snackbar, modifier = Modifier.tagged("toast")) },
            bottomBar = { TabBar(nav) },
        ) { padding ->
            // No cross-fades between screens: a fade draws the leaving screen into an
            // offscreen layer, and a WebView in it (the composer's editor, an email's
            // body) can't draw there — the render thread crashed in
            // GLFunctorDrawable::onDraw when a sent email's composer faded out.
            NavHost(
                nav,
                startDestination = Tab.Mail.route,
                modifier = Modifier.padding(padding).consumeWindowInsets(padding),
                enterTransition = { EnterTransition.None },
                exitTransition = { ExitTransition.None },
                popEnterTransition = { EnterTransition.None },
                popExitTransition = { ExitTransition.None },
            ) {
                composable(Tab.Mail.route) {
                    InboxScreen(
                        store = store,
                        session = session,
                        onOpen = openMessage,
                        onCompose = { compose(ComposePrefill()) },
                        onSearch = { selectTab(nav, Tab.Search) },
                        onSubscriptions = { nav.navigate("subscriptions") },
                        onAddAccount = { nav.navigate("add-account") },
                        onSwitchWorkspace = { workspaceId -> env.chooseWorkspace(workspaceId) },
                        aiAvailable = env.isAvailable("mail-ai"),
                    )
                }
                composable(Tab.Search.route) {
                    SearchScreen(store = store, onOpen = openMessage)
                }
                composable(Tab.Settings.route) {
                    SettingsScreen(
                        env = env,
                        store = store,
                        session = session,
                        appearance = appearance,
                        onSwitchWorkspace = { switching = true },
                        onSubscriptions = { nav.navigate("subscriptions") },
                        onAddAccount = { nav.navigate("add-account") },
                    )
                }
                composable("message/{id}") { entry ->
                    val id = entry.arguments?.getString("id").orEmpty()
                    LaunchedEffect(id) { onOpenEmail(id) }
                    MessageScreen(
                        store = store,
                        attachments = attachments,
                        messageId = id,
                        preview = previews[id],
                        onBack = {
                            onOpenEmail(null)
                            nav.popBackStack()
                        },
                        onOpenOther = { next ->
                            nav.navigate("message/$next") { popUpTo("message/{id}") { inclusive = true } }
                        },
                        onCompose = compose,
                        onContact = { key -> nav.navigate("contact/${Uri.encode(key)}") },
                    )
                }
                composable("compose") {
                    ComposeScreen(
                        env = env,
                        store = store,
                        attachments = attachments,
                        prefill = composing,
                        aiAvailable = env.isAvailable("mail-ai"),
                        onClose = { nav.popBackStack() },
                    )
                }
                composable("contact/{key}") { entry ->
                    ContactScreen(
                        store = store,
                        key = Uri.decode(entry.arguments?.getString("key").orEmpty()),
                        onBack = { nav.popBackStack() },
                    )
                }
                composable("subscriptions") {
                    SubscriptionsScreen(store = store, onBack = { nav.popBackStack() })
                }
                composable("add-account") {
                    AddAccountScreen(
                        store = store,
                        freeAddresses = env.isAvailable("mail-free-addresses"),
                        customDomains = env.isAvailable("mail-domains"),
                        onDone = { nav.popBackStack() },
                    )
                }
            }
        }
    }
}

private fun selectTab(nav: NavHostController, tab: Tab) {
    nav.navigate(tab.route) {
        popUpTo(nav.graph.findStartDestination().id) { saveState = true }
        launchSingleTop = true
        restoreState = true
    }
}

@Composable
private fun TabBar(nav: NavHostController) {
    val entry by nav.currentBackStackEntryAsState()
    val route = entry?.destination?.route
    // The tab bar shows on the tabs and the screens they open, not over a message or the composer.
    if (route != null && (route.startsWith("message") || route == "compose" || route.startsWith("contact"))) return
    val current = when (route) {
        null, Tab.Mail.route -> Tab.Mail
        Tab.Search.route -> Tab.Search
        Tab.Settings.route, "subscriptions", "add-account" -> Tab.Settings
        else -> null
    }
    NavigationBar {
        Tab.entries.forEach { tab ->
            NavigationBarItem(
                selected = current == tab,
                onClick = { selectTab(nav, tab) },
                icon = { Icon(tab.icon, contentDescription = null) },
                label = { TabLabel(stringResource(tab.label)) },
                modifier = Modifier.tagged(tab.tag),
            )
        }
    }
}
