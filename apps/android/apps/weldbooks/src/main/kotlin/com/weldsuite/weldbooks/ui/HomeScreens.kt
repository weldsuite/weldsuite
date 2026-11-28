package com.weldsuite.weldbooks.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.outlined.FactCheck
import androidx.compose.material.icons.automirrored.outlined.MergeType
import androidx.compose.material.icons.automirrored.outlined.ReceiptLong
import androidx.compose.material.icons.automirrored.outlined.TrendingUp
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.outlined.AccountBalance
import androidx.compose.material.icons.outlined.Apartment
import androidx.compose.material.icons.outlined.Balance
import androidx.compose.material.icons.outlined.BarChart
import androidx.compose.material.icons.outlined.CameraAlt
import androidx.compose.material.icons.outlined.CreditCard
import androidx.compose.material.icons.outlined.Group
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.weldsuite.weldbooks.R
import com.weldsuite.weldbooks.logic.Bill
import com.weldsuite.weldbooks.logic.BooksTopics
import com.weldsuite.weldbooks.logic.Dashboard
import com.weldsuite.weldbooks.logic.DashboardSeries
import com.weldsuite.weldbooks.logic.DueItem
import com.weldsuite.weldbooks.logic.Invoice
import com.weldsuite.weldbooks.logic.Page
import com.weldsuite.weldbooks.logic.RecentPayment
import com.weldsuite.weldbooks.logic.YearToDate
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.weldsuite.core.LoadState
import org.weldsuite.ui.DayNight
import org.weldsuite.ui.LoadErrorState
import org.weldsuite.ui.OutlinedButton
import org.weldsuite.ui.RealtimeRefresh
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged
import java.math.BigDecimal
import java.time.YearMonth
import java.time.format.DateTimeFormatter

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
    var hasMore by mutableStateOf(false)
        private set
    private var page = 1

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

/** The platform's search box (a bordered input with the search icon) and a row of filter chips that scrolls sideways. */
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
        PlatformInput(
            value = search,
            onValueChange = onSearch,
            placeholder = placeholder,
            leading = { Icon(Icons.Filled.Search, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(16.dp)) },
            modifier = Modifier.tagged("search"),
        )
        if (filters.isNotEmpty()) {
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                filters.forEach { (key, label) ->
                    val on = selected == key
                    FilterChip(
                        selected = on,
                        onClick = { onSelect(key) },
                        label = { Text(label, style = MaterialTheme.typography.labelLarge) },
                        shape = MaterialTheme.shapes.small,
                        colors = FilterChipDefaults.filterChipColors(
                            containerColor = MaterialTheme.colorScheme.background,
                            labelColor = MaterialTheme.colorScheme.onSurfaceVariant,
                            selectedContainerColor = MaterialTheme.colorScheme.secondaryContainer,
                            selectedLabelColor = MaterialTheme.colorScheme.onSurface,
                        ),
                        border = FilterChipDefaults.filterChipBorder(
                            enabled = true,
                            selected = on,
                            borderColor = MaterialTheme.colorScheme.outlineVariant,
                            selectedBorderColor = MaterialTheme.colorScheme.outline,
                        ),
                        modifier = Modifier.tagged("filter-$key"),
                    )
                }
            }
        }
    }
}

// ── Dashboard ──

/** The platform's `--chart-1`. */
private val ChartColor = DayNight(Color(0xFF2C7FFF), Color(0xFF266DF0))

/**
 * The open company at a glance, as the platform's WeldBooks overview: "Today"
 * (this year's running total of a figure against last year's, and the
 * balances to act on), then what is due this week and the latest payments.
 * Above it, the actions this app starts from; captures still waiting for a
 * connection are named at the top.
 */
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
                item { QuickActions(open) }
                if (data == null) {
                    item { Box(Modifier.fillMaxWidth().padding(Tokens.Spacing.xl), contentAlignment = Alignment.Center) { CircularProgressIndicator() } }
                } else {
                    item { TodaySection(data) }
                    item { Balances(data, open) }
                    item { DueThisWeek(data.dueThisWeek, open) }
                    item { LatestPayments(data.recentPayments, data.currency, open) }
                }
                item { BottomSpace() }
            }
        }
    }
}

/** New invoice, quick expense, scan, reports: the platform's outline buttons, in a row that scrolls sideways. */
@Composable
private fun QuickActions(open: (String) -> Unit) {
    val actions = listOf(
        QuickAction(stringResource(R.string.weldbooks_invoices_new_invoice), Icons.AutoMirrored.Outlined.ReceiptLong, "invoice/new", "action-invoice"),
        QuickAction(stringResource(R.string.weldbooks_expenses_add_expense), Icons.Outlined.CreditCard, "expense/quick?documentId=&receipt=&receiptType=", "action-expense"),
        QuickAction(stringResource(R.string.weldbooks_dashboard_scan), Icons.Outlined.CameraAlt, "scan", "action-scan"),
        QuickAction(stringResource(R.string.weldbooks_dashboard_reports), Icons.Outlined.BarChart, "reports", "action-reports"),
    )
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.s),
        horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
    ) {
        actions.forEach { action ->
            OutlinedButton(
                onClick = { open(action.route) },
                contentPadding = PaddingValues(horizontal = Tokens.Spacing.m, vertical = 6.dp),
                modifier = Modifier.height(36.dp).tagged(action.tag),
            ) {
                Icon(action.icon, contentDescription = null, modifier = Modifier.size(16.dp))
                Text(action.label, style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(start = 6.dp))
            }
        }
    }
}

private data class QuickAction(val label: String, val icon: ImageVector, val route: String, val tag: String)

/** "Jan – Nov 2026": January of [year] up to the trend's last month. */
private fun span(year: Int, through: String?, locale: java.util.Locale): String {
    val last = through?.let { runCatching { YearMonth.parse(it) }.getOrNull() } ?: return ""
    val january = YearMonth.of(year, 1)
    val current = YearMonth.of(year, last.monthValue)
    return "${january.format(DateTimeFormatter.ofPattern("MMM", locale))} – ${current.format(DateTimeFormatter.ofPattern("MMM yyyy", locale))}"
}

/** "Today": a figure picked from a menu, this year's running total and last year's, and the two as lines. */
@Composable
private fun TodaySection(data: Dashboard) {
    val books = LocalBooks.current
    val hasTrend = DashboardSeries.hasTrend(data.trend)
    var metric by rememberSaveable { mutableStateOf("revenue") }
    val active = if (hasTrend) metric else "revenue"
    val ytd = remember(data.trend, active) { DashboardSeries.yearToDate(data.trend, active) }
    val labels = mapOf(
        "revenue" to stringResource(R.string.weldbooks_dashboard_revenue),
        "expenses" to stringResource(R.string.weldbooks_dashboard_expenses),
        "profit" to stringResource(R.string.weldbooks_dashboard_net_profit),
    )
    var menu by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l).padding(top = Tokens.Spacing.l)) {
        Text(stringResource(R.string.weldbooks_dashboard_today), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Medium)
        Hairline(Modifier.padding(top = Tokens.Spacing.m, bottom = Tokens.Spacing.l))
        Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.xl)) {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Box {
                    Row(
                        Modifier.clickable(enabled = hasTrend) { menu = true }.tagged("dashboard-metric"),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(labels.getValue(active), style = MaterialTheme.typography.labelLarge)
                        if (hasTrend) Icon(Icons.Filled.KeyboardArrowDown, contentDescription = stringResource(R.string.weldbooks_dashboard_metric), tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(16.dp))
                    }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        labels.forEach { (key, label) ->
                            DropdownMenuItem(text = { Text(label) }, onClick = {
                                metric = key
                                menu = false
                            })
                        }
                    }
                }
                Text(
                    books.money(ytd.total, data.currency),
                    style = MaterialTheme.typography.titleLarge.merge(Tabular),
                    fontWeight = FontWeight.Normal,
                    color = if (ytd.total.signum() < 0) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
                    maxLines = 1,
                    modifier = Modifier.tagged("kpi-profit"),
                )
                Text(span(ytd.year, ytd.throughMonth, books.locale), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(stringResource(R.string.weldbooks_dashboard_last_year), style = MaterialTheme.typography.labelLarge)
                Text(
                    books.money(ytd.lastYearTotal, data.currency),
                    style = MaterialTheme.typography.titleLarge.merge(Tabular),
                    fontWeight = FontWeight.Normal,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                )
                Text(span(ytd.year - 1, ytd.throughMonth, books.locale), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        ComparisonChart(ytd, books.locale, Modifier.padding(top = Tokens.Spacing.l))
    }
}

/**
 * The platform's hero comparison chart: this year's running total as a line in
 * the chart colour, last year's dashed and muted, one baseline, the first and
 * last month under the ends.
 */
@Composable
private fun ComparisonChart(ytd: YearToDate, locale: java.util.Locale, modifier: Modifier = Modifier) {
    val line = ChartColor.current()
    val compare = MaterialTheme.colorScheme.onSurfaceVariant
    val baseline = MaterialTheme.colorScheme.outlineVariant
    val values = ytd.points.flatMap { listOfNotNull(it.first, it.second) } + BigDecimal.ZERO
    val max = values.maxOrNull()?.toFloat() ?: 0f
    val min = values.minOrNull()?.toFloat() ?: 0f
    val range = (max - min).takeIf { it > 0f } ?: 1f
    Column(modifier.fillMaxWidth()) {
        Canvas(Modifier.fillMaxWidth().height(140.dp)) {
            val top = 4.dp.toPx()
            val height = size.height - top - 1.dp.toPx()
            fun x(index: Int) = size.width * index / 11f
            fun y(value: BigDecimal) = top + height * (max - value.toFloat()) / range
            fun path(pick: (Pair<BigDecimal?, BigDecimal?>) -> BigDecimal?): Path {
                val path = Path()
                var started = false
                ytd.points.forEachIndexed { index, point ->
                    val value = pick(point)
                    if (value == null) {
                        started = false
                    } else if (!started) {
                        path.moveTo(x(index), y(value))
                        started = true
                    } else {
                        path.lineTo(x(index), y(value))
                    }
                }
                return path
            }
            drawLine(baseline, Offset(0f, size.height - 0.5f), Offset(size.width, size.height - 0.5f), strokeWidth = 1.dp.toPx())
            drawPath(path { it.second }, compare, style = Stroke(width = 1.5.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(4.dp.toPx(), 4.dp.toPx()))))
            drawPath(path { it.first }, line, style = Stroke(width = 2.dp.toPx()))
        }
        Row(Modifier.fillMaxWidth().padding(top = 6.dp)) {
            val month = DateTimeFormatter.ofPattern("MMM", locale)
            Text(YearMonth.of(ytd.year, 1).format(month), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
            Text(YearMonth.of(ytd.year, 12).format(month), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/** Cash, to receive, to pay and documents to process: a title that opens the list, the figure, one muted line. */
@Composable
private fun Balances(data: Dashboard, open: (String) -> Unit) {
    val books = LocalBooks.current
    val danger = MaterialTheme.colorScheme.error
    val overdue = data.overdue.signum() > 0
    Column(Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.xl), verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.xl)) {
        Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.l)) {
            Balance(
                stringResource(R.string.weldbooks_dashboard_cash_balance),
                books.money(data.cashBalance, data.currency),
                pluralStringResource(R.plurals.weldbooks_dashboard_bank_account_count, data.bankAccountCount, data.bankAccountCount),
                tag = "kpi-cash",
                modifier = Modifier.weight(1f),
            ) { open("bank") }
            Balance(
                stringResource(R.string.weldbooks_dashboard_to_receive),
                books.money(data.outstanding, data.currency),
                if (overdue) stringResource(R.string.weldbooks_dashboard_overdue_amount, books.money(data.overdue, data.currency))
                else pluralStringResource(R.plurals.weldbooks_dashboard_open_invoice_count, data.outstandingCount, data.outstandingCount),
                subColor = danger.takeIf { overdue },
                subTag = "kpi-overdue",
                tag = "kpi-outstanding",
                modifier = Modifier.weight(1f),
            ) { open("invoices") }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.l)) {
            Balance(
                stringResource(R.string.weldbooks_dashboard_to_pay),
                books.money(data.payables, data.currency),
                pluralStringResource(R.plurals.weldbooks_dashboard_open_bill_count, data.payablesCount, data.payablesCount),
                tag = "kpi-payables",
                modifier = Modifier.weight(1f),
            ) { open("expenses") }
            Balance(
                stringResource(R.string.weldbooks_dashboard_documents),
                data.pendingDocuments.toString(),
                stringResource(R.string.weldbooks_dashboard_documents_waiting),
                tag = "kpi-documents",
                modifier = Modifier.weight(1f),
                onClick = null,
            )
        }
    }
}

@Composable
private fun Balance(
    label: String,
    value: String,
    sub: String,
    tag: String,
    modifier: Modifier,
    subColor: Color? = null,
    subTag: String? = null,
    onClick: (() -> Unit)?,
) {
    Column(modifier.let { if (onClick != null) it.clickable(onClick = onClick) else it }.tagged(tag), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label, style = MaterialTheme.typography.labelLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(value, style = MaterialTheme.typography.titleLarge.merge(Tabular), fontWeight = FontWeight.Normal, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(sub, style = MaterialTheme.typography.bodySmall, color = subColor ?: MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, modifier = Modifier.tagged(subTag))
    }
}

/** A titled box of rows on the dashboard: bordered, `rounded-lg`, a hairline between the rows. */
@Composable
private fun DashboardList(title: String, empty: String, tag: String, count: Int, rows: @Composable () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.s).tagged(tag), verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.m)) {
        Text(title, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
        if (count == 0) {
            Text(empty, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        } else {
            Column(Modifier.fillMaxWidth().border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(Tokens.Radius.large))) { rows() }
        }
    }
}

/** Invoices falling due and bills to pay in the next seven days (and late ones), soonest first. */
@Composable
private fun DueThisWeek(items: List<DueItem>, open: (String) -> Unit) {
    val books = LocalBooks.current
    val toReceive = stringResource(R.string.weldbooks_dashboard_to_receive)
    val toPay = stringResource(R.string.weldbooks_dashboard_to_pay)
    DashboardList(stringResource(R.string.weldbooks_dashboard_due_this_week), stringResource(R.string.weldbooks_dashboard_no_due_this_week), "due-this-week", items.size) {
        items.forEachIndexed { index, item ->
            val invoice = item.kind == "invoice"
            RecordRow(
                title = item.number ?: stringResource(R.string.weldbooks_common_dash),
                subtitle = item.contactName,
                meta = books.shortDate(item.dueDate),
                amount = books.money(item.amount, item.currency),
                badge = { ToneChip(if (invoice) toReceive else toPay, if (invoice) Tones.green else Tones.blue) },
                divider = index < items.lastIndex,
                tag = if (invoice) "due-invoice" else "due-bill",
                onClick = { open(if (invoice) "invoice/${item.id}" else "bill/${item.id}") },
            )
        }
    }
}

/** The latest payments: the date, received or paid, how, and the amount. A payment opens what it paid. */
@Composable
private fun LatestPayments(payments: List<RecentPayment>, currency: String, open: (String) -> Unit) {
    val books = LocalBooks.current
    val received = stringResource(R.string.weldbooks_dashboard_payment_received)
    val sent = stringResource(R.string.weldbooks_dashboard_payment_sent)
    DashboardList(stringResource(R.string.weldbooks_dashboard_latest_payments), stringResource(R.string.weldbooks_dashboard_no_recent_payments), "latest-payments", payments.size) {
        payments.forEachIndexed { index, payment ->
            val incoming = payment.type == "received"
            val target = payment.invoiceId?.let { "invoice/$it" } ?: payment.billId?.let { "bill/$it" }
            val how = listOfNotNull(payment.method?.let { paymentMethodLabel(it) }, payment.reference).joinToString(" · ").ifEmpty { null }
            RecordRow(
                title = books.date(payment.date),
                subtitle = how,
                amount = books.money(payment.amount, payment.currency ?: currency),
                badge = { ToneChip(if (incoming) received else sent, if (incoming) Tones.green else Tones.blue) },
                divider = index < payments.lastIndex,
                tag = "payment-row",
                onClick = target?.let { route -> { open(route) } },
            )
        }
    }
}

/** An invoice or bill in a list, as the platform's row: the number, the contact, the due date, the amount and the status chip. */
@Composable
fun DocumentRow(number: String, contactName: String?, dueDate: String, amount: String, status: String, tag: String, onClick: () -> Unit) {
    val books = LocalBooks.current
    Column {
        Row(
            Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.m).tagged(tag),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m),
        ) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(number, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (contactName != null) {
                        RowAvatar(contactName)
                        Text(
                            contactName,
                            style = secondaryStyle(),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f, fill = false),
                        )
                        Text("·", style = secondaryStyle(), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Text(
                        stringResource(R.string.weldbooks_common_due_on, books.shortDate(dueDate)),
                        style = MaterialTheme.typography.bodySmall.merge(Tabular),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                    )
                }
            }
            Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(amount, style = MaterialTheme.typography.titleSmall.merge(Tabular), maxLines = 1)
                StatusPill(status)
            }
        }
        Hairline()
    }
}

/** An invoice in a list. */
@Composable
fun InvoiceRow(invoice: Invoice, fallbackCurrency: String?, open: (String) -> Unit) {
    val books = LocalBooks.current
    DocumentRow(
        number = invoice.number ?: stringResource(R.string.weldbooks_common_draft),
        contactName = invoice.contactName,
        dueDate = invoice.dueDate,
        amount = books.money(invoice.total, invoice.currency ?: fallbackCurrency),
        status = invoice.displayStatus(),
        tag = "invoice-row",
    ) { open("invoice/${invoice.id}") }
}

/** A bill in a list. */
@Composable
fun BillRow(bill: Bill, open: (String) -> Unit) {
    val books = LocalBooks.current
    DocumentRow(
        number = bill.number ?: stringResource(R.string.weldbooks_common_draft),
        contactName = bill.contactName ?: stringResource(R.string.weldbooks_expenses_unknown_vendor, books.labels.supplierLower),
        dueDate = bill.dueDate,
        amount = books.money(bill.total, bill.currency),
        status = bill.displayStatus(),
        tag = "bill-row",
    ) { open("bill/${bill.id}") }
}

/** The groups of the invoice list, most urgent first, as on the platform. */
@Composable
private fun invoiceGroups(): List<Pair<String, String>> = listOf(
    "overdue" to stringResource(R.string.weldbooks_groups_overdue),
    "finalized" to stringResource(R.string.weldbooks_groups_finalized),
    "sent" to stringResource(R.string.weldbooks_groups_sent),
    "partial" to stringResource(R.string.weldbooks_groups_partially_paid),
    "draft" to stringResource(R.string.weldbooks_groups_draft),
    "paid" to stringResource(R.string.weldbooks_groups_paid),
    "other" to stringResource(R.string.weldbooks_groups_other),
)

private fun invoiceGroup(invoice: Invoice): String = when (invoice.displayStatus()) {
    "overdue" -> "overdue"
    "finalized" -> "finalized"
    "sent", "viewed" -> "sent"
    "partially_paid" -> "partial"
    "draft" -> "draft"
    "paid" -> "paid"
    else -> "other"
}

/** The groups of the bill list: overdue, approved (partly paid too), awaiting approval, paid. */
@Composable
private fun billGroups(): List<Pair<String, String>> = listOf(
    "overdue" to stringResource(R.string.weldbooks_groups_overdue),
    "approved" to stringResource(R.string.weldbooks_groups_approved),
    "draft" to stringResource(R.string.weldbooks_groups_draft),
    "paid" to stringResource(R.string.weldbooks_groups_paid),
    "other" to stringResource(R.string.weldbooks_groups_other),
)

private fun billGroup(bill: Bill): String = when (bill.displayStatus()) {
    "overdue" -> "overdue"
    "approved", "partially_paid" -> "approved"
    "draft", "pending" -> "draft"
    "paid" -> "paid"
    else -> "other"
}

// ── Invoices ──

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
        groups = invoiceGroups(),
        groupOf = ::invoiceGroup,
        emptyIcon = Icons.AutoMirrored.Outlined.ReceiptLong,
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
        groups = billGroups(),
        groupOf = ::billGroup,
        emptyIcon = Icons.Outlined.CreditCard,
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

/** Rows under the platform's group headers, in the groups' order; a group without rows is left out. */
@OptIn(ExperimentalFoundationApi::class)
fun <T> LazyListScope.groupedItems(
    list: List<T>,
    groups: List<Pair<String, String>>,
    groupOf: (T) -> String,
    more: Boolean,
    key: (T) -> String,
    row: @Composable (T) -> Unit,
) {
    val byGroup = list.groupBy(groupOf)
    groups.forEach { (id, label) ->
        val rows = byGroup[id].orEmpty()
        if (rows.isEmpty()) return@forEach
        stickyHeader(key = "group-$id") { GroupHeader(label, rows.size, more) }
        items(rows, key = key) { row(it) }
    }
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
    groups: List<Pair<String, String>>,
    groupOf: (T) -> String,
    emptyIcon: ImageVector,
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
                                val searching = search.isNotEmpty()
                                BooksEmptyState(
                                    icon = if (searching) Icons.Filled.Search else emptyIcon,
                                    title = if (searching) noMatchTitle else emptyTitle,
                                    description = if (searching) noMatchDescription else emptyDescription,
                                    action = newLabel.takeIf { !searching },
                                    actionTag = "$tag-empty-new",
                                    onAction = { open(newRoute) },
                                )
                            }
                        } else {
                            item { Hairline() }
                        }
                        // Grouped by status like the platform's lists, unless a status filter already picks one.
                        if (filter == "all") {
                            groupedItems(visible, groups, groupOf, list.hasMore, key, row)
                        } else {
                            items(visible, key = key) { row(it) }
                        }
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

private data class MenuEntry(val title: String, val subtitle: String, val icon: ImageVector, val route: String, val tag: String)

/**
 * The open administration, then the platform's WeldBooks menu groups this app
 * has: Bank, Reports, Contacts, and Settings. Plain rows with the menu's icons.
 */
@Composable
fun MoreScreen(open: (String) -> Unit) {
    val books = LocalBooks.current
    val snapshot by books.entities.snapshot.collectAsStateWithLifecycle()
    val sections = listOf(
        stringResource(R.string.weldbooks_more_bank) to listOf(
            MenuEntry(stringResource(R.string.weldbooks_more_bank_accounts), stringResource(R.string.weldbooks_more_bank_accounts_sub), Icons.Outlined.AccountBalance, "bank", "more-bank"),
            MenuEntry(stringResource(R.string.weldbooks_more_reconciliation), stringResource(R.string.weldbooks_more_reconciliation_sub), Icons.AutoMirrored.Outlined.MergeType, "reconciliation", "more-reconciliation"),
        ),
        stringResource(R.string.weldbooks_more_reports) to listOfNotNull(
            MenuEntry(stringResource(R.string.weldbooks_more_profit_loss), stringResource(R.string.weldbooks_more_profit_loss_sub), Icons.AutoMirrored.Outlined.TrendingUp, "reports/profit-loss", "more-profit-loss"),
            MenuEntry(stringResource(R.string.weldbooks_more_balance_sheet), stringResource(R.string.weldbooks_more_balance_sheet_sub), Icons.Outlined.Balance, "reports/balance-sheet", "more-balance-sheet"),
            // The Dutch BTW return: only companies whose country files one.
            MenuEntry(stringResource(R.string.weldbooks_more_vat_returns), stringResource(R.string.weldbooks_more_vat_returns_sub), Icons.AutoMirrored.Outlined.FactCheck, "vat", "more-vat")
                .takeIf { books.features.vatReturn },
        ),
        stringResource(R.string.weldbooks_more_contacts_group) to listOf(
            MenuEntry(stringResource(R.string.weldbooks_more_contacts), stringResource(R.string.weldbooks_more_contacts_sub, books.labels.suppliersLower), Icons.Outlined.Group, "contacts", "more-contacts"),
        ),
        stringResource(R.string.weldbooks_more_other) to listOf(
            MenuEntry(stringResource(R.string.weldbooks_more_settings), stringResource(R.string.weldbooks_more_settings_sub), Icons.Outlined.Settings, "settings", "more-settings"),
        ),
    )
    BooksScaffold(title = stringResource(R.string.weldbooks_more_title)) { padding ->
        LazyColumn(Modifier.padding(padding).fillMaxSize()) {
            val entity = snapshot.active
            if (entity != null) {
                item {
                    GroupLabel(stringResource(R.string.weldbooks_more_administration))
                    Hairline()
                    // Always opens the sheet: with one company it is where another one is added.
                    MenuRow(
                        MenuEntry(
                            entity.name,
                            "${entity.jurisdictionCode} · ${entity.baseCurrency} · " +
                                stringResource(if (snapshot.canSwitch) R.string.weldbooks_more_tap_to_switch else R.string.weldbooks_more_tap_to_add),
                            Icons.Outlined.Apartment,
                            "",
                            "administration-row",
                        ),
                    ) { books.entities.openSwitcher() }
                }
            }
            sections.forEach { (title, entries) ->
                item {
                    GroupLabel(title)
                    Hairline()
                    entries.forEach { entry -> MenuRow(entry) { open(entry.route) } }
                }
            }
            item { BottomSpace() }
        }
    }
}

/** A menu row: the item's icon, its name and a muted line, a chevron, a hairline under it. */
@Composable
private fun MenuRow(entry: MenuEntry, onClick: () -> Unit) {
    Column {
        Row(
            Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.m).tagged(entry.tag),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m),
        ) {
            ListIcon(entry.icon)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(entry.title, style = MaterialTheme.typography.titleSmall)
                Text(entry.subtitle, style = secondaryStyle(), color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(20.dp))
        }
        Hairline(Modifier.padding(start = 48.dp))
    }
}

/** Shown instead of a screen the company's country doesn't have. */
@Composable
fun FeatureUnavailable(onBack: () -> Unit) {
    BooksScaffold(title = stringResource(R.string.weldbooks_common_not_available_title), onBack = onBack) { padding ->
        Box(Modifier.padding(padding)) {
            BooksEmptyState(
                Icons.Outlined.Settings,
                stringResource(R.string.weldbooks_common_not_available_title),
                stringResource(R.string.weldbooks_common_not_available_description),
            )
        }
    }
}
