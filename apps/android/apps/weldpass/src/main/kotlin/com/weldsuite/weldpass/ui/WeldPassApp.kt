package com.weldsuite.weldpass.ui

import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Key
import androidx.compose.material.icons.filled.Settings
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
import androidx.compose.runtime.remember
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
import androidx.navigation.compose.rememberNavController
import com.weldsuite.weldpass.PassRepository
import com.weldsuite.weldpass.R
import kotlinx.coroutines.launch
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.SessionState
import org.weldsuite.ui.tagged

/** Shows a short message at the bottom of the screen (a copy, a failure). */
val LocalNotify = staticCompositionLocalOf<(String) -> Unit> { {} }

private enum class Tab(val route: String, val label: Int, val icon: ImageVector, val tag: String) {
    Items("items", R.string.weldpass_tabs_items, Icons.Filled.Key, "tab-items"),
    Vaults("vaults", R.string.weldpass_tabs_vaults, Icons.Outlined.Inventory2, "tab-vaults"),
    Settings("settings", R.string.weldpass_tabs_settings, Icons.Filled.Settings, "tab-settings"),
}

/** WeldPass once signed in, in a workspace and unlocked. */
@Composable
fun WeldPassApp(env: AppEnvironment, repository: PassRepository, session: SessionState.Ready) {
    val nav = rememberNavController()
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val notify: (String) -> Unit = { message -> scope.launch { snackbar.showSnackbar(message) } }

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
                    ItemsScreen(repository, onOpen = { vaultId, itemId -> nav.navigate("item/$vaultId/$itemId") })
                }
                composable(Tab.Vaults.route) {
                    VaultsScreen(repository, onOpen = { vaultId -> nav.navigate("vault/$vaultId") })
                }
                composable("vault/{vaultId}") { entry ->
                    VaultScreen(
                        repository = repository,
                        vaultId = entry.arguments?.getString("vaultId").orEmpty(),
                        onBack = { nav.popBackStack() },
                        onOpen = { vaultId, itemId -> nav.navigate("item/$vaultId/$itemId") },
                    )
                }
                composable("item/{vaultId}/{itemId}") { entry ->
                    ItemScreen(
                        env = env,
                        repository = repository,
                        vaultId = entry.arguments?.getString("vaultId").orEmpty(),
                        itemId = entry.arguments?.getString("itemId").orEmpty(),
                        onBack = { nav.popBackStack() },
                    )
                }
                composable(Tab.Settings.route) {
                    SettingsScreen(env, repository, session)
                }
            }
        }
    }
}

@Composable
private fun TabBar(nav: NavHostController) {
    val entry by nav.currentBackStackEntryAsState()
    val route = entry?.destination?.route
    val current = when {
        route == null -> Tab.Items
        route.startsWith("vault") -> Tab.Vaults
        route.startsWith("item") -> null
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
