package com.weldsuite.weldbooks.ui

import androidx.compose.foundation.border
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.outlined.CallMade
import androidx.compose.material.icons.automirrored.outlined.CallReceived
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.automirrored.outlined.TrendingUp
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.automirrored.outlined.CompareArrows
import androidx.compose.material.icons.outlined.AccountBalance
import androidx.compose.material.icons.outlined.CreditCard
import androidx.compose.material.icons.outlined.Tag
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material.icons.outlined.Balance
import androidx.compose.material.icons.automirrored.outlined.FactCheck
import androidx.compose.material.icons.automirrored.outlined.MergeType
import org.weldsuite.ui.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.weldsuite.weldbooks.R
import com.weldsuite.weldbooks.logic.Amounts
import com.weldsuite.weldbooks.logic.BalanceRow
import com.weldsuite.weldbooks.logic.BalanceSheet
import com.weldsuite.weldbooks.logic.BankAccount
import com.weldsuite.weldbooks.logic.BankTransaction
import com.weldsuite.weldbooks.logic.BooksTopics
import com.weldsuite.weldbooks.logic.Days
import com.weldsuite.weldbooks.logic.MatchSuggestion
import com.weldsuite.weldbooks.logic.Payments
import com.weldsuite.weldbooks.logic.ProfitLoss
import com.weldsuite.weldbooks.logic.ReconciliationStats
import com.weldsuite.weldbooks.logic.UnmatchedTransaction
import com.weldsuite.weldbooks.logic.VatReturn
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.weldsuite.ui.CenteredProgress
import org.weldsuite.ui.EmptyState
import org.weldsuite.ui.LoadErrorState
import org.weldsuite.ui.RealtimeRefresh
import org.weldsuite.ui.StatusBadge
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged
import java.math.BigDecimal

/** A screen's data: loaded once, refreshed by pull, realtime or after an action; a failed refresh keeps what was shown. */
class Loaded<T>(private val scope: CoroutineScope, private val fetch: suspend () -> T) {
    var data by mutableStateOf<T?>(null)
        private set
    var error by mutableStateOf<Throwable?>(null)
        private set
    var loading by mutableStateOf(true)
        private set
    var refreshing by mutableStateOf(false)
        private set

    suspend fun load() {
        runCatching { fetch() }
            .onSuccess {
                data = it
                error = null
            }
            .onFailure { error = it }
        loading = false
        refreshing = false
    }

    fun refresh() {
        refreshing = true
        scope.launch { load() }
    }

    fun retry() {
        loading = true
        scope.launch { load() }
    }

    /** Change what is shown without a round trip (an item just handled). */
    fun update(change: (T) -> T) {
        data = data?.let(change)
    }
}

@Composable
fun <T> rememberLoaded(vararg keys: Any?, fetch: suspend () -> T): Loaded<T> {
    val scope = rememberCoroutineScope()
    val loaded = remember(*keys) { Loaded(scope, fetch) }
    LaunchedEffect(loaded) { loaded.load() }
    return loaded
}

/** Loading, the error with a retry, or the content with pull to refresh. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun <T> LoadedContent(loaded: Loaded<T>, loadError: String, modifier: Modifier = Modifier, content: @Composable (T) -> Unit) {
    val data = loaded.data
    when {
        data != null -> PullToRefreshBox(isRefreshing = loaded.refreshing, onRefresh = { loaded.refresh() }, modifier = modifier.fillMaxSize()) {
            content(data)
        }
        loaded.loading -> CenteredProgress(modifier)
        else -> Column(modifier) {
            Banner(loadError, tone = "error")
            LoadErrorState(loaded.error, onRetry = { loaded.retry() })
        }
    }
}


@Composable
fun bankAccountTypeLabel(type: String): String = when (type) {
    "checking" -> stringResource(R.string.weldbooks_bank_account_types_checking)
    "savings" -> stringResource(R.string.weldbooks_bank_account_types_savings)
    "credit_card" -> stringResource(R.string.weldbooks_bank_account_types_credit_card)
    "money_market" -> stringResource(R.string.weldbooks_bank_account_types_money_market)
    "line_of_credit" -> stringResource(R.string.weldbooks_bank_account_types_line_of_credit)
    else -> type
}

@Composable
private fun bankSubtitle(account: BankAccount): String? {
    val labels = Payments.bankAccountTypes.associateWith { bankAccountTypeLabel(it) }
    return Payments.accountSubtitle(account) { labels[it] ?: it }
}

// ── Bank accounts ──

/** Balances across every bank account; a total only when they share a currency. */
@Composable
fun BankAccountsScreen(onBack: () -> Unit, open: (String) -> Unit) {
    val books = LocalBooks.current
    val loaded = rememberLoaded { books.repository.bankAccounts() }
    RealtimeRefresh(books.env, BooksTopics.banking) { loaded.load() }
    val danger = Tokens.Status.danger.current()
    BooksScaffold(title = stringResource(R.string.weldbooks_bank_title), onBack = onBack) { padding ->
        LoadedContent(loaded, stringResource(R.string.weldbooks_bank_load_error), Modifier.padding(padding)) { accounts ->
            LazyColumn(Modifier.fillMaxSize().tagged("bank-accounts")) {
                val currency = accounts.firstOrNull()?.currency
                if (accounts.isNotEmpty() && accounts.all { it.currency == currency }) {
                    item {
                        KpiCard(
                            stringResource(R.string.weldbooks_bank_total_balance),
                            books.money(accounts.fold(BigDecimal.ZERO) { sum, account -> sum + account.balance }, currency),
                            icon = Icons.Outlined.AccountBalance,
                            modifier = Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.s),
                            tag = "bank-total",
                        )
                    }
                }
                if (accounts.isEmpty()) {
                    item {
                        BooksEmptyState(Icons.Outlined.AccountBalance, stringResource(R.string.weldbooks_bank_empty_title), stringResource(R.string.weldbooks_bank_empty_description))
                    }
                } else {
                    item { Hairline(Modifier.padding(top = Tokens.Spacing.s)) }
                }
                items(accounts, key = { it.id }) { account ->
                    RecordRow(
                        title = account.name,
                        subtitle = bankSubtitle(account),
                        meta = account.lastImportDate?.let { stringResource(R.string.weldbooks_bank_last_import, books.date(it)) }
                            ?: stringResource(R.string.weldbooks_bank_never_imported),
                        amount = books.money(account.balance, account.currency),
                        amountColor = if (account.balance.signum() < 0) danger else null,
                        tag = "bank-account-row",
                        onClick = { open("bank/${account.id}") },
                    )
                }
                item { BottomSpace() }
            }
        }
    }
}

/** One bank account: its balance and the 50 latest transactions. */
@Composable
fun BankAccountScreen(id: String, onBack: () -> Unit) {
    val books = LocalBooks.current
    val loaded = rememberLoaded(id) { books.repository.bankAccount(id) }
    RealtimeRefresh(books.env, BooksTopics.banking) { loaded.load() }
    val account = loaded.data?.first
    val unreconciled = stringResource(R.string.weldbooks_groups_unreconciled)
    val reconciled = stringResource(R.string.weldbooks_groups_reconciled)
    val excluded = stringResource(R.string.weldbooks_groups_excluded)
    BooksScaffold(
        title = account?.name ?: stringResource(R.string.weldbooks_bank_detail_title),
        subtitle = account?.let { bankSubtitle(it) },
        onBack = onBack,
    ) { padding ->
        LoadedContent(loaded, stringResource(R.string.weldbooks_bank_detail_load_error), Modifier.padding(padding)) { (bank, transactions) ->
            LazyColumn(Modifier.fillMaxSize().tagged("bank-account")) {
                item { BankBalanceCard(bank) }
                if (transactions.isEmpty()) {
                    item {
                        BooksEmptyState(
                            Icons.AutoMirrored.Outlined.CompareArrows,
                            stringResource(R.string.weldbooks_bank_detail_empty_title),
                            stringResource(R.string.weldbooks_bank_detail_empty_description),
                        )
                    }
                }
                // Grouped by status like the platform's transaction list.
                groupedItems(
                    transactions,
                    listOf(
                        "unreconciled" to unreconciled,
                        "reconciled" to reconciled,
                        "excluded" to excluded,
                    ),
                    groupOf = { line -> if (line.status == "reconciled" || line.status == "excluded") line.status else "unreconciled" },
                    more = false,
                    key = { it.id },
                ) { line -> TransactionRow(line, bank.currency) }
                item { BottomSpace() }
            }
        }
    }
}

/** The balance as the platform's KPI card, then the account's properties. */
@Composable
private fun BankBalanceCard(account: BankAccount) {
    val books = LocalBooks.current
    KpiCard(
        stringResource(R.string.weldbooks_bank_detail_current_balance),
        books.money(account.balance, account.currency),
        hint = account.bankName,
        icon = Icons.Outlined.AccountBalance,
        tone = Tokens.Status.danger.current().takeIf { account.balance.signum() < 0 },
        modifier = Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.s),
        tag = "bank-balance",
    )
    if (account.routingNumber != null || account.accountNumberLast4 != null) {
        PanelSection {
            account.accountType?.takeIf { it in Payments.bankAccountTypes }?.let {
                PropertyRow(Icons.Outlined.AccountBalance, stringResource(R.string.weldbooks_bank_detail_account_type), bankAccountTypeLabel(it))
            }
            account.routingNumber?.let { PropertyRow(Icons.Outlined.Tag, stringResource(R.string.weldbooks_bank_detail_routing_number), it) }
            Payments.masked(account.accountNumberLast4)?.let { PropertyRow(Icons.Outlined.CreditCard, stringResource(R.string.weldbooks_bank_detail_account_number), it) }
        }
    }
    Hairline(Modifier.padding(top = Tokens.Spacing.s))
}

/**
 * A bank line as the platform's transaction list draws it: the description,
 * the counterparty with its avatar, the date, the amount (green coming in) and
 * the status chip.
 */
@Composable
private fun TransactionRow(line: BankTransaction, currency: String?) {
    val books = LocalBooks.current
    val incoming = line.amount.signum() >= 0
    val (label, tone) = when (line.status) {
        "reconciled" -> stringResource(R.string.weldbooks_bank_detail_reconciled) to Tones.green
        "excluded" -> stringResource(R.string.weldbooks_bank_detail_excluded) to Tones.gray
        else -> stringResource(R.string.weldbooks_bank_detail_unmatched) to Tones.gray
    }
    RecordRow(
        title = line.description ?: line.counterpartyName ?: stringResource(R.string.weldbooks_bank_detail_transaction),
        // The counterparty and the bank's reference, the platform's Counterparty and Reference columns.
        subtitle = listOfNotNull(line.counterpartyName?.takeIf { line.description != null }, line.reference).joinToString(" · ").ifEmpty { null },
        meta = books.shortDate(line.date),
        amount = books.money(line.amount, currency),
        amountColor = if (incoming) Tones.positive.current() else null,
        badge = { ToneChip(label, tone) },
        tag = "transaction-row",
    )
}

// ── Reconciliation ──

private data class Reconciliation(val stats: ReconciliationStats, val lines: List<UnmatchedTransaction>, val hasBankAccount: Boolean)

/**
 * Bank reconciliation: each open line with the invoices and bills it may pay;
 * a tap on one reconciles it. The confidence shows so a weak suggestion reads
 * as a guess.
 */
@Composable
fun ReconciliationScreen(onBack: () -> Unit) {
    val books = LocalBooks.current
    val notify = LocalNotify.current
    val errors = LocalErrors.current
    val scope = rememberCoroutineScope()
    val loaded = rememberLoaded {
        val stats = books.repository.reconciliationStats()
        val lines = books.repository.unmatchedTransactions(20)
        val accounts = books.repository.bankAccounts()
        Reconciliation(stats, lines, accounts.isNotEmpty())
    }
    RealtimeRefresh(books.env, BooksTopics.banking) { loaded.load() }
    var matching by remember { mutableStateOf<String?>(null) }
    val matched = stringResource(R.string.weldbooks_reconciliation_matched)
    val failed = stringResource(R.string.weldbooks_reconciliation_match_failed)

    fun match(line: UnmatchedTransaction, suggestion: MatchSuggestion) {
        matching = line.transaction.id
        scope.launch {
            runCatching { books.repository.reconcile(line.transaction.id, suggestion) }
                .onSuccess {
                    notify(matched)
                    // Drop it here so the list doesn't jump while the counts refresh.
                    loaded.update { current ->
                        current.copy(
                            lines = current.lines.filter { it.transaction.id != line.transaction.id },
                            stats = current.stats.copy(unmatched = (current.stats.unmatched - 1).coerceAtLeast(0), matched = current.stats.matched + 1),
                        )
                    }
                }
                .onFailure { notify(errors.describe(it, failed)) }
            matching = null
        }
    }

    BooksScaffold(title = stringResource(R.string.weldbooks_reconciliation_title), onBack = onBack) { padding ->
        LoadedContent(loaded, stringResource(R.string.weldbooks_reconciliation_load_error), Modifier.padding(padding)) { data ->
            LazyColumn(Modifier.fillMaxSize().tagged("reconciliation")) {
                // Without a bank account there is nothing to reconcile: "everything reconciled" would be a lie.
                if (!data.hasBankAccount) {
                    item {
                        BooksEmptyState(Icons.Outlined.AccountBalance, stringResource(R.string.weldbooks_bank_empty_title), stringResource(R.string.weldbooks_bank_empty_description))
                    }
                    return@LazyColumn
                }
                item { ReconciliationStatsRow(data.stats) }
                if (data.lines.isEmpty()) {
                    item {
                        BooksEmptyState(
                            Icons.AutoMirrored.Outlined.MergeType,
                            stringResource(R.string.weldbooks_reconciliation_empty_title),
                            stringResource(R.string.weldbooks_reconciliation_empty_description),
                        )
                    }
                }
                items(data.lines, key = { it.transaction.id }) { line ->
                    UnmatchedCard(line, busy = matching == line.transaction.id) { suggestion -> match(line, suggestion) }
                }
                item { BottomSpace() }
            }
        }
    }
}

@Composable
private fun ReconciliationStatsRow(stats: ReconciliationStats) {
    val books = LocalBooks.current
    // The platform's KPI cards: what is open, what is done, and the money still to match.
    Column(Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.s), verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.m)) {
        Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m)) {
            KpiCard(stringResource(R.string.weldbooks_reconciliation_unmatched), stats.unmatched.toString(), modifier = Modifier.weight(1f), tag = "stat-unmatched")
            KpiCard(
                stringResource(R.string.weldbooks_reconciliation_reconciled),
                stats.matched.toString(),
                tone = Tones.positive.current(),
                modifier = Modifier.weight(1f),
                tag = "stat-reconciled",
            )
        }
        KpiCard(stringResource(R.string.weldbooks_reconciliation_pending), books.money(stats.pendingAmount), modifier = Modifier.fillMaxWidth(), tag = "stat-pending")
    }
}

@Composable
private fun UnmatchedCard(line: UnmatchedTransaction, busy: Boolean, onMatch: (MatchSuggestion) -> Unit) {
    val books = LocalBooks.current
    val tx = line.transaction
    val incoming = tx.amount.signum() >= 0
    val positive = Tones.positive.current()
    val invoiceWord = stringResource(R.string.weldbooks_reconciliation_invoice)
    val billWord = stringResource(R.string.weldbooks_reconciliation_bill)
    SectionCard(modifier = Modifier.tagged("unmatched-transaction")) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m)) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(tx.description ?: tx.counterpartyName ?: stringResource(R.string.weldbooks_reconciliation_transaction), style = MaterialTheme.typography.titleSmall, maxLines = 1)
                Text(books.shortDate(tx.date), style = MaterialTheme.typography.bodySmall.merge(Tabular), color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Text(books.money(tx.amount), style = MaterialTheme.typography.titleSmall.merge(Tabular), color = if (incoming) positive else MaterialTheme.colorScheme.onSurface)
        }
        if (line.suggestions.isEmpty()) {
            HintText(stringResource(R.string.weldbooks_reconciliation_no_suggestions))
            return@SectionCard
        }
        Hairline(Modifier.padding(vertical = Tokens.Spacing.m))
        Text(stringResource(R.string.weldbooks_reconciliation_suggested_matches), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        line.suggestions.forEach { suggestion ->
            val description = listOfNotNull(if (suggestion.type == "invoice") invoiceWord else billWord, suggestion.number, suggestion.contactName).joinToString(" · ")
            val percent = (suggestion.confidence * 100).toInt()
            val tone = when {
                suggestion.confidence >= 0.8 -> Tones.green
                suggestion.confidence >= 0.6 -> Tones.amber
                else -> Tones.gray
            }
            val label = stringResource(R.string.weldbooks_reconciliation_match_with, description)
            Row(
                Modifier.fillMaxWidth().padding(top = Tokens.Spacing.s)
                    .border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(Tokens.Radius.medium))
                    .clickable(enabled = !busy, onClickLabel = label) { onMatch(suggestion) }
                    .padding(Tokens.Spacing.m)
                    .tagged("match-suggestion"),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
            ) {
                Column(Modifier.weight(1f)) {
                    Text(description, style = MaterialTheme.typography.bodyMedium, maxLines = 1)
                    Text(books.money(suggestion.amount), style = MaterialTheme.typography.bodySmall.merge(Tabular), color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                ToneChip("$percent%", tone)
                Icon(Icons.Filled.Check, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(16.dp))
            }
        }
    }
}

// ── Reports ──

@Composable
fun ReportsScreen(onBack: () -> Unit, open: (String) -> Unit) {
    val reports = listOf(
        ReportEntry(stringResource(R.string.weldbooks_reports_profit_loss), stringResource(R.string.weldbooks_reports_profit_loss_sub), Icons.AutoMirrored.Outlined.TrendingUp, "reports/profit-loss", "report-profit-loss"),
        ReportEntry(stringResource(R.string.weldbooks_reports_balance_sheet), stringResource(R.string.weldbooks_reports_balance_sheet_sub), Icons.Outlined.Balance, "reports/balance-sheet", "report-balance-sheet"),
    )
    BooksScaffold(title = stringResource(R.string.weldbooks_reports_title), onBack = onBack) { padding ->
        Column(Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).tagged("reports")) {
            Hairline()
            // Plain rows with the platform menu's report icon.
            reports.forEach { report ->
                Row(
                    Modifier.fillMaxWidth().clickable { open(report.route) }.padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.m).tagged(report.tag),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m),
                ) {
                    ListIcon(report.icon)
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(report.title, style = MaterialTheme.typography.titleSmall)
                        Text(report.subtitle, style = secondaryStyle(), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(20.dp))
                }
                Hairline(Modifier.padding(start = 48.dp))
            }
        }
    }
}

private data class ReportEntry(val title: String, val subtitle: String, val icon: ImageVector, val route: String, val tag: String)

/** Profit and loss for this month or this year; the margin is worked out here, 0% without revenue. */
@Composable
fun ProfitLossScreen(onBack: () -> Unit) {
    val books = LocalBooks.current
    var period by rememberSaveable { mutableStateOf("month") }
    val (from, to) = if (period == "year") Days.yearRange() else Days.monthRange()
    val loaded = rememberLoaded(period) { books.repository.profitLoss(from.toString(), to.toString()) }
    RealtimeRefresh(books.env, BooksTopics.reports) { loaded.load() }
    BooksScaffold(
        title = stringResource(R.string.weldbooks_profit_loss_title),
        subtitle = "${books.date(from.toString())} – ${books.date(to.toString())}",
        onBack = onBack,
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            PeriodSwitch(period) { period = it }
            LoadedContent(loaded, stringResource(R.string.weldbooks_profit_loss_load_error)) { data -> ProfitLossBody(data) }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PeriodSwitch(period: String, onChange: (String) -> Unit) {
    val options = listOf(
        "month" to stringResource(R.string.weldbooks_profit_loss_this_month),
        "year" to stringResource(R.string.weldbooks_profit_loss_this_year),
    )
    SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.m, vertical = Tokens.Spacing.s)) {
        options.forEachIndexed { index, (key, label) ->
            SegmentedButton(
                selected = period == key,
                onClick = { onChange(key) },
                shape = SegmentedButtonDefaults.itemShape(index, options.size),
                modifier = Modifier.tagged("period-$key"),
            ) { Text(label) }
        }
    }
}

@Composable
private fun ProfitLossBody(data: ProfitLoss) {
    val books = LocalBooks.current
    val profitable = data.netProfit.signum() >= 0
    val net = stringResource(if (profitable) R.string.weldbooks_profit_loss_net_profit else R.string.weldbooks_profit_loss_net_loss)
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).tagged("profit-loss")) {
        KpiCard(
            net,
            books.money(data.netProfit.abs()),
            hint = stringResource(R.string.weldbooks_profit_loss_margin, "${Amounts.plain(data.margin)}%"),
            icon = Icons.AutoMirrored.Outlined.TrendingUp,
            tone = if (profitable) Tones.positive.current() else Tokens.Status.danger.current(),
            modifier = Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.s),
            tag = "net-profit",
        )
        SectionCard(title = stringResource(R.string.weldbooks_profit_loss_breakdown)) {
            TotalsBlock(
                rows = listOf(
                    stringResource(R.string.weldbooks_profit_loss_revenue) to books.money(data.revenue),
                    stringResource(R.string.weldbooks_profit_loss_expenses) to "−" + books.money(data.expenses),
                ),
                total = net to books.money(data.netProfit),
            )
        }
        BottomSpace()
    }
}

/** The balance sheet; a difference between assets and liabilities plus equity is flagged, not rounded away. */
@Composable
fun BalanceSheetScreen(onBack: () -> Unit) {
    val books = LocalBooks.current
    val loaded = rememberLoaded { books.repository.balanceSheet() }
    RealtimeRefresh(books.env, BooksTopics.reports) { loaded.load() }
    BooksScaffold(title = stringResource(R.string.weldbooks_balance_sheet_title), onBack = onBack) { padding ->
        LoadedContent(loaded, stringResource(R.string.weldbooks_balance_sheet_load_error), Modifier.padding(padding)) { data -> BalanceSheetBody(data) }
    }
}

@Composable
private fun BalanceSheetBody(data: BalanceSheet) {
    val books = LocalBooks.current
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).tagged("balance-sheet")) {
        KpiCard(
            stringResource(R.string.weldbooks_balance_sheet_total_assets),
            books.money(data.totalAssets),
            icon = Icons.Outlined.Balance,
            modifier = Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.s),
            tag = "total-assets",
        )
        if (!data.isBalanced) {
            Banner(
                stringResource(R.string.weldbooks_balance_sheet_unbalanced_body, books.money(data.totalAssets), books.money(data.totalLiabilitiesAndEquity)),
                tone = "warning",
                title = stringResource(R.string.weldbooks_balance_sheet_unbalanced_title),
            )
        }
        BalanceSection(stringResource(R.string.weldbooks_balance_sheet_assets), stringResource(R.string.weldbooks_balance_sheet_total_assets_label), data.assets, data.totalAssets)
        BalanceSection(stringResource(R.string.weldbooks_balance_sheet_liabilities), stringResource(R.string.weldbooks_balance_sheet_total_liabilities), data.liabilities, data.totalLiabilities)
        BalanceSection(stringResource(R.string.weldbooks_balance_sheet_equity), stringResource(R.string.weldbooks_balance_sheet_total_equity), data.equity, data.totalEquity)
        SectionCard {
            Row(Modifier.fillMaxWidth()) {
                Text(stringResource(R.string.weldbooks_balance_sheet_liabilities_and_equity), style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                Text(books.money(data.totalLiabilitiesAndEquity), style = MaterialTheme.typography.bodyLarge.merge(Tabular), fontWeight = FontWeight.SemiBold)
            }
        }
        BottomSpace()
    }
}

@Composable
private fun BalanceSection(title: String, totalLabel: String, rows: List<BalanceRow>, total: BigDecimal) {
    if (rows.isEmpty() && total.signum() == 0) return
    val books = LocalBooks.current
    SectionCard(title = title) {
        rows.forEach { row ->
            Row(Modifier.fillMaxWidth().padding(vertical = 5.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(row.name, style = MaterialTheme.typography.bodyMedium)
                    if (row.code.isNotBlank()) Text(row.code, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Text(books.money(row.balance), style = MaterialTheme.typography.bodyMedium.merge(Tabular))
            }
        }
        Hairline(Modifier.padding(vertical = Tokens.Spacing.s))
        Row(Modifier.fillMaxWidth()) {
            Text(totalLabel, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            Text(books.money(total), style = MaterialTheme.typography.bodyLarge.merge(Tabular), fontWeight = FontWeight.SemiBold)
        }
    }
}

// ── VAT returns ──

/** The Dutch BTW returns, by year; only where the company's country files one. */
@Composable
fun VatReturnsScreen(onBack: () -> Unit, open: (String) -> Unit) {
    val books = LocalBooks.current
    if (!books.features.vatReturn) {
        FeatureUnavailable(onBack)
        return
    }
    val thisYear = Days.today().year
    var year by rememberSaveable { mutableStateOf<Int?>(thisYear) }
    val loaded = rememberLoaded { books.repository.vatReturns() }
    RealtimeRefresh(books.env, BooksTopics.vat) { loaded.load() }
    val success = Tones.positive.current()
    BooksScaffold(title = stringResource(R.string.weldbooks_vat_title), onBack = onBack) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            val years = listOf("all" to stringResource(R.string.weldbooks_vat_all_years)) +
                listOf(thisYear, thisYear - 1, thisYear - 2).map { it.toString() to it.toString() }
            // The year chips, as the lists' filters; tags vat-year-all and vat-year-<year>.
            Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.s), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                years.forEach { (key, label) ->
                    val on = (year?.toString() ?: "all") == key
                    FilterChip(
                        selected = on,
                        onClick = { year = key.toIntOrNull() },
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
                        modifier = Modifier.tagged("vat-year-$key"),
                    )
                }
            }
            LoadedContent(loaded, stringResource(R.string.weldbooks_vat_load_error)) { all ->
                val returns = all.filter { year == null || it.year == year }
                LazyColumn(Modifier.fillMaxSize().tagged("vat-returns")) {
                    if (returns.isEmpty()) {
                        item {
                            BooksEmptyState(
                                Icons.AutoMirrored.Outlined.FactCheck,
                                stringResource(R.string.weldbooks_vat_empty_title),
                                year?.let { stringResource(R.string.weldbooks_vat_empty_year, it.toString()) } ?: stringResource(R.string.weldbooks_vat_empty_all),
                            )
                        }
                    } else {
                        item { Hairline() }
                    }
                    items(returns, key = { it.id }) { item ->
                        RecordRow(
                            title = item.period,
                            subtitle = stringResource(R.string.weldbooks_vat_output_input, books.money(item.salesTax), books.money(item.purchaseTax)),
                            amount = books.money(item.netAmount),
                            amountColor = if (item.netAmount.signum() < 0) success else null,
                            badge = { StatusPill(item.status) },
                            tag = "vat-return-row",
                            onClick = { open("vat/${item.id}") },
                        )
                    }
                    item { BottomSpace() }
                }
            }
        }
    }
}

/** One BTW return. Filing is a real submission to the tax office, so it asks first. */
@Composable
fun VatReturnScreen(id: String, onBack: () -> Unit) {
    val books = LocalBooks.current
    if (!books.features.vatReturn) {
        FeatureUnavailable(onBack)
        return
    }
    val notify = LocalNotify.current
    val errors = LocalErrors.current
    val scope = rememberCoroutineScope()
    val loaded = rememberLoaded(id) { books.repository.vatReturn(id) }
    RealtimeRefresh(books.env, BooksTopics.vat) { loaded.load() }
    var confirm by remember { mutableStateOf(false) }
    var filing by remember { mutableStateOf(false) }
    val filed = stringResource(R.string.weldbooks_vat_detail_filed_success)
    val failed = stringResource(R.string.weldbooks_vat_detail_file_failed)
    BooksScaffold(title = loaded.data?.period ?: stringResource(R.string.weldbooks_vat_detail_title), onBack = onBack) { padding ->
        LoadedContent(loaded, stringResource(R.string.weldbooks_vat_detail_load_error), Modifier.padding(padding)) { item ->
            VatReturnBody(item, filing) { confirm = true }
        }
    }
    val item = loaded.data
    if (confirm && item != null) {
        ConfirmDialog(
            stringResource(R.string.weldbooks_vat_detail_file_title),
            stringResource(R.string.weldbooks_vat_detail_file_message),
            stringResource(R.string.weldbooks_vat_detail_file_return),
            onConfirm = {
                confirm = false
                filing = true
                scope.launch {
                    runCatching { books.repository.fileVatReturn(item.id) }
                        .onSuccess {
                            notify(filed)
                            loaded.load()
                        }
                        .onFailure { notify(errors.describe(it, failed)) }
                    filing = false
                }
            },
            onDismiss = { confirm = false },
        )
    }
}

@Composable
private fun VatReturnBody(item: VatReturn, filing: Boolean, onFile: () -> Unit) {
    val books = LocalBooks.current
    val payable = item.netAmount.signum() >= 0
    val boxes = listOf(
        "r1a" to R.string.weldbooks_vat_detail_r1a,
        "r1b" to R.string.weldbooks_vat_detail_r1b,
        "r2a" to R.string.weldbooks_vat_detail_r2a,
        "r3a" to R.string.weldbooks_vat_detail_r3a,
        "r3b" to R.string.weldbooks_vat_detail_r3b,
        "r4a" to R.string.weldbooks_vat_detail_r4a,
        "r4b" to R.string.weldbooks_vat_detail_r4b,
    ).filter { item.boxes.containsKey(it.first) }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).tagged("vat-return")) {
        KpiCard(
            stringResource(if (payable) R.string.weldbooks_vat_detail_to_pay else R.string.weldbooks_vat_detail_to_reclaim),
            books.money(item.netAmount.abs()),
            icon = Icons.AutoMirrored.Outlined.FactCheck,
            tone = if (payable) null else Tones.positive.current(),
            modifier = Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.s),
            tag = "vat-net",
        )
        Row(Modifier.padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.xs)) { StatusPill(item.status) }
        if (item.isFiled) {
            Banner(item.filedAt?.let { stringResource(R.string.weldbooks_vat_detail_filed_on, books.date(it)) } ?: stringResource(R.string.weldbooks_vat_detail_filed), tone = "success")
        }
        SectionCard(title = stringResource(R.string.weldbooks_vat_detail_period)) {
            DetailRow(stringResource(R.string.weldbooks_vat_detail_period), item.period)
            item.periodStart?.let { DetailRow(stringResource(R.string.weldbooks_vat_detail_from), books.date(it)) }
            item.periodEnd?.let { DetailRow(stringResource(R.string.weldbooks_vat_detail_to), books.date(it)) }
        }
        SectionCard(title = stringResource(R.string.weldbooks_vat_detail_summary)) {
            TotalsBlock(
                rows = listOf(
                    stringResource(R.string.weldbooks_vat_detail_output_vat) to books.money(item.salesTax),
                    stringResource(R.string.weldbooks_vat_detail_input_vat) to books.money(item.purchaseTax),
                ),
                total = stringResource(if (payable) R.string.weldbooks_vat_detail_payable else R.string.weldbooks_vat_detail_reclaimable) to books.money(item.netAmount.abs()),
            )
        }
        if (boxes.isNotEmpty()) {
            SectionCard(title = stringResource(R.string.weldbooks_vat_detail_rubrieken)) {
                boxes.forEach { (key, label) -> DetailRow(stringResource(label), books.money(item.boxes[key] ?: BigDecimal.ZERO)) }
            }
        }
        if (item.isFileable) {
            Box(Modifier.padding(Tokens.Spacing.m)) {
                Button(onClick = onFile, enabled = !filing, modifier = Modifier.fillMaxWidth().tagged("file-vat-return")) {
                    Icon(Icons.AutoMirrored.Outlined.Send, contentDescription = null)
                    Text(stringResource(R.string.weldbooks_vat_detail_file_return), modifier = Modifier.padding(start = Tokens.Spacing.s))
                }
            }
        }
        BottomSpace()
    }
}
