package com.weldsuite.weldhr.ui

import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ReceiptLong
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.Campaign
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.filled.Search as SearchIcon
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.weldsuite.weldhr.Age
import com.weldsuite.weldhr.AnnouncementRules
import com.weldsuite.weldhr.Declaration
import com.weldsuite.weldhr.ExpenseFilter
import com.weldsuite.weldhr.HrAccess
import com.weldsuite.weldhr.R
import com.weldsuite.weldhr.Search
import com.weldsuite.weldhr.SelfState
import com.weldsuite.weldhr.Tone

/**
 * Expenses: the member's own claims, and for who approves expenses the ones
 * waiting for them. Each list searches as you type, with a filter on
 * statuses (own claims) or categories (claims to approve).
 */
@Composable
fun ExpensesScreen(startOnApprove: Boolean) {
    val hr = LocalHr.current
    val repo = hr.repository
    val accessState by repo.access.state.collectAsStateWithLifecycle()
    val access = accessState.data ?: HrAccess.NONE
    val me by repo.me.state.collectAsStateWithLifecycle()
    val self = SelfState.of(me, accessState)
    val declarations by repo.declarations.state.collectAsStateWithLifecycle()
    val pending by repo.pendingExpenses.state.collectAsStateWithLifecycle()
    val options = buildList {
        if (access.self) add(Segment("mine", stringResource(R.string.weldhr_expenses_mine), "expenses-mine"))
        if (access.approveExpenses) add(Segment("approve", stringResource(R.string.weldhr_expenses_to_approve), "expenses-approve", pending.data?.size ?: 0))
    }
    var chosen by rememberSaveable { mutableStateOf(if (startOnApprove) "approve" else "mine") }
    val view = if (options.any { it.value == chosen }) chosen else options.firstOrNull()?.value ?: "mine"
    LaunchedEffect(view, self is SelfState.Ready) {
        if (view == "mine" && self is SelfState.Ready) repo.declarations.ensure()
        if (view == "approve") repo.pendingExpenses.ensure()
    }
    Page(
        title = stringResource(R.string.weldhr_expenses_title),
        refreshing = declarations.loading || pending.loading,
        onRefresh = {
            repo.declarations.refresh()
            if (access.approveExpenses) repo.pendingExpenses.refresh()
        },
        header = { Segments(options, view) { chosen = it } },
    ) {
        if (view == "mine") {
            if (!gate(self, onRetry = { repo.me.refresh() })) return@Page
            val ready = self as SelfState.Ready
            query(declarations, onRetry = { repo.declarations.refresh() }) { data ->
                myExpenses(data, ready.features.declarations)
            }
        } else {
            query(pending, onRetry = { repo.pendingExpenses.refresh() }) { rows ->
                if (rows.isEmpty()) {
                    item("nothing") {
                        HrEmpty(stringResource(R.string.weldhr_team_nothing_to_approve), stringResource(R.string.weldhr_team_nothing_to_approve_description), Icons.AutoMirrored.Filled.ReceiptLong)
                    }
                } else {
                    expensesToApprove(rows)
                }
            }
        }
    }
}

private fun LazyListScope.myExpenses(data: com.weldsuite.weldhr.Declarations, canClaim: Boolean) {
    item("my-expenses") {
        val hr = LocalHr.current
        var search by rememberSaveable { mutableStateOf("") }
        var filter by mutableStateOfSaveable()
        var filtering by rememberSaveable { mutableStateOf(false) }
        val rows = data.declarations
        if (!canClaim) Note(stringResource(R.string.weldhr_expenses_turned_off))
        if (rows.isEmpty()) {
            HrEmpty(
                stringResource(R.string.weldhr_expenses_no_expenses),
                stringResource(R.string.weldhr_expenses_no_expenses_description),
                Icons.AutoMirrored.Filled.ReceiptLong,
                action = if (canClaim) stringResource(R.string.weldhr_expenses_new_expense) else null,
                actionTag = "expenses-new",
                onAction = { hr.open(Routes.expenseNew()) },
            )
            return@item
        }
        val labels = rows.associate { it.id to listOf(categoryLabel(it.category), declarationStatusLabel(it.status)) }
        val shown = rows.filter {
            filter.passes(it) && Search.matches(search, listOf(it.description, Fmt.money(it.amount, it.currency), Fmt.day(it.expenseDate)) + labels[it.id].orEmpty())
        }
        SearchField(search, { search = it }, stringResource(R.string.weldhr_expenses_search), filter.isActive, { filtering = true }, "expenses")
        if (shown.isEmpty()) {
            HrEmpty(stringResource(R.string.weldhr_expenses_no_results), stringResource(R.string.weldhr_expenses_no_results_description), Icons.Filled.SearchIcon)
            ClearButtons(filter.isActive, onClearFilters = { filter = ExpenseFilter() }, onClearSearch = { search = "" })
        } else {
            // The platform's groups, with what is still to come per currency on the open ones.
            val pendingTotal = data.open.filter { it.pending > 0 }.joinToString(" · ") { Fmt.money(it.pending, it.currency) }.ifEmpty { null }
            val approvedTotal = data.open.filter { it.approved > 0 }.joinToString(" · ") { Fmt.money(it.approved, it.currency) }.ifEmpty { null }
            val known = setOf("pending", "approved", "paid", "rejected", "cancelled")
            listOf(
                Triple(R.string.weldhr_expenses_awaiting, pendingTotal, shown.filter { it.status == "pending" }),
                Triple(R.string.weldhr_expenses_to_be_paid, approvedTotal, shown.filter { it.status == "approved" }),
                Triple(R.string.weldhr_expenses_groups_paid, null, shown.filter { it.status == "paid" }),
                Triple(R.string.weldhr_expenses_groups_rejected_cancelled, null, shown.filter { it.status == "rejected" || it.status == "cancelled" }),
                Triple(R.string.weldhr_expenses_groups_other, null, shown.filter { it.status !in known }),
            ).forEach { (label, total, group) ->
                if (group.isNotEmpty()) {
                    SectionHead(stringResource(label), count = group.size, figure = total)
                    group.forEach { row -> DeclarationRow(row) { hr.open(Routes.expense(row.id)) } }
                }
            }
        }
        if (filtering) {
            FilterSheet(
                options = ExpenseFilter.statusChoices(rows, filter).map { it to declarationStatusLabel(it) },
                off = filter.statuses,
                onApply = { filter = filter.copy(statuses = it) },
                onDismiss = { filtering = false },
            )
        }
    }
}

@Composable
private fun mutableStateOfSaveable() = rememberSaveable(saver = androidx.compose.runtime.saveable.Saver<androidx.compose.runtime.MutableState<ExpenseFilter>, List<String>>(
    save = { state -> state.value.statuses.map { "s:$it" } + state.value.categories.map { "c:$it" } },
    restore = { saved ->
        mutableStateOf(
            ExpenseFilter(
                statuses = saved.filter { it.startsWith("s:") }.map { it.drop(2) }.toSet(),
                categories = saved.filter { it.startsWith("c:") }.map { it.drop(2) }.toSet(),
            ),
        )
    },
)) { mutableStateOf(ExpenseFilter()) }

/**
 * A claim, as the platform's Declarations list: what it was for, the
 * category and day under it (a paperclip with a receipt), the amount and
 * the status badge on the right.
 */
@Composable
fun DeclarationRow(row: Declaration, onClick: (() -> Unit)?) {
    HrRow(
        title = row.description,
        subtitle = "${categoryLabel(row.category)} · ${Fmt.day(row.expenseDate)}",
        subtitleMarker = if (row.hasReceipt) {
            { Icon(Icons.Filled.AttachFile, contentDescription = null, modifier = Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant) }
        } else {
            null
        },
        valueContent = { Text(Fmt.money(row.amount, row.currency), style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium, maxLines = 1) },
        badge = { StatusTag(row.status, declarationStatusLabel(row.status)) },
        tag = "expense-${row.id}",
        onClick = onClick,
    )
}

/** The claims waiting for this approver, searchable, filterable by category. */
private fun LazyListScope.expensesToApprove(rows: List<Declaration>) {
    item("expenses-to-approve") {
        val hr = LocalHr.current
        var search by rememberSaveable { mutableStateOf("") }
        var filter by mutableStateOfSaveable()
        var filtering by rememberSaveable { mutableStateOf(false) }
        val labels = rows.associate { it.id to categoryLabel(it.category) }
        val shown = rows.filter {
            filter.passes(it) &&
                Search.matches(search, listOf(it.employeeName, it.description, labels[it.id], Fmt.money(it.amount, it.currency), Fmt.day(it.expenseDate)))
        }
        SearchField(search, { search = it }, stringResource(R.string.weldhr_expenses_search), filter.isActive, { filtering = true }, "approvals")
        if (shown.isEmpty()) {
            HrEmpty(stringResource(R.string.weldhr_expenses_no_results), stringResource(R.string.weldhr_expenses_no_results_description), Icons.Filled.SearchIcon)
            ClearButtons(filter.isActive, onClearFilters = { filter = ExpenseFilter() }, onClearSearch = { search = "" })
        } else {
            SectionHead(stringResource(R.string.weldhr_expenses_review_group), count = shown.size)
        }
        shown.forEach { row ->
            ApprovalRow(
                id = row.id,
                name = row.employeeName.orEmpty(),
                subtitle = "${labels[row.id].orEmpty()} · ${Fmt.day(row.expenseDate)}",
                subtitleMarker = if (row.hasReceipt) {
                    { Icon(Icons.Filled.AttachFile, contentDescription = null, modifier = Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant) }
                } else {
                    null
                },
                note = row.description,
                value = Fmt.money(row.amount, row.currency),
                approve = { accept, note -> hr.repository.reviewExpense(row.id, accept, note) },
            )
        }
        if (filtering) {
            FilterSheet(
                options = ExpenseFilter.categoryChoices(rows, filter).map { it to categoryLabel(it) },
                off = filter.categories,
                onApply = { filter = filter.copy(categories = it) },
                onDismiss = { filtering = false },
            )
        }
    }
}

/**
 * Announcements, as the platform's: Pinned and the rest in their own
 * groups, a pin before a pinned title, unread ones in semibold with "New".
 */
@Composable
fun AnnouncementsScreen() {
    val hr = LocalHr.current
    val repo = hr.repository
    val me by repo.me.state.collectAsStateWithLifecycle()
    val access by repo.access.state.collectAsStateWithLifecycle()
    val self = SelfState.of(me, access)
    val announcements by repo.announcements.state.collectAsStateWithLifecycle()
    LaunchedEffect(self is SelfState.Ready) { if (self is SelfState.Ready) repo.announcements.ensure() }
    Page(
        title = stringResource(R.string.weldhr_announcements_title),
        refreshing = announcements.loading,
        onRefresh = { repo.announcements.refresh() },
    ) {
        if (!gate(self, onRetry = { repo.me.refresh() })) return@Page
        query(announcements, onRetry = { repo.announcements.refresh() }) { data ->
            if (data.announcements.isEmpty()) {
                item("empty") {
                    HrEmpty(stringResource(R.string.weldhr_announcements_empty), stringResource(R.string.weldhr_announcements_empty_description), Icons.Filled.Campaign)
                }
            } else {
                val sorted = AnnouncementRules.sort(data.announcements)
                val pinned = sorted.filter { it.pinned }
                val rest = sorted.filter { !it.pinned }
                listOf(
                    Triple("pinned", R.string.weldhr_announcements_pinned, pinned),
                    Triple("other", R.string.weldhr_announcements_title, rest),
                ).forEach { (key, label, group) ->
                    if (group.isEmpty()) return@forEach
                    item("head-$key") { SectionHead(stringResource(label), count = group.size) }
                    items(group, key = { it.id }) { announcement ->
                        val unread = announcement.readAt == null
                        HrRow(
                            marker = if (announcement.pinned) {
                                { Icon(Icons.Filled.PushPin, contentDescription = stringResource(R.string.weldhr_announcements_pinned), modifier = Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant) }
                            } else {
                                null
                            },
                            title = announcement.title,
                            subtitle = AnnouncementRules.preview(announcement.body),
                            subtitleLines = 2,
                            detail = ageLabel(announcement.publishedAt),
                            badge = if (unread) ({ ToneBadge(stringResource(R.string.weldhr_announcements_new), Tone.DEFAULT) }) else null,
                            unread = unread,
                            tag = "announcement-${announcement.id}",
                            onClick = { hr.open(Routes.announcement(announcement.id)) },
                        )
                    }
                }
            }
        }
    }
}

/** "11m", "3h", "Yesterday", "4d", or the date once it is a week old. */
@Composable
fun ageLabel(publishedAt: String): String = when (val age = AnnouncementRules.ageOf(publishedAt)) {
    Age.Now -> stringResource(R.string.weldhr_announcements_just_now)
    is Age.Minutes -> stringResource(R.string.weldhr_announcements_minutes_ago, age.count)
    is Age.Hours -> stringResource(R.string.weldhr_announcements_hours_ago, age.count)
    Age.Yesterday -> stringResource(R.string.weldhr_announcements_yesterday)
    is Age.Days -> stringResource(R.string.weldhr_announcements_days_ago, age.count)
    Age.Date -> Fmt.date(publishedAt)
}
