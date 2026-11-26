package com.weldsuite.weldpass.ui

import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Key
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.outlined.AutoFixHigh
import androidx.compose.material.icons.outlined.Inventory2
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import androidx.compose.ui.platform.LocalContext
import com.weldsuite.weldpass.ItemFormValues
import com.weldsuite.weldpass.PassRepository
import com.weldsuite.weldpass.R
import com.weldsuite.weldpass.autofill.PendingSave
import kotlinx.coroutines.launch
import org.weldsuite.api.weldpass.models.Item
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.SessionState
import org.weldsuite.ui.tagged

/** Shows a short message at the bottom of the screen (a copy, a failure). */
val LocalNotify = staticCompositionLocalOf<(String) -> Unit> { {} }

private enum class Tab(val route: String, val label: Int, val icon: ImageVector, val tag: String) {
    Items("items", R.string.weldpass_tabs_items, Icons.Filled.Key, "tab-items"),
    Vaults("vaults", R.string.weldpass_tabs_vaults, Icons.Outlined.Inventory2, "tab-vaults"),
    Generator("generator", R.string.weldpass_tabs_generator, Icons.Outlined.AutoFixHigh, "tab-generator"),
    Settings("settings", R.string.weldpass_tabs_settings, Icons.Filled.Settings, "tab-settings"),
}

/** WeldPass once signed in, in a workspace and unlocked. */
@Composable
fun WeldPassApp(
    env: AppEnvironment,
    repository: PassRepository,
    session: SessionState.Ready,
    autofillSave: PendingSave.Values? = null,
    onAutofillSaveTaken: () -> Unit = {},
) {
    val nav = rememberNavController()
    // A login autofill asked to save: the "New login" form, filled in with it.
    var draft by remember { mutableStateOf<PendingSave.Values?>(null) }
    LaunchedEffect(autofillSave) {
        if (autofillSave != null) {
            draft = autofillSave
            onAutofillSaveTaken()
            nav.navigate("item/new?type=${Item.Type.LOGIN.value}&vaultId=")
        }
    }
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val notify: (String) -> Unit = { message -> scope.launch { snackbar.showSnackbar(message) } }
    // The new-item sheet: null when closed, else the vault to add to ("" = the default one).
    var addingTo by remember { mutableStateOf<String?>(null) }
    val openItem: (String, String) -> Unit = { vaultId, itemId -> nav.navigate("item/$vaultId/$itemId") }

    LaunchedEffect(session.workspace.id) {
        repository.useWorkspace(session.workspace.id)
        repository.refresh()
    }

    CompositionLocalProvider(LocalNotify provides notify) {
        Scaffold(
            snackbarHost = { SnackbarHost(snackbar) },
            bottomBar = { TabBar(nav) },
        ) { padding ->
            NavHost(nav, startDestination = Tab.Items.route, modifier = Modifier.padding(padding)) {
                composable(Tab.Items.route) {
                    ItemsScreen(repository, onOpen = openItem, onAdd = { addingTo = "" })
                }
                composable(Tab.Vaults.route) {
                    VaultsScreen(repository, onOpen = { vaultId -> nav.navigate("vault/$vaultId") })
                }
                composable("vault/{vaultId}") { entry ->
                    VaultScreen(
                        repository = repository,
                        vaultId = entry.arguments?.getString("vaultId").orEmpty(),
                        onBack = { nav.popBackStack() },
                        onOpen = openItem,
                        onAdd = { vaultId -> addingTo = vaultId },
                    )
                }
                composable(
                    "item/new?type={type}&vaultId={vaultId}",
                    arguments = listOf(
                        navArgument("type") { defaultValue = Item.Type.LOGIN.value },
                        navArgument("vaultId") { defaultValue = "" },
                    ),
                ) { entry ->
                    val typeValue = entry.arguments?.getString("type")
                    val saved = draft
                    ItemFormScreen(
                        env = env,
                        repository = repository,
                        type = Item.Type.entries.firstOrNull { it.value == typeValue } ?: Item.Type.LOGIN,
                        vaultId = entry.arguments?.getString("vaultId")?.ifEmpty { null },
                        itemId = null,
                        onDone = {
                            draft = null
                            nav.popBackStack()
                        },
                        draft = saved?.let { autofillDraft(it, LocalContext.current) },
                    )
                }
                composable("item/{vaultId}/{itemId}") { entry ->
                    ItemScreen(
                        env = env,
                        repository = repository,
                        vaultId = entry.arguments?.getString("vaultId").orEmpty(),
                        itemId = entry.arguments?.getString("itemId").orEmpty(),
                        onBack = { nav.popBackStack() },
                        onEdit = { vaultId, itemId -> nav.navigate("item/$vaultId/$itemId/edit") },
                    )
                }
                composable("item/{vaultId}/{itemId}/edit") { entry ->
                    val itemId = entry.arguments?.getString("itemId").orEmpty()
                    val items by repository.items.collectAsStateWithLifecycle()
                    val item = items.data?.firstOrNull { it.id == itemId }
                    ItemFormScreen(
                        env = env,
                        repository = repository,
                        type = item?.type ?: Item.Type.LOGIN,
                        vaultId = entry.arguments?.getString("vaultId"),
                        itemId = itemId,
                        onDone = { nav.popBackStack() },
                    )
                }
                composable(Tab.Generator.route) {
                    GeneratorScreen()
                }
                composable(Tab.Settings.route) {
                    SettingsScreen(env, repository, session, onHealth = { nav.navigate("health") })
                }
                composable("health") {
                    HealthScreen(repository, onBack = { nav.popBackStack() }, onOpen = openItem)
                }
            }
        }
        addingTo?.let { vault ->
            NewItemSheet(onDismiss = { addingTo = null }) { type ->
                addingTo = null
                nav.navigate("item/new?type=${type.value}&vaultId=$vault")
            }
        }
    }
}

/**
 * The form's values for a login autofill asked to save: the page's domain as
 * title and website, or the app's name with its package as the Android app
 * the login belongs to.
 */
private fun autofillDraft(save: PendingSave.Values, context: android.content.Context): ItemFormValues {
    val appName = runCatching {
        val info = context.packageManager.getApplicationInfo(save.packageName, 0)
        context.packageManager.getApplicationLabel(info).toString()
    }.getOrNull()
    return ItemFormValues(
        type = Item.Type.LOGIN,
        vaultId = "",
        title = save.webDomain ?: appName ?: save.packageName,
        url = save.webDomain.orEmpty(),
        username = save.username,
        password = save.password,
        apps = if (save.webDomain == null) listOf(save.packageName) else emptyList(),
    )
}

@Composable
private fun TabBar(nav: NavHostController) {
    val entry by nav.currentBackStackEntryAsState()
    val route = entry?.destination?.route
    val current = when {
        route == null -> Tab.Items
        route.startsWith("vault") -> Tab.Vaults
        route.startsWith("item") -> null
        route == "health" -> Tab.Settings
        else -> Tab.entries.firstOrNull { it.route == route }
    }
    NavigationBar {
        Tab.entries.forEach { tab ->
            NavigationBarItem(
                selected = current == tab,
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
