package com.weldsuite.weldhr.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.weldsuite.weldhr.Absence
import com.weldsuite.weldhr.Attendance
import com.weldsuite.weldhr.ClockRecord
import com.weldsuite.weldhr.HrAccess
import com.weldsuite.weldhr.HrDays
import com.weldsuite.weldhr.LeaveRequest
import com.weldsuite.weldhr.LeaveRules
import com.weldsuite.weldhr.OpenShift
import com.weldsuite.weldhr.OpenShiftRules
import com.weldsuite.weldhr.R
import com.weldsuite.weldhr.SelfState
import com.weldsuite.weldhr.Shift
import com.weldsuite.weldhr.ShiftMath
import com.weldsuite.weldhr.ShiftRequest
import com.weldsuite.weldhr.Standing
import org.weldsuite.core.WeldDate
import org.weldsuite.ui.Avatar
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged

/**
 * Schedule: a week of what was planned and what was worked. My week has the
 * member's own days (shifts with the hours clocked on them, hours without a
 * shift, shifts asked for, leave and sick days) and the open shifts to sign
 * up for; Team has everyone's shifts per day, for who can read attendance.
 */
@Composable
fun ScheduleScreen() {
    val hr = LocalHr.current
    val repo = hr.repository
    val access = repo.access.state.collectAsStateWithLifecycle().value.data ?: HrAccess.NONE
    val me by repo.me.state.collectAsStateWithLifecycle()
    val accessState by repo.access.state.collectAsStateWithLifecycle()
    val self = SelfState.of(me, accessState)
    val options = buildList {
        if (access.self) add(Segment("mine", stringResource(R.string.weldhr_schedule_mine), "schedule-mine"))
        if (access.attendance) add(Segment("team", stringResource(R.string.weldhr_schedule_team), "schedule-team"))
    }
    var chosen by rememberSaveable { mutableStateOf("mine") }
    val view = if (options.any { it.value == chosen }) chosen else options.firstOrNull()?.value ?: "mine"
    var day by rememberSaveable { mutableStateOf(HrDays.today()) }
    val from = HrDays.startOfWeek(day)
    val to = HrDays.add(from, 6)
    val week = repo.attendance[from to to]
    val teamShifts = repo.teamShifts[from to to]
    val teamHours = repo.teamAttendance[from to to]
    val mine by week.state.collectAsStateWithLifecycle()
    val shifts by teamShifts.state.collectAsStateWithLifecycle()
    val records by teamHours.state.collectAsStateWithLifecycle()
    val openShifts by repo.openShifts.state.collectAsStateWithLifecycle()
    val leave by repo.leave.state.collectAsStateWithLifecycle()
    val absences by repo.absences.state.collectAsStateWithLifecycle()
    LaunchedEffect(view, from, self is SelfState.Ready) {
        if (view == "mine" && self is SelfState.Ready) {
            week.ensure()
            repo.openShifts.ensure()
            repo.leave.ensure()
            repo.absences.ensure()
        }
        if (view == "team") {
            teamShifts.ensure()
            teamHours.ensure()
        }
    }
    var picking by rememberSaveable { mutableStateOf(false) }
    Page(
        title = stringResource(R.string.weldhr_tabs_schedule),
        refreshing = if (view == "mine") mine.loading else shifts.loading || records.loading,
        onRefresh = {
            if (view == "mine") {
                week.refresh()
                repo.openShifts.refresh()
            } else {
                teamShifts.refresh()
                teamHours.refresh()
            }
        },
        header = {
            Segments(options, view) { chosen = it }
            PeriodNav(
                label = stringResource(R.string.weldhr_schedule_week, HrDays.isoWeek(from).toString()),
                sublabel = Fmt.span(from, to),
                onPrevious = { day = HrDays.add(from, -7) },
                onNext = { day = HrDays.add(from, 7) },
                onLabel = { picking = true },
            )
            if (picking) {
                DatePickOnly(day, onPick = {
                    day = it
                    picking = false
                }, onDismiss = { picking = false })
            }
        },
    ) {
        if (view == "mine") {
            if (!gate(self, onRetry = { repo.me.refresh() })) return@Page
            openShiftsSection(openShifts.data.orEmpty(), hr.session.workspace.name)
            query(mine, onRetry = { week.refresh() }) { data ->
                myWeek(data, from, to, leave.data?.requests.orEmpty(), absences.data, hr.session.workspace.name)
            }
        } else {
            query(shifts, onRetry = { teamShifts.refresh() }) { planned ->
                query(records, onRetry = { teamHours.refresh() }) { clocked -> teamWeek(planned, clocked, from, to) }
            }
        }
    }
}

/** The calendar on its own, to jump to another week or day. */
@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
fun DatePickOnly(value: String, onPick: (String) -> Unit, onDismiss: () -> Unit) {
    androidx.compose.material3.DatePickerDialog(
        onDismissRequest = onDismiss,
        confirmButton = {},
    ) {
        val state = androidx.compose.material3.rememberDatePickerState(
            initialSelectedDateMillis = HrDays.parse(value)?.atStartOfDay(java.time.ZoneOffset.UTC)?.toInstant()?.toEpochMilli(),
        )
        LaunchedEffect(state.selectedDateMillis) {
            val picked = state.selectedDateMillis ?: return@LaunchedEffect
            val iso = java.time.Instant.ofEpochMilli(picked).atZone(java.time.ZoneOffset.UTC).toLocalDate().toString()
            if (iso != value) onPick(iso)
        }
        androidx.compose.material3.DatePicker(state = state)
    }
}

/** Open shifts HR posted, soonest first; nothing while there are none. */
private fun LazyListScope.openShiftsSection(all: List<OpenShift>, workspace: String) {
    item("open-shifts") {
        val hr = LocalHr.current
        val now = rememberNow(60_000)
        val shifts = OpenShiftRules.listable(all, now)
        var expanded by rememberSaveable { mutableStateOf(false) }
        if (shifts.isEmpty()) return@item
        SectionHead(stringResource(R.string.weldhr_open_shifts_title), shifts.size.toString())
        (if (expanded) shifts else shifts.take(3)).forEach { shift ->
            val standing = OpenShiftRules.standingOf(shift)
            val place = listOfNotNull(Fmt.day(HrDays.dayOf(shift.startsAt)), shift.workType, shift.companyName ?: workspace).joinToString(" · ")
            val note = if (standing == Standing.DECLINED) shift.myRequest?.reviewNote else null
            HrRow(
                leading = { ShiftBar(shift.workType ?: shift.companyName) },
                title = Fmt.timeRange(shift.startsAt, shift.endsAt),
                subtitle = if (note != null) "$place\n${stringResource(R.string.weldhr_open_shifts_review_note, note)}" else place,
                subtitleLines = 2,
                value = pluralStringResource(R.plurals.weldhr_open_shifts_spots_left, shift.spotsLeft, shift.spotsLeft),
                detail = standingLabel(standing),
                detailColor = standingColor(standing),
                tag = "open-shift-${shift.id}",
                onClick = { hr.open(Routes.openShift(shift.id)) },
            )
        }
        if (shifts.size > 3) {
            Text(
                if (expanded) stringResource(R.string.weldhr_open_shifts_show_less) else stringResource(R.string.weldhr_open_shifts_show_all, shifts.size),
                color = brand(),
                modifier = Modifier.fillMaxWidth().clickable { expanded = !expanded }.padding(Tokens.Spacing.l).tagged("open-shifts-toggle"),
            )
        }
    }
}

@Composable
fun standingLabel(standing: Standing): String = when (standing) {
    Standing.OPEN -> stringResource(R.string.weldhr_open_shifts_sign_up)
    Standing.WAITING -> stringResource(R.string.weldhr_open_shifts_waiting)
    Standing.DECLINED -> stringResource(R.string.weldhr_open_shifts_declined)
    Standing.FULL -> stringResource(R.string.weldhr_open_shifts_full)
}

/** Sign up in the app's colour, waiting amber, declined red, full grey. */
@Composable
fun standingColor(standing: Standing) = when (standing) {
    Standing.OPEN -> brand()
    Standing.WAITING -> Tokens.Status.warning.current()
    Standing.DECLINED -> Tokens.Status.danger.current()
    Standing.FULL -> MaterialTheme.colorScheme.onSurfaceVariant
}

/** One day of My week. */
private data class MyDay(
    val day: String,
    val shifts: List<Shift>,
    val loose: List<ClockRecord>,
    val asked: List<ShiftRequest>,
    val away: List<LeaveRequest>,
    val ill: List<Absence>,
    val planned: Int,
    val records: List<ClockRecord>,
)

/** My week, as a timesheet: each day with its hours and pay (planned, for days to come). */
private fun LazyListScope.myWeek(data: Attendance, from: String, to: String, leave: List<LeaveRequest>, absences: com.weldsuite.weldhr.Absences?, workspace: String) {
    val today = HrDays.today()
    val records = ShiftMath.byClockIn(data.records.filter { it.date in from..to })
    val shifts = data.shifts.filter { HrDays.dayOf(it.startsAt) in from..to }.sortedBy { it.startsAt }
    val asked = data.requests.filter { HrDays.dayOf(it.startsAt) in from..to }.sortedBy { it.startsAt }
    val requests = leave.filter { (it.status == "approved" || it.status == "pending") && it.startDate <= to && it.endDate >= from }
    val sick = listOfNotNull(absences?.current) + absences?.history.orEmpty()
    val sickInWeek = sick.filter { it.startDate <= to && (it.endDate ?: today) >= from }
    item("my-week") {
        val hr = LocalHr.current
        val now = rememberNow(if (records.any(ShiftMath::isOpen)) 1_000 else 30_000)
        val onShift = mutableMapOf<String, MutableList<ClockRecord>>()
        val loose = mutableListOf<ClockRecord>()
        for (record in records) {
            val shift = ShiftMath.shiftOf(record, shifts, now)
            if (shift != null) onShift.getOrPut(shift.id) { mutableListOf() } += record else loose += record
        }
        val days = (0L..6L).map { HrDays.add(from, it) }.map { day ->
            val dayShifts = shifts.filter { HrDays.dayOf(it.startsAt) == day }
            MyDay(
                day = day,
                shifts = dayShifts,
                loose = loose.filter { it.date == day },
                asked = asked.filter { HrDays.dayOf(it.startsAt) == day },
                // Leave over several days skips the weekend, the way it is counted.
                away = requests.filter { it.startDate <= day && it.endDate >= day && (it.startDate == it.endDate || !HrDays.isWeekend(day)) },
                ill = sickInWeek.filter { it.startDate <= day && (it.endDate ?: today) >= day && day <= today },
                planned = dayShifts.sumOf(ShiftMath::plannedMinutes),
                records = records.filter { it.date == day },
            )
        }.filter { it.shifts.size + it.loose.size + it.asked.size + it.away.size + it.ill.size > 0 }
        if (days.isEmpty()) {
            org.weldsuite.ui.EmptyState(stringResource(R.string.weldhr_schedule_no_shifts), stringResource(R.string.weldhr_schedule_no_shifts_description))
            return@item
        }
        val currency = records.firstOrNull { it.currency != null }?.currency ?: ShiftMath.DEFAULT_CURRENCY
        val minutes = { list: List<ClockRecord> -> list.sumOf { ShiftMath.minutesOf(it, now) } }
        val withPay = { list: List<ClockRecord> -> "${duration(minutes(list))} | ${earningsText(ShiftMath.earnings(list, now, currency))}" }
        days.forEach { group ->
            val figure = when {
                group.day <= today -> withPay(group.records)
                group.planned > 0 -> stringResource(R.string.weldhr_schedule_planned, duration(group.planned.toDouble()))
                else -> null
            }
            DayHead(group.day, figure)
            group.shifts.forEach { shift -> MyShiftRow(shift, onShift[shift.id].orEmpty(), now, workspace) }
            group.loose.forEach { record -> LooseRow(record, now, workspace) }
            group.asked.forEach { request ->
                HrRow(
                    leading = { ShiftBar(null) },
                    title = Fmt.timeRange(request.startsAt, request.endsAt),
                    subtitle = shiftRequestStatusLabel(request.status),
                    subtitleColor = statusColor(request.status),
                    value = hm(ShiftMath.minutesBetween(request.startsAt, request.endsAt).toDouble()),
                    detail = request.workType,
                    tag = "shift-request-${request.id}",
                    onClick = { hr.open(Routes.shiftRequest(request.id, HrDays.dayOf(request.startsAt))) },
                )
            }
            group.away.forEach { request ->
                HrRow(
                    leading = { LeaveTypeTile(request.leaveTypeColor) },
                    title = request.leaveTypeName ?: stringResource(R.string.weldhr_absence_leave),
                    subtitle = leaveStatusLabel(request.status),
                    subtitleColor = statusColor(request.status),
                    value = Fmt.span(request.startDate, request.endDate),
                    detail = stringResource(R.string.weldhr_schedule_hours_off, hm(LeaveRules.minutesOff(request, group.planned))),
                    onClick = { hr.open(Routes.leave(request.id)) },
                )
            }
            group.ill.forEach { absence ->
                val ongoing = absence.status == "ongoing"
                HrRow(
                    leading = { SickTile() },
                    title = stringResource(R.string.weldhr_absence_sick),
                    subtitle = stringResource(if (ongoing) R.string.weldhr_absence_ongoing else R.string.weldhr_absence_recovered),
                    subtitleColor = if (ongoing) Tokens.Status.danger.current() else null,
                    value = stringResource(if (group.day == absence.startDate && absence.firstDay == "half") R.string.weldhr_sick_half_day else R.string.weldhr_sick_full_day),
                    onClick = { hr.open(Routes.sickReport(absence.id)) },
                )
            }
        }
        val plannedWeek = shifts.sumOf(ShiftMath::plannedMinutes)
        val workedWeek = duration(minutes(records))
        val total = if (plannedWeek > 0) stringResource(R.string.weldhr_schedule_worked_of_planned, workedWeek, duration(plannedWeek.toDouble())) else workedWeek
        TotalRow("$total · ${earningsText(ShiftMath.earnings(records, now, currency))}")
    }
}

/** The week's total under the days. */
@Composable
fun TotalRow(value: String) {
    Row(Modifier.fillMaxWidth().padding(Tokens.Spacing.l), verticalAlignment = Alignment.CenterVertically) {
        Text(stringResource(R.string.weldhr_common_total), fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
        Text(value, style = MaterialTheme.typography.bodyMedium)
    }
}

/** A shift: the hours planned, and what was clocked on it or that nothing was. */
@Composable
private fun MyShiftRow(shift: Shift, worked: List<ClockRecord>, now: Long, workspace: String) {
    val hr = LocalHr.current
    val open = worked.firstOrNull(ShiftMath::isOpen)
    val started = (WeldDate.parse(shift.startsAt)?.toEpochMilli() ?: 0) <= now
    val openSince = open?.clockIn
    if (openSince != null) {
        HrRow(
            leading = { ShiftBar(shift.companyName ?: workspace) },
            title = Fmt.timeRange(shift.startsAt, shift.endsAt),
            subtitle = stringResource(R.string.weldhr_home_since, Fmt.time(openSince)),
            valueContent = { Running(ShiftMath.timer(now - (WeldDate.parse(openSince)?.toEpochMilli() ?: now))) },
            detail = stringResource(R.string.weldhr_timesheet_clocked_in),
            detailColor = Tokens.Status.success.current(),
            tag = "shift-${shift.id}",
            onClick = { hr.open(Routes.shift(shift.id, HrDays.dayOf(shift.startsAt))) },
        )
    } else if (worked.isNotEmpty()) {
        val late = worked.first().lateMinutes?.takeIf { it > 0 }
        val approved = worked.all { it.approved }
        val range = worked.filter { it.clockIn != null }.let { if (it.isEmpty()) "" else Fmt.timeRange(it.first().clockIn, it.last().clockOut) }
        HrRow(
            leading = { ShiftBar(shift.companyName ?: workspace) },
            title = Fmt.timeRange(shift.startsAt, shift.endsAt),
            subtitle = listOfNotNull(
                stringResource(R.string.weldhr_schedule_worked, range),
                late?.let { stringResource(R.string.weldhr_timesheet_late, it.toString()) },
            ).joinToString(" · "),
            value = hm(worked.sumOf { ShiftMath.minutesOf(it, now) }),
            detail = stringResource(if (approved) R.string.weldhr_timesheet_approved else R.string.weldhr_timesheet_pending_approval),
            detailColor = if (approved) Tokens.Status.success.current() else Tokens.Status.warning.current(),
            tag = "shift-${shift.id}",
            onClick = { hr.open(Routes.shift(shift.id, HrDays.dayOf(shift.startsAt))) },
        )
    } else {
        HrRow(
            leading = { ShiftBar(shift.companyName ?: workspace) },
            title = Fmt.timeRange(shift.startsAt, shift.endsAt),
            subtitle = if (started) stringResource(R.string.weldhr_schedule_not_clocked_in) else listOfNotNull(workspace, shift.companyName ?: shift.notes).joinToString(" | "),
            subtitleColor = if (started) Tokens.Status.warning.current() else null,
            tag = "shift-${shift.id}",
            onClick = { hr.open(Routes.shift(shift.id, HrDays.dayOf(shift.startsAt))) },
        )
    }
}

/** Hours clocked outside any shift. */
@Composable
private fun LooseRow(record: ClockRecord, now: Long, workspace: String) {
    val hr = LocalHr.current
    val since = if (ShiftMath.isOpen(record)) record.clockIn else null
    HrRow(
        leading = { ShiftBar(record.companyName ?: workspace) },
        title = if (record.clockIn != null) Fmt.timeRange(record.clockIn, record.clockOut) else attendanceStatusLabel(record.status),
        subtitle = listOfNotNull(
            if (since != null) stringResource(R.string.weldhr_home_since, Fmt.time(since)) else listOfNotNull(workspace, record.companyName).joinToString(" | "),
            stringResource(R.string.weldhr_schedule_without_shift),
            record.lateMinutes?.takeIf { it > 0 }?.let { stringResource(R.string.weldhr_timesheet_late, it.toString()) },
        ).joinToString(" · "),
        valueContent = if (since != null) ({ Running(ShiftMath.timer(now - (WeldDate.parse(since)?.toEpochMilli() ?: now))) }) else null,
        value = if (since == null) hm(ShiftMath.minutesOf(record, now)) else null,
        detail = stringResource(
            when {
                since != null -> R.string.weldhr_timesheet_clocked_in
                record.approved -> R.string.weldhr_timesheet_approved
                else -> R.string.weldhr_timesheet_pending_approval
            },
        ),
        detailColor = if (since != null || record.approved) Tokens.Status.success.current() else Tokens.Status.warning.current(),
        tag = "record-${record.id}",
        onClick = { hr.open(Routes.shift(record.id, record.date)) },
    )
}

/** Everyone's week: each shift with whether its person clocked in, and hours without a shift. */
private fun LazyListScope.teamWeek(shifts: List<Shift>, records: List<ClockRecord>, from: String, to: String) {
    item("team-week") {
        val week = ShiftMath.byClockIn(records.filter { it.date in from..to })
        val planned = shifts.filter { HrDays.dayOf(it.startsAt) in from..to }
            .sortedWith(compareBy<Shift> { it.startsAt }.thenBy { it.employeeName.orEmpty() })
        val now = rememberNow(if (week.any(ShiftMath::isOpen)) 1_000 else 30_000)
        val onShift = mutableMapOf<String, MutableList<ClockRecord>>()
        val loose = mutableListOf<ClockRecord>()
        for (record in week) {
            val shift = ShiftMath.shiftOf(record, planned.filter { it.employeeId == record.employeeId }, now)
            if (shift != null) onShift.getOrPut(shift.id) { mutableListOf() } += record else loose += record
        }
        val days = (0L..6L).map { HrDays.add(from, it) }
            .map { day -> Triple(day, planned.filter { HrDays.dayOf(it.startsAt) == day }, loose.filter { it.date == day }) }
            .filter { it.second.size + it.third.size > 0 }
        if (days.isEmpty()) {
            org.weldsuite.ui.EmptyState(stringResource(R.string.weldhr_schedule_no_team_shifts))
            return@item
        }
        days.forEach { (day, dayShifts, dayLoose) ->
            DayHead(day, (dayShifts.size + dayLoose.size).toString())
            dayShifts.forEach { shift ->
                val worked = onShift[shift.id].orEmpty()
                val openSince = worked.firstOrNull(ShiftMath::isOpen)?.clockIn
                val started = (WeldDate.parse(shift.startsAt)?.toEpochMilli() ?: 0) <= now
                HrRow(
                    leading = {
                        Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s), verticalAlignment = Alignment.CenterVertically) {
                            ShiftBar(shift.workType ?: shift.companyName)
                            Avatar(shift.employeeName)
                        }
                    },
                    title = shift.employeeName.orEmpty(),
                    subtitle = listOfNotNull(Fmt.timeRange(shift.startsAt, shift.endsAt), shift.workType ?: shift.companyName).joinToString(" • "),
                    valueContent = if (openSince != null) ({ Running(ShiftMath.timer(now - (WeldDate.parse(openSince)?.toEpochMilli() ?: now))) }) else null,
                    value = if (openSince == null && worked.isNotEmpty()) hm(worked.sumOf { ShiftMath.minutesOf(it, now) }) else null,
                    detail = when {
                        openSince != null -> stringResource(R.string.weldhr_timesheet_clocked_in)
                        worked.isNotEmpty() -> worked.filter { it.clockIn != null }.let { if (it.isEmpty()) null else Fmt.timeRange(it.first().clockIn, it.last().clockOut) }
                        started -> stringResource(R.string.weldhr_schedule_not_clocked_in)
                        else -> null
                    },
                    detailColor = when {
                        openSince != null -> Tokens.Status.success.current()
                        worked.isEmpty() && started -> Tokens.Status.warning.current()
                        else -> null
                    },
                    tag = "team-shift-${shift.id}",
                )
            }
            dayLoose.forEach { record ->
                val since = if (ShiftMath.isOpen(record)) record.clockIn else null
                HrRow(
                    leading = { Avatar(record.employeeName) },
                    title = record.employeeName.orEmpty(),
                    subtitle = listOf(
                        if (record.clockIn != null) Fmt.timeRange(record.clockIn, record.clockOut) else attendanceStatusLabel(record.status),
                        stringResource(R.string.weldhr_schedule_without_shift),
                    ).joinToString(" • "),
                    valueContent = if (since != null) ({ Running(ShiftMath.timer(now - (WeldDate.parse(since)?.toEpochMilli() ?: now))) }) else null,
                    value = if (since == null) hm(ShiftMath.minutesOf(record, now)) else null,
                    detail = if (since != null) stringResource(R.string.weldhr_timesheet_clocked_in) else null,
                    detailColor = if (since != null) Tokens.Status.success.current() else null,
                )
            }
        }
        val plannedWeek = planned.sumOf(ShiftMath::plannedMinutes)
        val workedWeek = duration(week.sumOf { ShiftMath.minutesOf(it, now) })
        TotalRow(if (plannedWeek > 0) stringResource(R.string.weldhr_schedule_worked_of_planned, workedWeek, duration(plannedWeek.toDouble())) else workedWeek)
    }
}
