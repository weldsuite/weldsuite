package com.weldsuite.weldbooks.ui

import android.net.Uri
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ReceiptLong
import androidx.compose.material.icons.outlined.CameraAlt
import androidx.compose.material.icons.outlined.Dashboard
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.MoreHoriz
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.weldsuite.weldbooks.CompanyFieldsMissing
import com.weldsuite.weldbooks.DeepLinks
import com.weldsuite.weldbooks.R
import com.weldsuite.weldbooks.WeldBooksApplication
import kotlinx.coroutines.launch
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.SessionState
import org.weldsuite.core.api.ApiException
import org.weldsuite.core.apiErrorMessage
import org.weldsuite.push.NotificationPermissionRequest
import org.weldsuite.push.WeldPush
import org.weldsuite.ui.TabLabel
import org.weldsuite.ui.AppearancePreference
import org.weldsuite.ui.CenteredProgress
import org.weldsuite.ui.MessageAction
import org.weldsuite.ui.MessageScreen
import org.weldsuite.ui.WorkspacePicker
import org.weldsuite.ui.tagged

/** The snackbar every screen shows its messages in. */
val LocalSnackbar = staticCompositionLocalOf { SnackbarHostState() }

/** Show a short message at the bottom of the screen. */
val LocalNotify = staticCompositionLocalOf<(String) -> Unit> { {} }

/** Turns a failed call into words the person can act on. */
class ErrorTexts(private val strings: Map<String, String>, private val generic: (Throwable?) -> String) {
    fun describe(error: Throwable?, fallback: String): String {
        if (error is CompanyFieldsMissing) return error.message ?: fallback
        val api = error as? ApiException ?: return fallback
        strings[api.code]?.let { message ->
            return if (api.code == "TAX_ENGINE_UNAVAILABLE" && api.status == 503) strings.getValue("TAX_ENGINE_RETRY") else message
        }
        if (api.isNetwork) return strings.getValue("OFFLINE")
        if (api.status == 403 || api.status == 404) return generic(error)
        val message = api.message?.takeIf { api.status in 400..499 && !it.startsWith("Request failed") }
        return message ?: fallback
    }
}

val LocalErrors = staticCompositionLocalOf { ErrorTexts(emptyMap()) { "" } }

@Composable
private fun errorTexts(): ErrorTexts {
    val strings = mapOf(
        "ADDRESS_REQUIRED" to stringResource(R.string.weldbooks_sales_tax_errors_address_required),
        "TAX_ENGINE_UNAVAILABLE" to stringResource(R.string.weldbooks_sales_tax_errors_engine_unavailable),
        "TAX_ENGINE_RETRY" to stringResource(R.string.weldbooks_sales_tax_errors_engine_unavailable_retry),
        "TAX_RATES_NOT_CONFIGURED" to stringResource(R.string.weldbooks_sales_tax_errors_rates_not_configured),
        "USE_TAX_ENGINE_UNSUPPORTED" to stringResource(R.string.weldbooks_sales_tax_errors_use_tax_unsupported),
        "TAX_NOT_CALCULATED" to stringResource(R.string.weldbooks_sales_tax_errors_not_calculated),
        "CREDIT_LINE_NOT_ON_ORIGINAL" to stringResource(R.string.weldbooks_sales_tax_errors_credit_line_not_on_original),
        "TAX_COMMIT_NOT_APPLICABLE" to stringResource(R.string.weldbooks_sales_tax_errors_commit_not_applicable),
        "OFFLINE" to stringResource(R.string.weldbooks_common_offline_error),
    )
    val forbidden = stringResource(apiErrorMessage(ApiException(403, null, null)))
    val missing = stringResource(apiErrorMessage(ApiException(404, null, null)))
    return remember(strings) { ErrorTexts(strings) { error -> if ((error as? ApiException)?.status == 403) forbidden else missing } }
}

private enum class Tab(val route: String, val label: Int, val icon: ImageVector, val tag: String) {
    Home("home", R.string.weldbooks_tabs_home, Icons.Outlined.Dashboard, "tab-home"),
    Invoices("invoices", R.string.weldbooks_tabs_invoices, Icons.Outlined.Description, "tab-invoices"),
    Scan("scan", R.string.weldbooks_tabs_scan, Icons.Outlined.CameraAlt, "tab-scan"),
    Expenses("expenses", R.string.weldbooks_tabs_expenses, Icons.AutoMirrored.Outlined.ReceiptLong, "tab-expenses"),
    More("more", R.string.weldbooks_tabs_more, Icons.Outlined.MoreHoriz, "tab-more"),
}

/** WeldBooks once signed in, in a workspace and unlocked: the company gate, then the tabs. */
@Composable
fun WeldBooksApp(env: AppEnvironment, session: SessionState.Ready, appearance: AppearancePreference) {
    NotificationPermissionRequest()
    val app = androidx.compose.ui.platform.LocalContext.current.applicationContext as WeldBooksApplication
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val notify: (String) -> Unit = { message -> scope.launch { snackbar.showSnackbar(message) } }
    var switching by remember { mutableStateOf(false) }

    LaunchedEffect(session.workspace.id) {
        app.entities.use(session.workspace.id)
        app.queue.sync()
    }
    val entities by app.entities.snapshot.collectAsStateWithLifecycle()

    if (switching) {
        WorkspacePicker(session.workspaces, onChoose = {
            env.chooseWorkspace(it)
            switching = false
        })
        return
    }

    val labels = terminologyLabels(com.weldsuite.weldbooks.logic.Jurisdictions.find(entities.active?.jurisdictionCode, entities.jurisdictions)?.terminology ?: com.weldsuite.weldbooks.logic.Terminology())
    val books = Books(env, app.repository, app.entities, app.queue, session.workspace.id, entities.active, entities.jurisdictions, labels)

    CompositionLocalProvider(
        LocalSnackbar provides snackbar,
        LocalNotify provides notify,
        LocalBooks provides books,
        LocalErrors provides errorTexts(),
    ) {
        when {
            entities.loading -> CenteredProgress()
            entities.failed -> MessageScreen(
                title = stringResource(R.string.weldbooks_app_name),
                description = stringResource(R.string.weldbooks_layout_company_load_error),
                primary = MessageAction(stringResource(org.weldsuite.core.R.string.core_common_try_again), "retry") { scope.launch { app.entities.load() } },
            )
            !entities.hasEntity -> EntityEmptyState(session = session, onSwitchWorkspace = { switching = true })
            else -> key(entities.activeId) {
                BooksNavigation(env, session, appearance, onSwitchWorkspace = { switching = true })
                AdministrationSheet()
            }
        }
    }
}

@Composable
private fun BooksNavigation(env: AppEnvironment, session: SessionState.Ready, appearance: AppearancePreference, onSwitchWorkspace: () -> Unit) {
    val nav = rememberNavController()
    val back: () -> Unit = { nav.popBackStack() }
    val open: (String) -> Unit = { route -> nav.navigate(route) }

    // A tapped notification: open what it is about.
    val tap by WeldPush.pendingTap.collectAsStateWithLifecycle()
    LaunchedEffect(tap) {
        val payload = tap ?: return@LaunchedEffect
        WeldPush.takeTap()
        pushRoute(payload.entityType, payload.entityId, payload.actionUrl)?.let(open)
    }
    val link by DeepLinks.pending.collectAsStateWithLifecycle()
    LaunchedEffect(link) {
        val route = DeepLinks.take() ?: return@LaunchedEffect
        open(route)
    }

    androidx.compose.material3.Scaffold(bottomBar = { TabBar(nav) }) { padding ->
        Box(Modifier.fillMaxSize().padding(bottom = padding.calculateBottomPadding())) {
            NavHost(nav, startDestination = Tab.Home.route) {
                composable(Tab.Home.route) { DashboardScreen(open) }
                composable(Tab.Invoices.route) { InvoicesScreen(open) }
                composable(Tab.Expenses.route) { ExpensesScreen(open) }
                composable(Tab.More.route) { MoreScreen(open) }
                composable("invoice/new") { InvoiceFormScreen(onBack = back, onCreated = { id -> nav.navigate("invoice/$id") { popUpTo("invoice/new") { inclusive = true } } }) }
                composable("invoice/{id}") { entry ->
                    InvoiceDetailScreen(
                        id = entry.arguments?.getString("id").orEmpty(),
                        onBack = back,
                        onOpenDocument = { id -> open("invoice/$id/document") },
                        onReplace = { id -> nav.navigate("invoice/$id") { popUpTo("invoice/{id}") { inclusive = true } } },
                    )
                }
                composable("invoice/{id}/document") { entry -> InvoiceDocumentScreen(entry.arguments?.getString("id").orEmpty(), back) }
                composable("bill/{id}") { entry -> BillDetailScreen(entry.arguments?.getString("id").orEmpty(), back) }
                composable(
                    "bill/new?documentId={documentId}&receipt={receipt}&receiptType={receiptType}",
                    arguments = receiptArguments(),
                ) { entry ->
                    BillFormScreen(
                        documentId = entry.arguments?.getString("documentId")?.ifEmpty { null },
                        receipt = entry.arguments?.getString("receipt")?.ifEmpty { null },
                        receiptType = entry.arguments?.getString("receiptType")?.ifEmpty { null },
                        onBack = back,
                        onCreated = { id -> nav.navigate("bill/$id") { popUpTo("bill/new?documentId={documentId}&receipt={receipt}&receiptType={receiptType}") { inclusive = true } } },
                    )
                }
                composable(
                    "expense/quick?documentId={documentId}&receipt={receipt}&receiptType={receiptType}",
                    arguments = receiptArguments(),
                ) { entry ->
                    QuickExpenseScreen(
                        documentId = entry.arguments?.getString("documentId")?.ifEmpty { null },
                        receipt = entry.arguments?.getString("receipt")?.ifEmpty { null },
                        receiptType = entry.arguments?.getString("receiptType")?.ifEmpty { null },
                        onDone = back,
                    )
                }
                composable(Tab.Scan.route) {
                    ScanScreen(
                        onClose = back,
                        onContinue = { target, documentId, receipt, receiptType ->
                            val route = "$target?documentId=${documentId.orEmpty()}&receipt=${Uri.encode(receipt.orEmpty())}&receiptType=${Uri.encode(receiptType.orEmpty())}"
                            nav.navigate(route) { popUpTo(Tab.Scan.route) { inclusive = true } }
                        },
                    )
                }
                composable("bank") { BankAccountsScreen(back, open) }
                composable("bank/{id}") { entry -> BankAccountScreen(entry.arguments?.getString("id").orEmpty(), back) }
                composable("reconciliation") { ReconciliationScreen(back) }
                composable("reports") { ReportsScreen(back, open) }
                composable("reports/profit-loss") { ProfitLossScreen(back) }
                composable("reports/balance-sheet") { BalanceSheetScreen(back) }
                composable("vat") { VatReturnsScreen(back, open) }
                composable("vat/{id}") { entry -> VatReturnScreen(entry.arguments?.getString("id").orEmpty(), back) }
                composable("contacts") { ContactsScreen(back, open) }
                composable("contacts/new") { ContactFormScreen(back, onCreated = { id -> nav.navigate("contacts/$id") { popUpTo("contacts/new") { inclusive = true } } }) }
                composable("contacts/{id}") { entry -> ContactScreen(entry.arguments?.getString("id").orEmpty(), back, open) }
                composable("settings") { SettingsScreen(env, session, appearance, back, onSwitchWorkspace) }
            }
        }
    }
}

private fun receiptArguments() = listOf(
    navArgument("documentId") {
        type = NavType.StringType
        defaultValue = ""
    },
    navArgument("receipt") {
        type = NavType.StringType
        defaultValue = ""
    },
    navArgument("receiptType") {
        type = NavType.StringType
        defaultValue = ""
    },
)

/** Where a tapped notification leads: an invoice or a bill. */
fun pushRoute(entityType: String?, entityId: String?, actionUrl: String?): String? {
    if (entityId != null) {
        when (entityType) {
            "invoice" -> return "invoice/$entityId"
            "bill" -> return "bill/$entityId"
        }
    }
    val url = actionUrl ?: return null
    Regex("/invoices?/([A-Za-z0-9_-]+)").find(url)?.let { return "invoice/${it.groupValues[1]}" }
    Regex("/bills?/([A-Za-z0-9_-]+)").find(url)?.let { return "bill/${it.groupValues[1]}" }
    return null
}

@Composable
private fun TabBar(nav: NavHostController) {
    val entry by nav.currentBackStackEntryAsState()
    val route = entry?.destination?.route
    val current = Tab.entries.firstOrNull { it.route == route && it != Tab.Scan }
    if (current == null) return
    NavigationBar {
        Tab.entries.forEach { tab ->
            NavigationBarItem(
                selected = current == tab,
                onClick = {
                    if (tab == Tab.Scan) {
                        nav.navigate(Tab.Scan.route)
                    } else {
                        nav.navigate(tab.route) {
                            popUpTo(nav.graph.findStartDestination().id) { saveState = true }
                            launchSingleTop = true
                            restoreState = true
                        }
                    }
                },
                icon = { Icon(tab.icon, contentDescription = null) },
                label = { TabLabel(stringResource(tab.label)) },
                modifier = Modifier.tagged(tab.tag),
            )
        }
    }
}
