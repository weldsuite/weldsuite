package com.weldsuite.weldhr.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.CheckBox
import androidx.compose.material.icons.filled.CheckBoxOutlineBlank
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Checklist
import androidx.compose.material.icons.filled.Contacts
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.EmojiEvents
import androidx.compose.material.icons.filled.Forum
import androidx.compose.material.icons.filled.MonitorHeart
import androidx.compose.material.icons.filled.PersonSearch
import androidx.compose.material.icons.filled.RadioButtonUnchecked
import androidx.compose.material.icons.filled.StarOutline
import org.weldsuite.ui.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import org.weldsuite.ui.ModalBottomSheet
import org.weldsuite.ui.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import org.weldsuite.ui.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.weldsuite.weldhr.AnnualStatement
import com.weldsuite.weldhr.CoachingLog
import com.weldsuite.weldhr.Evaluation
import com.weldsuite.weldhr.HrAccess
import com.weldsuite.weldhr.HrDays
import com.weldsuite.weldhr.HrTask
import com.weldsuite.weldhr.LeaveBalance
import com.weldsuite.weldhr.Payslip
import com.weldsuite.weldhr.R
import com.weldsuite.weldhr.SelfState
import com.weldsuite.weldhr.Tone
import com.weldsuite.weldhr.groupTasks
import kotlinx.coroutines.delay
import org.weldsuite.ui.Avatar
import androidx.compose.ui.graphics.Color
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.WorkspacePicker
import org.weldsuite.ui.commonSettingsItems
import org.weldsuite.ui.tagged
import org.weldsuite.core.R as CoreR

/**
 * Profile and settings, opened from the workspace at the top of Home: the
 * member's details and balances, what is not one of the tabs (payslips, sick
 * leave, tasks, reviews, the directory), then the settings every app shares.
 */
@Composable
fun ProfileScreen() {
    val hr = LocalHr.current
    val repo = hr.repository
    val accessState by repo.access.state.collectAsStateWithLifecycle()
    val access = accessState.data ?: HrAccess.NONE
    val me by repo.me.state.collectAsStateWithLifecycle()
    val self = SelfState.of(me, accessState)
    val overview by repo.overview.state.collectAsStateWithLifecycle()
    val leave by repo.leave.state.collectAsStateWithLifecycle()
    val payslips by repo.payslips.state.collectAsStateWithLifecycle()
    var switching by remember { mutableStateOf(false) }
    var balance by remember { mutableStateOf<LeaveBalance?>(null) }
    LaunchedEffect(self is SelfState.Ready) {
        if (self is SelfState.Ready) {
            repo.overview.ensure()
            repo.leave.ensure()
            repo.payslips.ensure()
        }
    }
    if (switching) {
        WorkspacePicker(hr.session.workspaces, onChoose = {
            hr.env.chooseWorkspace(it)
            switching = false
        })
        return
    }
    val appName = stringResource(R.string.weldhr_app_name)
    Page(
        title = stringResource(R.string.weldhr_me_title),
        refreshing = me.loading,
        onRefresh = {
            repo.me.refresh()
            repo.access.refresh()
            repo.invalidate()
        },
        onBack = hr::back,
    ) {
        if (access.self) {
            if (gate(self, onRetry = { repo.me.refresh() })) {
                val ready = self as SelfState.Ready
                val profile = ready.profile
                item("profile") {
                    // The platform's record header: avatar and name, the job title, the employee status badge.
                    HrRow(
                        leading = { Avatar(profile.displayName, profile.avatarUrl, size = 40.dp) },
                        title = profile.displayName,
                        subtitle = profile.jobTitle,
                        badge = { StatusTag(profile.status, employeeStatusLabel(profile.status)) },
                        divider = false,
                    )
                    // Its Details rows, in the platform's order.
                    facts(
                        stringResource(R.string.weldhr_me_email) to profile.email,
                        stringResource(R.string.weldhr_me_phone) to profile.phone,
                        stringResource(R.string.weldhr_me_department) to profile.departmentName,
                        stringResource(R.string.weldhr_me_manager) to profile.managerName,
                        stringResource(R.string.weldhr_me_employee_number_label) to profile.employeeNumber,
                        stringResource(R.string.weldhr_me_start_date) to profile.startDate?.let(Fmt::date),
                        stringResource(R.string.weldhr_me_location) to profile.location,
                    )
                }
                val balances = leave.data?.balances.orEmpty()
                if (balances.isNotEmpty()) {
                    item("balances-head") { SectionHead(stringResource(R.string.weldhr_absence_balances), count = balances.size) }
                    items(balances, key = { "balance-${it.leaveTypeId}" }) { BalanceRow(it) { balance = it } }
                }
                item("links") {
                    SectionHead(stringResource(R.string.weldhr_me_my_hr))
                    if (payslips.data != null) {
                        LinkRow(Icons.Filled.Description, stringResource(R.string.weldhr_pay_payslips), 0, "profile-pay") { hr.open(Routes.PAY) }
                    }
                    LinkRow(Icons.Filled.MonitorHeart, stringResource(R.string.weldhr_me_sick_leave), 0, "profile-sick") { hr.open(Routes.SICK) }
                    LinkRow(Icons.Filled.CheckBox, stringResource(R.string.weldhr_me_tasks), overview.data?.openTasks ?: 0, "profile-tasks") { hr.open(Routes.TASKS) }
                    LinkRow(Icons.Filled.EmojiEvents, stringResource(R.string.weldhr_me_reviews), overview.data?.toAcknowledge ?: 0, "profile-reviews") { hr.open(Routes.REVIEWS) }
                }
            }
        }
        if (access.directory) {
            item("team") {
                SectionHead(stringResource(R.string.weldhr_me_team))
                LinkRow(Icons.Filled.Contacts, stringResource(R.string.weldhr_directory_title), 0, "profile-directory") { hr.open(Routes.DIRECTORY) }
            }
        }
        commonSettingsItems(
            env = hr.env,
            appName = appName,
            person = hr.session.person,
            workspace = hr.session.workspace,
            workspaces = hr.session.workspaces,
            appearance = hr.appearance,
            onSwitchWorkspace = { switching = true },
        )
    }
    balance?.let { BalanceSheet(it) { balance = null } }
}

/** A link to a page that is not a tab, as the platform's sidebar items: a muted icon, the label, its count in a chip. */
@Composable
private fun LinkRow(icon: androidx.compose.ui.graphics.vector.ImageVector, title: String, count: Int, tag: String, onClick: () -> Unit) {
    HrRow(
        leading = { Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(18.dp)) },
        title = title,
        valueContent = {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
                if (count > 0) CountChip(count)
                Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        },
        tag = tag,
        onClick = onClick,
    )
}

/** A balance in figures: allowance, taken, waiting, left. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun BalanceSheet(balance: LeaveBalance, onDismiss: () -> Unit) {
    val unlimited = stringResource(R.string.weldhr_balance_unlimited)
    val days = { value: Double? -> value?.let(Fmt::days) ?: unlimited }
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.padding(bottom = Tokens.Spacing.xl)) {
            Text(balance.name, style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(horizontal = Tokens.Spacing.l))
            DetailRow(stringResource(R.string.weldhr_absence_allowance), days(balance.allowance))
            DetailRow(stringResource(R.string.weldhr_absence_taken), days(balance.used))
            DetailRow(stringResource(R.string.weldhr_absence_waiting), days(balance.pending))
            DetailRow(stringResource(R.string.weldhr_absence_left), days(balance.remaining))
            if (balance.prorated) Note(stringResource(R.string.weldhr_balance_prorated))
        }
    }
}

/**
 * Payslips and annual statements. Opening one downloads the PDF with the
 * member's session; the server marks the payslip viewed, so "New" goes.
 */
@Composable
fun PayScreen() {
    val hr = LocalHr.current
    val repo = hr.repository
    val context = LocalContext.current
    val payslips by repo.payslips.state.collectAsStateWithLifecycle()
    val statements by repo.statements.state.collectAsStateWithLifecycle()
    LaunchedEffect(Unit) { repo.payslips.ensure() }
    LaunchedEffect(payslips.data != null) { if (payslips.data != null) repo.statements.ensure() }
    var opening by remember { mutableStateOf<String?>(null) }
    val failed = stringResource(R.string.weldhr_pay_open_failed)
    fun open(key: String, path: String, fileName: String) {
        opening = key
        hr.launch {
            val ok = try {
                HrFiles.open(context, repo.download(path, fileName, context.cacheDir), "application/pdf")
            } catch (_: Exception) {
                false
            }
            opening = null
            if (ok) repo.payslips.refresh() else hr.toast(failed)
        }
    }
    fun openPayslip(slip: Payslip) = open(slip.id, "api/weldhr/me/payslips/${slip.id}/pdf", "payslip-${slip.number ?: slip.periodEnd}.pdf")
    fun openStatement(statement: AnnualStatement) = open(
        "${statement.year}-${statement.employerId}",
        "api/weldhr/me/annual-statements/${statement.year}?employerId=${Uri.encode(statement.employerId)}",
        "${statement.kind}-${statement.year}.pdf",
    )
    Page(stringResource(R.string.weldhr_pay_payslips), payslips.loading, {
        repo.payslips.refresh()
        repo.statements.refresh()
    }, onBack = hr::back) {
        val data = payslips.data
        if (data == null && payslips.error == null && (payslips.loading || !repo.payslips.used)) {
            loading()
            return@Page
        }
        if (payslips.error != null && data == null) {
            failed(payslips.error, { repo.payslips.refresh() })
            return@Page
        }
        if (data == null) {
            // The server's 404: payroll is off for this workspace.
            item("off") { HrEmpty(stringResource(R.string.weldhr_pay_not_enabled), icon = Icons.Filled.Description) }
            return@Page
        }
        val latest = data.firstOrNull()
        if (latest == null) {
            item("none") { HrEmpty(stringResource(R.string.weldhr_pay_no_payslips), stringResource(R.string.weldhr_pay_no_payslips_description), Icons.Filled.Description) }
        } else {
            item("latest") { LatestPayslip(latest, opening == latest.id) { openPayslip(latest) } }
        }
        val older = data.drop(1)
        if (older.isNotEmpty()) {
            item("earlier") { SectionHead(stringResource(R.string.weldhr_pay_earlier), count = older.size) }
            items(older, key = { it.id }) { slip ->
                // As the platform's payslip rows: medium while unopened, with an outlined "New".
                HrRow(
                    title = Fmt.dateRange(slip.periodStart, slip.periodEnd),
                    subtitle = stringResource(R.string.weldhr_pay_paid_on, Fmt.date(slip.payDate)),
                    valueContent = { Text(Fmt.money(slip.netPay, slip.currency), style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium) },
                    badge = if (slip.viewedAt == null) ({ ToneBadge(stringResource(R.string.weldhr_pay_new), Tone.OUTLINE) }) else null,
                    unread = slip.viewedAt == null,
                    tag = "payslip-${slip.id}",
                    onClick = if (opening == slip.id) null else ({ openPayslip(slip) }),
                )
            }
        }
        val list = statements.data.orEmpty()
        if (list.isNotEmpty()) {
            item("statements") { SectionHead(stringResource(R.string.weldhr_pay_annual_statements), count = list.size) }
            items(list, key = { "${it.year}-${it.employerId}" }) { statement ->
                val key = "${statement.year}-${statement.employerId}"
                HrRow(
                    title = stringResource(if (statement.kind == "w2") R.string.weldhr_pay_w2 else R.string.weldhr_pay_jaaropgaaf, statement.year.toString()),
                    subtitle = statement.employerName,
                    tag = "statement-$key",
                    onClick = if (opening == key) null else ({ openStatement(statement) }),
                )
            }
        }
    }
}

/** The newest payslip, large: what most people come here for. */
@Composable
private fun LatestPayslip(slip: Payslip, busy: Boolean, onClick: () -> Unit) {
    Card(Modifier.fillMaxWidth().padding(Tokens.Spacing.l).clickable(enabled = !busy, onClick = onClick).tagged("payslip-latest")) {
        Column(Modifier.padding(Tokens.Spacing.l), verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.xs)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.weldhr_pay_latest), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
                if (slip.viewedAt == null) ToneBadge(stringResource(R.string.weldhr_pay_new), Tone.OUTLINE)
            }
            Text(Fmt.dateRange(slip.periodStart, slip.periodEnd), style = MaterialTheme.typography.titleMedium)
            Text(stringResource(R.string.weldhr_pay_net_pay), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(Fmt.money(slip.netPay, slip.currency), style = MaterialTheme.typography.headlineMedium)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "${stringResource(R.string.weldhr_pay_paid_on, Fmt.date(slip.payDate))} · ${stringResource(R.string.weldhr_pay_gross, Fmt.money(slip.grossPay, slip.currency))}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.weight(1f),
                    maxLines = 1,
                )
                if (busy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp) else Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null)
            }
        }
    }
}

/** Onboarding and offboarding tasks per checklist, open ones first; ticking one off. */
@Composable
fun TasksScreen() {
    val hr = LocalHr.current
    val repo = hr.repository
    val tasks by repo.tasks.state.collectAsStateWithLifecycle()
    LaunchedEffect(Unit) { repo.tasks.ensure() }
    Page(stringResource(R.string.weldhr_tasks_title), tasks.loading, { repo.tasks.refresh() }, onBack = hr::back) {
        query(tasks, onRetry = { repo.tasks.refresh() }) { list ->
            val groups = groupTasks(list)
            if (groups.isEmpty()) {
                item("empty") { HrEmpty(stringResource(R.string.weldhr_tasks_empty), stringResource(R.string.weldhr_tasks_empty_description), Icons.Filled.Checklist) }
            }
            groups.forEach { (name, group) ->
                item("head-$name") {
                    SectionHead(name, count = group.size, figure = stringResource(R.string.weldhr_tasks_progress, group.count { it.completedAt != null }.toString(), group.size.toString()))
                }
                items(group, key = { it.id }) { TaskRow(it) }
            }
        }
    }
}

/** A task's state, as the platform's pill: to do grey, overdue red, done green. */
@Composable
private fun TaskStatePill(state: String) {
    val dark = isDark()
    val (fill, ink) = when (state) {
        "overdue" -> if (dark) Color(0xFF450A0A) to Color(0xFFF87171) else Color(0xFFFEF2F2) to Color(0xFFDC2626)
        "done" -> if (dark) Color(0xFF022C22) to Color(0xFF34D399) else Color(0xFFECFDF5) to Color(0xFF059669)
        else -> if (dark) Tokens.Palette.secondary.current() to MaterialTheme.colorScheme.onSurfaceVariant else Color(0xFFF3F4F6) to Color(0xFF4B5563)
    }
    val label = when (state) {
        "overdue" -> stringResource(R.string.weldhr_tasks_state_overdue)
        "done" -> stringResource(R.string.weldhr_tasks_state_done)
        else -> stringResource(R.string.weldhr_tasks_state_open)
    }
    Text(
        label,
        style = MaterialTheme.typography.labelMedium,
        color = ink,
        maxLines = 1,
        modifier = Modifier.background(fill, RoundedCornerShape(4.dp)).padding(horizontal = 8.dp, vertical = 2.dp),
    )
}

/**
 * A task, as the platform's: a checkbox, the title (struck through and
 * muted once done), who it is for, and the state pill with the due date.
 */
@Composable
private fun TaskRow(task: HrTask) {
    val hr = LocalHr.current
    var busy by remember { mutableStateOf(false) }
    val done = task.completedAt != null
    val overdue = !done && task.dueDate != null && task.dueDate < HrDays.today()
    val checklistDone = stringResource(R.string.weldhr_tasks_checklist_done)
    val generic = stringResource(CoreR.string.core_errors_generic)
    HrRow(
        leading = {
            when {
                busy -> CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                done -> Icon(Icons.Filled.CheckBox, contentDescription = stringResource(R.string.weldhr_a11y_mark_open), tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(20.dp))
                else -> Icon(
                    Icons.Filled.CheckBoxOutlineBlank,
                    contentDescription = stringResource(R.string.weldhr_a11y_mark_done),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = if (task.canComplete) 1f else 0.4f),
                    modifier = Modifier.size(20.dp),
                )
            }
        },
        title = task.title,
        subtitle = listOfNotNull(
            task.description,
            if (task.canComplete) null else stringResource(R.string.weldhr_tasks_assigned_to, roleLabel(task.assigneeRole)),
        ).joinToString("\n").ifEmpty { null },
        subtitleLines = 3,
        detail = task.dueDate?.let(Fmt::day),
        detailColor = if (overdue) Tokens.Status.danger.current() else null,
        badge = { TaskStatePill(if (done) "done" else if (overdue) "overdue" else "open") },
        muted = done,
        strike = done,
        tag = "task-${task.id}",
        onClick = if (!task.canComplete || busy) null else ({
            busy = true
            hr.launch {
                try {
                    if (hr.repository.completeTask(task.id, !done)) hr.toast(checklistDone)
                } catch (error: Exception) {
                    hr.toast(error.message?.takeIf { it.isNotBlank() } ?: generic)
                } finally {
                    busy = false
                }
            }
        }),
    )
}

/** Coaching notes and evaluations shared with the employee; marking one read, with a comment. */
@Composable
fun ReviewsScreen() {
    val hr = LocalHr.current
    val repo = hr.repository
    val coaching by repo.coaching.state.collectAsStateWithLifecycle()
    val evaluations by repo.evaluations.state.collectAsStateWithLifecycle()
    LaunchedEffect(Unit) {
        repo.coaching.ensure()
        repo.evaluations.ensure()
    }
    var tab by rememberSaveable { mutableStateOf("coaching") }
    var target by remember { mutableStateOf<Pair<Boolean, String>?>(null) }
    val openCoaching = coaching.data.orEmpty().count { it.acknowledgedAt == null }
    val openEvaluations = evaluations.data.orEmpty().count { it.acknowledgedAt == null }
    Page(
        stringResource(R.string.weldhr_reviews_title),
        coaching.loading || evaluations.loading,
        {
            repo.coaching.refresh()
            repo.evaluations.refresh()
        },
        onBack = hr::back,
        header = {
            Segments(
                listOf(
                    Segment("coaching", stringResource(R.string.weldhr_reviews_coaching), "reviews-coaching", openCoaching),
                    Segment("evaluations", stringResource(R.string.weldhr_reviews_evaluations), "reviews-evaluations", openEvaluations),
                ),
                tab,
            ) { tab = it }
        },
    ) {
        if (tab == "coaching") {
            query(coaching, onRetry = { repo.coaching.refresh() }) { logs ->
                if (logs.isEmpty()) item("empty") { HrEmpty(stringResource(R.string.weldhr_reviews_no_coaching), icon = Icons.Filled.Forum) }
                items(logs, key = { it.id }) { CoachingCard(it) { target = true to it.id } }
            }
        } else {
            query(evaluations, onRetry = { repo.evaluations.refresh() }) { rows ->
                if (rows.isEmpty()) item("empty") { HrEmpty(stringResource(R.string.weldhr_reviews_no_evaluations), icon = Icons.Filled.StarOutline) }
                items(rows, key = { it.id }) { EvaluationCard(it) { target = false to it.id } }
            }
        }
    }
    target?.let { (isCoaching, id) -> AcknowledgeSheet(isCoaching, id) { target = null } }
}

@Composable
private fun ReviewCard(content: @Composable () -> Unit) {
    Card(Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.s)) {
        Column(Modifier.padding(Tokens.Spacing.l), verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) { content() }
    }
}

@Composable
private fun Acknowledged(acknowledgedAt: String?, comment: String?, tag: String, onAcknowledge: () -> Unit) {
    if (acknowledgedAt == null) {
        OutlinedButton(onClick = onAcknowledge, modifier = Modifier.fillMaxWidth().tagged(tag)) { Text(stringResource(R.string.weldhr_reviews_acknowledge)) }
        return
    }
    if (!comment.isNullOrBlank()) Text("${stringResource(R.string.weldhr_reviews_your_comment)}: $comment")
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Icon(Icons.Filled.CheckCircle, contentDescription = null, tint = Tokens.Status.success.current(), modifier = Modifier.size(14.dp))
        Text(stringResource(R.string.weldhr_reviews_acknowledged, Fmt.date(acknowledgedAt)), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun CoachingCard(log: CoachingLog, onAcknowledge: () -> Unit) {
    ReviewCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            // The platform shows the category as a secondary badge.
            Box(Modifier.weight(1f)) { ToneBadge(coachingCategoryLabel(log.category), Tone.SECONDARY) }
            Text(Fmt.date(log.sessionDate), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Text(log.topic, style = MaterialTheme.typography.titleMedium)
        log.coachName?.let { Text(stringResource(R.string.weldhr_reviews_by, it), color = MaterialTheme.colorScheme.onSurfaceVariant) }
        log.notes?.let { Text(it) }
        if (log.actionItems.isNotEmpty()) {
            Text(stringResource(R.string.weldhr_reviews_action_items), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
            log.actionItems.forEach { item ->
                Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
                    Icon(
                        if (item.done) Icons.Filled.CheckCircle else Icons.Filled.RadioButtonUnchecked,
                        contentDescription = null,
                        tint = if (item.done) Tokens.Status.success.current() else MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.size(16.dp),
                    )
                    Text(item.text)
                }
            }
        }
        log.followUpDate?.let { Text(stringResource(R.string.weldhr_reviews_follow_up, Fmt.date(it)), color = MaterialTheme.colorScheme.onSurfaceVariant) }
        Acknowledged(log.acknowledgedAt, log.employeeComment, "acknowledge-${log.id}", onAcknowledge)
    }
}

@Composable
private fun EvaluationCard(evaluation: Evaluation, onAcknowledge: () -> Unit) {
    val scores = evaluation.scores.associateBy { it.criterionId }
    ReviewCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(evaluation.formName ?: stringResource(R.string.weldhr_reviews_evaluations), style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
            // The platform's coloured score badge.
            if (evaluation.overallScore != null) ScoreBadge(evaluation.overallScore)
        }
        Text(
            listOfNotNull(
                if (evaluation.periodStart != null && evaluation.periodEnd != null) Fmt.dateRange(evaluation.periodStart, evaluation.periodEnd) else null,
                evaluation.evaluatorName?.let { stringResource(R.string.weldhr_reviews_by, it) },
            ).joinToString(" • "),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        evaluation.criteria.forEach { criterion ->
            val score = scores[criterion.id]?.score
            Row {
                Text(criterion.label, modifier = Modifier.weight(1f))
                Text(if (score != null) "${Fmt.days(score)}/${Fmt.days(criterion.maxScore)}" else stringResource(R.string.weldhr_common_dash))
            }
        }
        evaluation.summary?.let { Text(it) }
        Acknowledged(evaluation.acknowledgedAt, evaluation.employeeComment, "acknowledge-${evaluation.id}", onAcknowledge)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AcknowledgeSheet(coaching: Boolean, id: String, onDismiss: () -> Unit) {
    val hr = LocalHr.current
    var comment by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    val done = stringResource(R.string.weldhr_reviews_done)
    val generic = stringResource(CoreR.string.core_errors_generic)
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.padding(horizontal = Tokens.Spacing.l).padding(bottom = Tokens.Spacing.xl), verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.m)) {
            Text(stringResource(R.string.weldhr_reviews_acknowledge_title), style = MaterialTheme.typography.titleLarge)
            OutlinedTextField(
                value = comment,
                onValueChange = { comment = it.take(5000) },
                placeholder = { Text(stringResource(R.string.weldhr_reviews_comment_placeholder)) },
                minLines = 4,
                modifier = Modifier.fillMaxWidth().tagged("acknowledge-comment"),
            )
            Button(
                onClick = {
                    busy = true
                    hr.launch {
                        try {
                            hr.repository.acknowledge(coaching, id, comment.trim().ifEmpty { null })
                            hr.toast(done)
                            onDismiss()
                        } catch (error: Exception) {
                            hr.toast(error.message?.takeIf { it.isNotBlank() } ?: generic)
                        } finally {
                            busy = false
                        }
                    }
                },
                enabled = !busy,
                modifier = Modifier.fillMaxWidth().tagged("acknowledge-submit"),
            ) { Text(stringResource(R.string.weldhr_reviews_acknowledge)) }
        }
    }
}

/** The employee directory: search by name, role or email (on the server, a moment after typing stops). */
@Composable
fun DirectoryScreen() {
    val hr = LocalHr.current
    val repo = hr.repository
    var search by rememberSaveable { mutableStateOf("") }
    var query by rememberSaveable { mutableStateOf("") }
    LaunchedEffect(search) {
        delay(300)
        query = search.trim()
    }
    val employees = repo.employees[query]
    val state by employees.state.collectAsStateWithLifecycle()
    LaunchedEffect(query) { employees.ensure() }
    Page(stringResource(R.string.weldhr_directory_title), state.loading, { employees.refresh() }, onBack = hr::back, header = {
        SearchField(search, { search = it }, stringResource(R.string.weldhr_directory_search), filtered = false, onFilter = null, tag = "directory")
    }) {
        query(state, onRetry = { employees.refresh() }) { rows ->
            if (rows.isEmpty()) item("empty") { HrEmpty(stringResource(R.string.weldhr_directory_empty), stringResource(R.string.weldhr_directory_empty_description), Icons.Filled.PersonSearch) }
            items(rows, key = { it.id }) { employee ->
                HrRow(
                    leading = { Avatar(employee.displayName, employee.avatarUrl, size = 32.dp) },
                    title = employee.displayName,
                    subtitle = listOfNotNull(employee.jobTitle, employee.departmentName).joinToString(" • ").ifEmpty { employee.email },
                    tag = "employee-${employee.id}",
                    onClick = { hr.open(Routes.employee(employee.id)) },
                )
            }
        }
    }
}

/** A colleague's card: who they are and how to reach them. Read-only, the public fields only. */
@Composable
fun EmployeeScreen(id: String) {
    val hr = LocalHr.current
    val context = LocalContext.current
    val employee = hr.repository.employee[id]
    val state by employee.state.collectAsStateWithLifecycle()
    LaunchedEffect(id) { employee.ensure() }
    Page(state.data?.displayName.orEmpty(), state.loading, { employee.refresh() }, onBack = hr::back) {
        query(state, onRetry = { employee.refresh() }) { data ->
            item("card") {
                Column(Modifier.fillMaxWidth().padding(Tokens.Spacing.l), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Avatar(data.displayName, data.avatarUrl, size = 72.dp)
                    data.jobTitle?.let { Text(it, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium, textAlign = TextAlign.Center) }
                    data.pronouns?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    // The employee status badge, as the platform's Employees list.
                    StatusTag(data.status, employeeStatusLabel(data.status))
                }
                Row(Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l), horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s, Alignment.CenterHorizontally)) {
                    data.phone?.let { phone ->
                        OutlinedButton(onClick = {
                            context.startActivity(Intent(Intent.ACTION_DIAL, Uri.parse("tel:${phone.filter { it.isDigit() || it == '+' }}")))
                        }, modifier = Modifier.tagged("employee-call")) {
                            Icon(Icons.Filled.Call, contentDescription = null, modifier = Modifier.size(16.dp))
                            Text(stringResource(R.string.weldhr_directory_call), modifier = Modifier.padding(start = Tokens.Spacing.s))
                        }
                    }
                    OutlinedButton(onClick = {
                        runCatching { context.startActivity(Intent(Intent.ACTION_SENDTO, Uri.parse("mailto:${data.email}"))) }
                    }, modifier = Modifier.tagged("employee-email")) {
                        Icon(Icons.Filled.Email, contentDescription = null, modifier = Modifier.size(16.dp))
                        Text(stringResource(R.string.weldhr_directory_email), modifier = Modifier.padding(start = Tokens.Spacing.s))
                    }
                }
                VSpace(Tokens.Spacing.m)
                facts(
                    stringResource(R.string.weldhr_directory_department) to data.departmentName,
                    stringResource(R.string.weldhr_directory_manager) to data.managerName,
                    stringResource(R.string.weldhr_directory_location) to data.location,
                    stringResource(R.string.weldhr_directory_start_date) to data.startDate?.let(Fmt::date),
                    stringResource(R.string.weldhr_directory_email_address) to data.email,
                )
                if (data.directReports.isNotEmpty()) {
                    SectionHead(stringResource(R.string.weldhr_directory_reports), count = data.directReports.size)
                    data.directReports.forEach { report ->
                        HrRow(
                            leading = { Avatar(report.displayName, report.avatarUrl, size = 32.dp) },
                            title = report.displayName,
                            subtitle = report.jobTitle,
                            onClick = { hr.open(Routes.employee(report.id)) },
                        )
                    }
                }
            }
        }
    }
}

