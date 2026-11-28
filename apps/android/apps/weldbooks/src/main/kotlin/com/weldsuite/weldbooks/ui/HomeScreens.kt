package com.weldsuite.weldbooks.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.outlined.ReceiptLong
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.outlined.AccountBalance
import androidx.compose.material.icons.outlined.Apartment
import androidx.compose.material.icons.outlined.BarChart
import androidx.compose.material.icons.outlined.Balance
import androidx.compose.material.icons.outlined.CameraAlt
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.automirrored.outlined.FactCheck
import androidx.compose.material.icons.outlined.Group
import androidx.compose.material.icons.automirrored.outlined.MergeType
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.automirrored.outlined.TrendingUp
import org.weldsuite.ui.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.weldsuite.weldbooks.R
import com.weldsuite.weldbooks.logic.Bill
import com.weldsuite.weldbooks.logic.BooksTopics
import com.weldsuite.weldbooks.logic.Dashboard
import com.weldsuite.weldbooks.logic.Invoice
import com.weldsuite.weldbooks.logic.Page
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.weldsuite.core.LoadState
import org.weldsuite.ui.EmptyState
import org.weldsuite.ui.LoadErrorState
import org.weldsuite.ui.RealtimeRefresh
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged

/** A searchable, filterable list that loads page by page. */
class PagedList<T>(private val fetch: suspend (page: Int, search: String?, status: String?) -> Page<T>) {
    var items by mutableStateOf<List<T>>(emptyList())
        private set
    var loading by mutableStateOf(true)
        private set
    var refreshing by mutableStateOf(false)
        private set
    var loadingMore by mutableStateOf(false)
        private set
    var error by mutableStateOf<Throwable?>(null)
        private set
    private var page = 1
    private var hasMore = false

    suspend fun load(search: String?, status: String?, refresh: Boolean = false) {
        if (refresh) refreshing = true
        runCatching { fetch(1, search, status) }
            .onSuccess {
                items = it.items
                hasMore = it.hasMore
                page = 1
                error = null
            }
            .onFailure { error = it }
        loading = false
        refreshing = false
    }

    suspend fun loadMore(search: String?, status: String?) {
        if (!hasMore || loadingMore || loading) return
        loadingMore = true
        runCatching { fetch(page + 1, search, status) }.onSuccess {
            items = items + it.items
            hasMore = it.hasMore
            page += 1
        }
        loadingMore = false
    }
}

/** A search box and a row of filter chips that scrolls sideways. */
@Composable
fun SearchAndFilters(
    search: String,
    onSearch: (String) -> Unit,
    placeholder: String,
    filters: List<Pair<String, String>>,
    selected: String,
    onSelect: (String) -> Unit,
) {
    Column(Modifier.padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.s), verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
        OutlinedTextField(
            value = search,
            onValueChange = onSearch,
            placeholder = { Text(placeholder) },
            leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth().tagged("search"),
        )
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            filters.forEach { (key, label) ->
                FilterChip(selected = selected == key, onClick = { onSelect(key) }, label = { Text(label) }, modifier = Modifier.tagged("filter-$key"))
            }
        }
    }
}

// ── Dashboard ──

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DashboardScreen(open: (String) -> Unit) {
    val books = LocalBooks.current
    val scope = rememberCoroutineScope()
    var state by remember { mutableStateOf(LoadState<Dashboard>(loading = true)) }
    var refreshing by remember { mutableStateOf(false) }
    val queue by books.queue.items.collectAsStateWithLifecycle()
    val online by books.queue.isOnline.collectAsStateWithLifecycle()
    val waiting = queue.count { it.workspaceId == books.workspaceId }

    suspend fun load() {
        state = runCatching { books.repository.dashboard() }.fold(
            onSuccess = { LoadState(it) },
            onFailure = { LoadState(state.data, error = it) },
        )
        refreshing = false
    }
    LaunchedEffect(Unit) { load() }
    RealtimeRefresh(books.env, BooksTopics.dashboard) { load() }

    BooksScaffold(
        title = books.entity?.name ?: stringResource(R.string.weldbooks_app_name),
        onTitleClick = { books.entities.openSwitcher() }.takeIf { books.entities.snapshot.value.canSwitch },
    ) { padding ->
        val data = state.data
        if (data == null && state.error != null) {
            LoadErrorState(state.error, onRetry = { scope.launch { load() } }, modifier = Modifier.padding(padding))
            return@BooksScaffold
        }
        PullToRefreshBox(isRefreshing = refreshing, onRefresh = {
            refreshing = true
            scope.launch { load() }
        }, modifier = Modifier.padding(padding)) {
            LazyColumn(Modifier.fillMaxSize().tagged("dashboard")) {
                if (!online || waiting > 0) {
                    item {
                        Banner(
                            if (online) pluralStringResource(R.plurals.weldbooks_dashboard_items_waiting, waiting, waiting)
                            else pluralStringResource(R.plurals.weldbooks_dashboard_offline_queued, waiting, waiting),
                            tone = if (online) "info" else "warning",
                        )
                    }
                }
                if (data == null) {
                    item { Box(Modifier.fillMaxWidth().padding(Tokens.Spacing.xl), contentAlignment = Alignment.Center) { CircularProgressIndicator() } }
                } else {
                    item { KpiGrid(data, open) }
                }
                item { QuickActions(open) }
                val recent = data?.recentInvoices.orEmpty()
                if (data != null && recent.isEmpty()) {
                    item {
                        EmptyState(stringResource(R.string.weldbooks_dashboard_no_invoices_title), stringResource(R.string.weldbooks_dashboard_no_invoices_description))
                    }
                }
                items(recent.take(8), key = { it.id }) { invoice -> InvoiceRow(invoice, data?.currency, open) }
            }
        }
    }
}

@Composable
private fun KpiGrid(data: Dashboard, open: (String) -> Unit) {
    val books = LocalBooks.current
    Column(Modifier.padding(horizontal = Tokens.Spacing.m), verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
        Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
            Kpi(
                stringResource(R.string.weldbooks_dashboard_outstanding),
                books.compactMoney(data.outstanding, data.currency),
                pluralStringResource(R.plurals.weldbooks_dashboard_invoice_count, data.outstandingCount, data.outstandingCount),
                warn = false,
                tag = "kpi-outstanding",
                modifier = Modifier.weight(1f),
            ) { open("invoices") }
            Kpi(
                stringResource(R.string.weldbooks_dashboard_overdue),
                books.compactMoney(data.overdue, data.currency),
                pluralStringResource(R.plurals.weldbooks_dashboard_invoice_count, data.overdueCount, data.overdueCount),
                warn = data.overdue.signum() > 0,
                tag = "kpi-overdue",
                modifier = Modifier.weight(1f),
            ) { open("invoices") }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
            Kpi(
                stringResource(R.string.weldbooks_dashboard_payables),
                books.compactMoney(data.payables, data.currency),
                pluralStringResource(R.plurals.weldbooks_dashboard_bill_count, data.payablesCount, data.payablesCount),
                warn = false,
                tag = "kpi-payables",
                modifier = Modifier.weight(1f),
            ) { open("expenses") }
            Kpi(
                stringResource(R.string.weldbooks_dashboard_profit),
                books.compactMoney(data.profitMonth, data.currency),
                stringResource(R.string.weldbooks_dashboard_this_month),
                warn = false,
                tag = "kpi-profit",
                modifier = Modifier.weight(1f),
                onClick = null,
            )
        }
    }
}

@Composable
private fun Kpi(label: String, value: String, sub: String, warn: Boolean, tag: String, modifier: Modifier, onClick: (() -> Unit)?) {
    Card(
        modifier = modifier.let { if (onClick != null) it.clickable(onClick = onClick) else it }.tagged(tag),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
        shape = RoundedCornerShape(Tokens.Radius.large),
    ) {
        Column(Modifier.padding(Tokens.Spacing.l)) {
            Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
            Text(
                value,
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.Bold,
                color = if (warn) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
            )
            Text(sub, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
        }
    }
}

@Composable
private fun QuickActions(open: (String) -> Unit) {
    val brand = Brand.current()
    val actions = listOf(
        Triple(stringResource(R.string.weldbooks_dashboard_invoice), Icons.Outlined.Description, "invoice/new"),
        Triple(stringResource(R.string.weldbooks_dashboard_expense), Icons.AutoMirrored.Outlined.ReceiptLong, "expense/quick?documentId=&receipt=&receiptType="),
        Triple(stringResource(R.string.weldbooks_dashboard_scan), Icons.Outlined.CameraAlt, "scan"),
        Triple(stringResource(R.string.weldbooks_dashboard_reports), Icons.Outlined.BarChart, "reports"),
    )
    val tags = listOf("action-invoice", "action-expense", "action-scan", "action-reports")
    Row(Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.s, vertical = Tokens.Spacing.l)) {
        actions.forEachIndexed { index, (label, icon, route) ->
            Column(
                Modifier.weight(1f).clickable { open(route) }.tagged(tags[index]),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
            ) {
                IconTile(icon, brand, size = 52.dp)
                Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
            }
        }
    }
}

/** An invoice in a list. */
@Composable
fun InvoiceRow(invoice: Invoice, fallbackCurrency: String?, open: (String) -> Unit) {
    val books = LocalBooks.current
    val draft = stringResource(R.string.weldbooks_common_draft)
    RecordRow(
        leading = { IconTile(Icons.Outlined.Description, Brand.current()) },
        title = invoice.contactName ?: invoice.number ?: draft,
        subtitle = invoice.number ?: draft,
        meta = stringResource(R.string.weldbooks_common_due_on, books.shortDate(invoice.dueDate)),
        amount = books.money(invoice.total, invoice.currency ?: fallbackCurrency),
        badge = { StatusPill(invoice.displayStatus()) },
        tag = "invoice-row",
        onClick = { open("invoice/${invoice.id}") },
    )
}

/** A bill in a list. */
@Composable
fun BillRow(bill: Bill, open: (String) -> Unit) {
    val books = LocalBooks.current
    RecordRow(
        leading = { IconTile(Icons.AutoMirrored.Outlined.ReceiptLong, Brand.current()) },
        title = bill.contactName ?: stringResource(R.string.weldbooks_expenses_unknown_vendor, books.labels.supplierLower),
        subtitle = bill.number ?: stringResource(R.string.weldbooks_common_draft),
        meta = stringResource(R.string.weldbooks_common_due_on, books.shortDate(bill.dueDate)),
        amount = books.money(bill.total, bill.currency),
        badge = { StatusPill(bill.displayStatus()) },
        tag = "bill-row",
        onClick = { open("bill/${bill.id}") },
    )
}

// ── Invoices ──

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InvoicesScreen(open: (String) -> Unit) {
    val books = LocalBooks.current
    val filters = listOf(
        "all" to stringResource(R.string.weldbooks_invoices_filter_all),
        "draft" to stringResource(R.string.weldbooks_invoices_filter_draft),
        "sent" to stringResource(R.string.weldbooks_invoices_filter_sent),
        "overdue" to stringResource(R.string.weldbooks_invoices_filter_overdue),
        "paid" to stringResource(R.string.weldbooks_invoices_filter_paid),
    )
    DocumentList(
        title = stringResource(R.string.weldbooks_invoices_title),
        newLabel = stringResource(R.string.weldbooks_invoices_new_invoice),
        newRoute = "invoice/new",
        searchPlaceholder = stringResource(R.string.weldbooks_invoices_search_placeholder),
        filters = filters,
        topics = BooksTopics.invoices,
        // `overdue` is derived, not a stored status: it is filtered here.
        statusFor = { key -> key.takeIf { it in setOf("draft", "sent", "paid") } },
        fetch = { page, search, status -> books.repository.invoices(page, 20, search, status) },
        keep = { invoice, filter -> filter != "overdue" || invoice.displayStatus() == "overdue" },
        emptyTitle = stringResource(R.string.weldbooks_invoices_empty_title),
        emptyDescription = stringResource(R.string.weldbooks_invoices_empty_description),
        noMatchTitle = stringResource(R.string.weldbooks_invoices_no_match_title),
        noMatchDescription = stringResource(R.string.weldbooks_invoices_no_match_description),
        loadError = stringResource(R.string.weldbooks_invoices_load_error),
        key = { it.id },
        open = open,
        tag = "invoices",
    ) { invoice -> InvoiceRow(invoice, null, open) }
}

// ── Expenses ──

@Composable
fun ExpensesScreen(open: (String) -> Unit) {
    val books = LocalBooks.current
    val filters = listOf(
        "all" to stringResource(R.string.weldbooks_expenses_filter_all),
        "draft" to stringResource(R.string.weldbooks_expenses_filter_draft),
        "pending" to stringResource(R.string.weldbooks_expenses_filter_pending),
        "approved" to stringResource(R.string.weldbooks_expenses_filter_approved),
        "overdue" to stringResource(R.string.weldbooks_expenses_filter_overdue),
        "paid" to stringResource(R.string.weldbooks_expenses_filter_paid),
    )
    DocumentList(
        title = stringResource(R.string.weldbooks_expenses_title),
        newLabel = stringResource(R.string.weldbooks_expenses_add_expense),
        newRoute = "expense/quick?documentId=&receipt=&receiptType=",
        searchPlaceholder = stringResource(R.string.weldbooks_expenses_search_placeholder),
        filters = filters,
        topics = BooksTopics.bills,
        // A bill awaiting approval is a draft on the server; `overdue` is derived here.
        statusFor = { key ->
            when (key) {
                "pending" -> "draft"
                "draft", "approved", "paid" -> key
                else -> null
            }
        },
        fetch = { page, search, status -> books.repository.bills(page, 20, search, status) },
        keep = { bill, filter -> filter != "overdue" || bill.displayStatus() == "overdue" },
        emptyTitle = stringResource(R.string.weldbooks_expenses_empty_title),
        emptyDescription = stringResource(R.string.weldbooks_expenses_empty_description),
        noMatchTitle = stringResource(R.string.weldbooks_expenses_no_match_title),
        noMatchDescription = stringResource(R.string.weldbooks_expenses_no_match_description),
        loadError = stringResource(R.string.weldbooks_expenses_load_error),
        key = { it.id },
        open = open,
        tag = "expenses",
    ) { bill -> BillRow(bill, open) }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun <T> DocumentList(
    title: String,
    newLabel: String,
    newRoute: String,
    searchPlaceholder: String,
    filters: List<Pair<String, String>>,
    topics: List<String>,
    statusFor: (String) -> String?,
    fetch: suspend (Int, String?, String?) -> Page<T>,
    keep: (T, String) -> Boolean,
    emptyTitle: String,
    emptyDescription: String,
    noMatchTitle: String,
    noMatchDescription: String,
    loadError: String,
    key: (T) -> String,
    open: (String) -> Unit,
    tag: String,
    row: @Composable (T) -> Unit,
) {
    val books = LocalBooks.current
    val scope = rememberCoroutineScope()
    val list = remember { PagedList(fetch) }
    var search by rememberSaveable { mutableStateOf("") }
    var filter by rememberSaveable { mutableStateOf("all") }
    LaunchedEffect(search, filter) {
        if (search.isNotEmpty()) delay(300)
        list.load(search.trim().ifEmpty { null }, statusFor(filter))
    }
    RealtimeRefresh(books.env, topics) { list.load(search.trim().ifEmpty { null }, statusFor(filter)) }
    val visible = list.items.filter { keep(it, filter) }
    val state = rememberLazyListState()
    val nearEnd by remember { derivedStateOf { state.layoutInfo.visibleItemsInfo.lastOrNull()?.index?.let { it >= state.layoutInfo.totalItemsCount - 4 } == true } }
    LaunchedEffect(nearEnd) { if (nearEnd) list.loadMore(search.trim().ifEmpty { null }, statusFor(filter)) }

    BooksScaffold(
        title = title,
        actions = {
            IconButton(onClick = { open(newRoute) }, modifier = Modifier.tagged("$tag-new")) { Icon(Icons.Filled.Add, contentDescription = newLabel) }
        },
    ) { padding ->
        Column(Modifier.padding(padding)) {
            SearchAndFilters(search, { search = it }, searchPlaceholder, filters, filter) { filter = it }
            when {
                list.loading -> org.weldsuite.ui.CenteredProgress()
                list.error != null && visible.isEmpty() -> Column {
                    Banner(loadError, tone = "error")
                    LoadErrorState(list.error, onRetry = { scope.launch { list.load(search.ifEmpty { null }, statusFor(filter)) } })
                }
                else -> PullToRefreshBox(
                    isRefreshing = list.refreshing,
                    onRefresh = { scope.launch { list.load(search.trim().ifEmpty { null }, statusFor(filter), refresh = true) } },
                ) {
                    LazyColumn(Modifier.fillMaxSize().tagged(tag), state = state) {
                        if (visible.isEmpty()) {
                            item {
                                EmptyState(
                                    if (search.isNotEmpty()) noMatchTitle else emptyTitle,
                                    if (search.isNotEmpty()) noMatchDescription else emptyDescription,
                                )
                                if (search.isEmpty()) {
                                    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                                        androidx.compose.material3.Button(onClick = { open(newRoute) }, modifier = Modifier.tagged("$tag-empty-new")) { Text(newLabel) }
                                    }
                                }
                            }
                        }
                        items(visible, key = key) { row(it) }
                        if (list.loadingMore) {
                            item { Box(Modifier.fillMaxWidth().padding(Tokens.Spacing.l), contentAlignment = Alignment.Center) { CircularProgressIndicator() } }
                        }
                    }
                }
            }
        }
    }
}

// ── More ──

private data class MenuEntry(val title: String, val subtitle: String, val icon: ImageVector, val color: Color, val route: String, val tag: String)

@Composable
fun MoreScreen(open: (String) -> Unit) {
    val books = LocalBooks.current
    val snapshot by books.entities.snapshot.collectAsStateWithLifecycle()
    val sections = listOf(
        stringResource(R.string.weldbooks_more_financial) to listOfNotNull(
            MenuEntry(stringResource(R.string.weldbooks_more_bank_accounts), stringResource(R.string.weldbooks_more_bank_accounts_sub), Icons.Outlined.AccountBalance, Accents.banking, "bank", "more-bank"),
            MenuEntry(stringResource(R.string.weldbooks_more_reconciliation), stringResource(R.string.weldbooks_more_reconciliation_sub), Icons.AutoMirrored.Outlined.MergeType, Accents.reconciliation, "reconciliation", "more-reconciliation"),
            // The Dutch BTW return: only companies whose country files one.
            MenuEntry(stringResource(R.string.weldbooks_more_vat_returns), stringResource(R.string.weldbooks_more_vat_returns_sub), Icons.AutoMirrored.Outlined.FactCheck, Accents.vat, "vat", "more-vat")
                .takeIf { books.features.vatReturn },
        ),
        stringResource(R.string.weldbooks_more_reports) to listOf(
            MenuEntry(stringResource(R.string.weldbooks_more_profit_loss), stringResource(R.string.weldbooks_more_profit_loss_sub), Icons.AutoMirrored.Outlined.TrendingUp, Accents.profitLoss, "reports/profit-loss", "more-profit-loss"),
            MenuEntry(stringResource(R.string.weldbooks_more_balance_sheet), stringResource(R.string.weldbooks_more_balance_sheet_sub), Icons.Outlined.Balance, Accents.balanceSheet, "reports/balance-sheet", "more-balance-sheet"),
        ),
        stringResource(R.string.weldbooks_more_other) to listOf(
            MenuEntry(stringResource(R.string.weldbooks_more_contacts), stringResource(R.string.weldbooks_more_contacts_sub, books.labels.suppliersLower), Icons.Outlined.Group, Accents.contacts, "contacts", "more-contacts"),
            MenuEntry(stringResource(R.string.weldbooks_more_settings), stringResource(R.string.weldbooks_more_settings_sub), Icons.Outlined.Settings, Accents.settings, "settings", "more-settings"),
        ),
    )
    BooksScaffold(title = stringResource(R.string.weldbooks_more_title)) { padding ->
        LazyColumn(Modifier.padding(padding).fillMaxSize()) {
            val entity = snapshot.active
            if (entity != null) {
                item {
                    GroupLabel(stringResource(R.string.weldbooks_more_administration))
                    SectionCard(padded = false) {
                        // Always opens the sheet: with one company it is where another one is added.
                        MenuRow(
                            MenuEntry(
                                entity.name,
                                "${entity.jurisdictionCode} · ${entity.baseCurrency} · " +
                                    stringResource(if (snapshot.canSwitch) R.string.weldbooks_more_tap_to_switch else R.string.weldbooks_more_tap_to_add),
                                Icons.Outlined.Apartment,
                                Accents.settings,
                                "",
                                "administration-row",
                            ),
                        ) { books.entities.openSwitcher() }
                    }
                }
            }
            sections.forEach { (title, entries) ->
                item {
                    GroupLabel(title)
                    SectionCard(padded = false) {
                        entries.forEachIndexed { index, entry ->
                            if (index > 0) HorizontalDivider(Modifier.padding(start = 68.dp))
                            MenuRow(entry) { open(entry.route) }
                        }
                    }
                }
            }
            item { BottomSpace() }
        }
    }
}

@Composable
private fun MenuRow(entry: MenuEntry, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.m).tagged(entry.tag),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m),
    ) {
        IconTile(entry.icon, entry.color)
        Column(Modifier.weight(1f)) {
            Text(entry.title, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold)
            Text(entry.subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** Shown instead of a screen the company's country doesn't have. */
@Composable
fun FeatureUnavailable(onBack: () -> Unit) {
    BooksScaffold(title = stringResource(R.string.weldbooks_common_not_available_title), onBack = onBack) { padding ->
        Box(Modifier.padding(padding)) {
            EmptyState(stringResource(R.string.weldbooks_common_not_available_title), stringResource(R.string.weldbooks_common_not_available_description))
        }
    }
}

/** An icon and two lines for an empty list with an icon. */
@Composable
fun IconEmptyState(icon: ImageVector, title: String, description: String) {
    EmptyState(title, description, icon = { Icon(icon, contentDescription = null, modifier = Modifier.size(32.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant) })
}

