package com.weldsuite.weldhr.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material.icons.filled.MonitorHeart
import androidx.compose.material.icons.filled.Search as SearchIcon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.weldsuite.weldhr.Absence
import com.weldsuite.weldhr.HrAccess
import com.weldsuite.weldhr.HrDays
import com.weldsuite.weldhr.LeaveRequest
import com.weldsuite.weldhr.R
import com.weldsuite.weldhr.Search
import com.weldsuite.weldhr.SelfState
import org.weldsuite.ui.Avatar

/**
 * Absence: the member's requests and sick reports per year; for who may, who
 * is off on a given day, and the leave requests waiting for their approval.
 */
@Composable
fun AbsenceScreen() {
    val hr = LocalHr.current
    val repo = hr.repository
    val accessState by repo.access.state.collectAsStateWithLifecycle()
    val access = accessState.data ?: HrAccess.NONE
    val me by repo.me.state.collectAsStateWithLifecycle()
    val self = SelfState.of(me, accessState)
    val pending by repo.pendingLeave.state.collectAsStateWithLifecycle()
    val options = buildList {
        if (access.self) add(Segment("mine", stringResource(R.string.weldhr_absence_mine), "absence-mine"))
        if (access.leave || access.sickToday) add(Segment("absences", stringResource(R.string.weldhr_absence_absences), "absence-team"))
        if (access.approveLeave) {
            add(Segment("requests", stringResource(R.string.weldhr_absence_requests), "absence-requests", pending.data?.size ?: 0))
        }
    }
    var chosen by rememberSaveable { mutableStateOf("mine") }
    val view = if (options.any { it.value == chosen }) chosen else options.firstOrNull()?.value ?: "mine"
    val thisYear = HrDays.today().take(4).toInt()
    var year by rememberSaveable { mutableIntStateOf(thisYear) }
    var day by rememberSaveable { mutableStateOf(HrDays.today()) }
    var picking by rememberSaveable { mutableStateOf(false) }
    val leave by repo.leave.state.collectAsStateWithLifecycle()
    val absences by repo.absences.state.collectAsStateWithLifecycle()
    val teamLeaveQuery = repo.teamLeave[day to day]
    val teamLeave by teamLeaveQuery.state.collectAsStateWithLifecycle()
    val sick by repo.sickReports.state.collectAsStateWithLifecycle()
    LaunchedEffect(view, day, self is SelfState.Ready) {
        when (view) {
            "mine" -> if (self is SelfState.Ready) {
                repo.leave.ensure()
                repo.absences.ensure()
            }
            "absences" -> {
                if (access.leave) teamLeaveQuery.ensure()
                if (access.sickToday) repo.sickReports.ensure()
            }
            else -> repo.pendingLeave.ensure()
        }
    }
    Page(
        title = stringResource(R.string.weldhr_tabs_absence),
        refreshing = leave.loading || teamLeave.loading || pending.loading,
        onRefresh = {
            when (view) {
                "mine" -> {
                    repo.leave.refresh()
                    repo.absences.refresh()
                }
                "absences" -> {
                    teamLeaveQuery.refresh()
                    repo.sickReports.refresh()
                }
                else -> repo.pendingLeave.refresh()
            }
        },
        header = {
            Segments(options, view) { chosen = it }
            when (view) {
                "mine" -> PeriodNav(
                    label = year.toString(),
                    onPrevious = { year -= 1 },
                    onNext = if (year <= thisYear) ({ year += 1 }) else null,
                )
                "absences" -> {
                    PeriodNav(
                        label = Fmt.longDay(day),
                        onPrevious = { day = HrDays.add(day, -1) },
                        onNext = { day = HrDays.add(day, 1) },
                        onLabel = { picking = true },
                    )
                    if (picking) {
                        DatePickOnly(day, onPick = {
                            day = it
                            picking = false
                        }, onDismiss = { picking = false })
                    }
                }
            }
        },
    ) {
        when (view) {
            "mine" -> {
                if (!gate(self, onRetry = { repo.me.refresh() })) return@Page
                val ready = self as SelfState.Ready
                query(leave, onRetry = { repo.leave.refresh() }) { data ->
                    myAbsence(year, data.requests, absences.data, ready.features.leaveRequests)
                }
            }
            "absences" -> {
                val loading = (access.leave && teamLeave.data == null && teamLeave.error == null) || (access.sickToday && sick.data == null && sick.error == null)
                if (loading) loading() else offOnDay(day, if (access.leave) teamLeave.data.orEmpty() else emptyList(), if (access.sickToday) sick.data.orEmpty() else emptyList())
            }
            else -> query(pending, onRetry = { repo.pendingLeave.refresh() }) { requests ->
                if (requests.isEmpty()) {
                    item("nothing") {
                        HrEmpty(stringResource(R.string.weldhr_team_nothing_to_approve), stringResource(R.string.weldhr_team_nothing_to_approve_description), Icons.Filled.DateRange)
                    }
                } else {
                    leaveApprovals(requests)
                }
            }
        }
    }
}


/**
 * The member's year, in the platform's groups: leave requests Pending,
 * Approved and Rejected & cancelled, then the sick reports, and the totals.
 */
private fun LazyListScope.myAbsence(year: Int, all: List<LeaveRequest>, absences: com.weldsuite.weldhr.Absences?, canRequest: Boolean) {
    item("my-absence") {
        val hr = LocalHr.current
        val today = HrDays.today()
        val prefix = year.toString()
        val requests = all.filter { it.startDate.startsWith(prefix) || it.endDate.startsWith(prefix) }
        val open = requests.filter { it.status == "pending" }.sortedBy { it.startDate }
        val approved = requests.filter { it.status == "approved" }.sortedByDescending { it.startDate }
        val closed = requests.filter { it.status != "pending" && it.status != "approved" }.sortedByDescending { it.startDate }
        val current = absences?.current
        val reports = (listOfNotNull(current) + absences?.history.orEmpty().filter { it.id != current?.id })
            .filter { it.startDate.startsWith(prefix) || (it.endDate ?: today).startsWith(prefix) }
        val reportSick = today.startsWith(prefix) && current == null
        if (!canRequest) Note(stringResource(R.string.weldhr_time_off_turned_off))
        if (requests.isEmpty() && reports.isEmpty() && !reportSick) {
            HrEmpty(stringResource(R.string.weldhr_absence_no_absence, prefix), icon = Icons.Filled.DateRange)
            return@item
        }
        listOf(
            R.string.weldhr_absence_groups_pending to open,
            R.string.weldhr_absence_groups_approved to approved,
            R.string.weldhr_absence_groups_rejected_cancelled to closed,
        ).forEach { (label, group) ->
            if (group.isNotEmpty()) {
                SectionHead(stringResource(label), count = group.size)
                group.forEach { LeaveRow(it) { hr.open(Routes.leave(it.id)) } }
            }
        }
        if (reports.isNotEmpty() || reportSick) {
            SectionHead(stringResource(R.string.weldhr_absence_sick_leave), count = reports.size.takeIf { it > 0 })
            reports.forEach { SickRow(it) { hr.open(Routes.sickReport(it.id)) } }
            if (reportSick) {
                HrRow(
                    leading = { Icon(Icons.Filled.MonitorHeart, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(18.dp)) },
                    title = stringResource(R.string.weldhr_absence_report_sick),
                    tag = "absence-report-sick",
                    onClick = { hr.open(Routes.SICK) },
                )
            }
        }
        val leaveDays = requests.filter { it.status == "approved" }.sumOf { it.days }
        val sickDays = reports.sumOf { it.days }
        TotalRow(
            listOf(
                stringResource(R.string.weldhr_absence_leave_days, daysText(leaveDays)),
                stringResource(R.string.weldhr_absence_sick_days, daysText(sickDays)),
            ).joinToString(" · "),
        )
    }
}

/** Who is off on [day]: approved leave and sick reports that cover it. */
private fun LazyListScope.offOnDay(day: String, leave: List<LeaveRequest>, sick: List<Absence>) {
    val today = HrDays.today()
    val onLeave = leave.filter { it.startDate <= day && it.endDate >= day }
    val ill = sick.filter { it.startDate <= day && (it.endDate ?: today) >= day && day <= today }
    if (onLeave.isEmpty() && ill.isEmpty()) {
        item("nobody") {
            HrEmpty(stringResource(R.string.weldhr_absence_nobody_absent), stringResource(R.string.weldhr_absence_nobody_absent_description), Icons.Filled.DateRange)
        }
        return
    }
    if (onLeave.isNotEmpty()) {
        item("leave-head") { SectionHead(stringResource(R.string.weldhr_absence_leave), count = onLeave.size) }
        items(onLeave, key = { "leave-${it.id}" }) { request ->
            HrRow(
                leading = { Avatar(request.employeeName, size = 32.dp) },
                title = request.employeeName.orEmpty(),
                subtitleMarker = { ColorDot(request.leaveTypeColor) },
                subtitle = "${request.leaveTypeName ?: stringResource(R.string.weldhr_absence_leave)} · ${Fmt.span(request.startDate, request.endDate)}",
                detail = daysText(request.days),
            )
        }
    }
    if (ill.isNotEmpty()) {
        item("sick-head") { SectionHead(stringResource(R.string.weldhr_absence_sick), count = ill.size) }
        items(ill, key = { "sick-${it.id}" }) { absence ->
            HrRow(
                leading = { Avatar(absence.employeeName, size = 32.dp) },
                title = absence.employeeName.orEmpty(),
                subtitle = if (absence.endDate != null) Fmt.span(absence.startDate, absence.endDate) else "${Fmt.shortDate(absence.startDate)}${Fmt.RANGE}…",
                detail = daysText(absence.days),
                badge = { StatusTag(absence.status, absenceStatusLabel(absence.status)) },
            )
        }
    }
}

/** The requests to approve: a search over who, what type, why and when, and a filter that switches leave types off. */
private fun LazyListScope.leaveApprovals(requests: List<LeaveRequest>) {
    item("leave-approvals") {
        val hr = LocalHr.current
        var search by rememberSaveable { mutableStateOf("") }
        var off by rememberSaveable { mutableStateOf(setOf<String>()) }
        var filtering by rememberSaveable { mutableStateOf(false) }
        val leaveLabel = stringResource(R.string.weldhr_absence_leave)
        val types = requests.associate { it.leaveTypeId to (it.leaveTypeName ?: leaveLabel) }
        val hidden = off.filter { it in types }.toSet()
        val dayTexts = requests.associate { it.id to daysText(it.days) }
        val shown = requests.filter {
            it.leaveTypeId !in hidden &&
                Search.matches(search, listOf(it.employeeName, it.leaveTypeName, it.reason, Fmt.span(it.startDate, it.endDate), dayTexts[it.id]))
        }
        SearchField(search, { search = it }, stringResource(R.string.weldhr_absence_search), hidden.isNotEmpty(), { filtering = true }, "leave-approvals")
        if (shown.isEmpty()) {
            HrEmpty(stringResource(R.string.weldhr_absence_no_results), stringResource(R.string.weldhr_absence_no_results_description), Icons.Filled.SearchIcon)
            ClearButtons(hidden.isNotEmpty(), onClearFilters = { off = emptySet() }, onClearSearch = { search = "" })
        } else {
            SectionHead(stringResource(R.string.weldhr_absence_groups_pending), count = shown.size)
        }
        shown.forEach { request ->
            ApprovalRow(
                id = request.id,
                name = request.employeeName.orEmpty(),
                subtitle = "${request.leaveTypeName ?: leaveLabel} · ${Fmt.span(request.startDate, request.endDate)} · ${dayTexts[request.id].orEmpty()}",
                subtitleMarker = { ColorDot(request.leaveTypeColor) },
                note = request.reason,
                approve = { accept, note -> hr.repository.reviewLeave(request.id, accept, note) },
            )
        }
        if (filtering) {
            FilterSheet(
                options = types.map { it.key to it.value }.sortedBy { it.second },
                off = hidden,
                onApply = { off = it },
                onDismiss = { filtering = false },
            )
        }
    }
}

/** Clear the filters or the search, under "Nothing found". */
@Composable
fun ClearButtons(filtered: Boolean, onClearFilters: () -> Unit, onClearSearch: () -> Unit) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
        if (filtered) TextButton(onClick = onClearFilters) { Text(stringResource(R.string.weldhr_common_clear_filters)) }
        TextButton(onClick = onClearSearch) { Text(stringResource(R.string.weldhr_common_clear_search)) }
    }
}
