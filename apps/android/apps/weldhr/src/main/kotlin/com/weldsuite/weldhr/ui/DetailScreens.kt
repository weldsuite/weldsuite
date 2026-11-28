package com.weldsuite.weldhr.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.FreeBreakfast
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.filled.Schedule
import org.weldsuite.ui.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.weldsuite.weldhr.ClockRecord
import com.weldsuite.weldhr.HrDays
import com.weldsuite.weldhr.LeaveRules
import com.weldsuite.weldhr.OpenShiftRules
import com.weldsuite.weldhr.R
import com.weldsuite.weldhr.SelfState
import com.weldsuite.weldhr.Shift
import com.weldsuite.weldhr.ShiftMath
import com.weldsuite.weldhr.Standing
import com.weldsuite.weldhr.Swatches
import org.weldsuite.core.WeldDate
import org.weldsuite.ui.EmptyState
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged
import org.weldsuite.core.R as CoreR

/** Runs a write from a detail page: a toast, back on success; the server's message on failure. */
@Composable
private fun rememberAction(): (suspend () -> Unit, String, Boolean, (Boolean) -> Unit) -> Unit {
    val hr = LocalHr.current
    val generic = stringResource(CoreR.string.core_errors_generic)
    return { block, success, goBack, setBusy ->
        setBusy(true)
        hr.launch {
            try {
                block()
                hr.toast(success)
                if (goBack) hr.back()
            } catch (error: Exception) {
                hr.toast(error.message?.takeIf { it.isNotBlank() } ?: generic)
            } finally {
                setBusy(false)
            }
        }
    }
}

/**
 * One of my shifts (or hours clocked without one, by the record's id): when
 * and what for, its breaks, what was clocked on it, and what it pays.
 */
@Composable
fun ShiftScreen(id: String, day: String) {
    val hr = LocalHr.current
    val repo = hr.repository
    val anchor = day.ifEmpty { HrDays.today() }
    val from = HrDays.startOfWeek(anchor)
    val query = repo.attendance[from to HrDays.add(from, 6)]
    val week by query.state.collectAsStateWithLifecycle()
    LaunchedEffect(from) { query.ensure() }
    Page(
        title = if (day.isNotEmpty()) Fmt.longDay(day) else stringResource(R.string.weldhr_shift_details),
        refreshing = week.loading,
        onRefresh = { query.refresh() },
        onBack = hr::back,
    ) {
        query(week, onRetry = { query.refresh() }) { data ->
            item("shift") {
                val running = data.records.any(ShiftMath::isOpen)
                val now = rememberNow(if (running) 1_000 else 30_000)
                val shift = data.shifts.firstOrNull { it.id == id }
                val loose = if (shift == null) data.records.firstOrNull { it.id == id } else null
                if (shift == null && loose == null) {
                    EmptyState(stringResource(R.string.weldhr_shift_not_found))
                    return@item
                }
                val worked = if (shift != null) ShiftMath.byClockIn(data.records.filter { ShiftMath.shiftOf(it, data.shifts, now)?.id == shift.id }) else listOfNotNull(loose)
                ShiftDetail(shift, loose, worked, now, hr.session.workspace.name)
            }
        }
    }
}

@Composable
private fun ShiftDetail(shift: Shift?, loose: ClockRecord?, worked: List<ClockRecord>, now: Long, workspace: String) {
    val company = shift?.companyName ?: loose?.companyName
    val open = worked.firstOrNull(ShiftMath::isOpen)
    val started = shift == null || (WeldDate.parse(shift.startsAt)?.toEpochMilli() ?: 0) <= now
    val workedMinutes = worked.sumOf { ShiftMath.minutesOf(it, now) }
    val (status, tint) = when {
        open != null -> stringResource(R.string.weldhr_timesheet_clocked_in) to Tokens.Status.success.current()
        worked.isNotEmpty() && worked.all { it.approved } -> stringResource(R.string.weldhr_timesheet_approved) to Tokens.Status.success.current()
        worked.isNotEmpty() -> stringResource(R.string.weldhr_timesheet_pending_approval) to Tokens.Status.warning.current()
        started -> stringResource(R.string.weldhr_schedule_not_clocked_in) to Tokens.Status.warning.current()
        else -> stringResource(R.string.weldhr_shift_planned) to MaterialTheme.colorScheme.onSurfaceVariant
    }
    val place = if (shift != null) listOfNotNull(shift.workType, company).joinToString(" · ").ifEmpty { workspace } else stringResource(R.string.weldhr_schedule_without_shift)
    val minutes: @Composable (Double) -> String = { value -> if (value >= 60) hm(value) else stringResource(R.string.weldhr_shift_minutes, value.toLong().toString()) }
    Column {
        Row(Modifier.padding(Tokens.Spacing.l).height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m)) {
            Box(Modifier.width(5.dp).fillMaxHeight().background(Color(Swatches.shift(company ?: workspace).toInt()), RoundedCornerShape(3.dp)))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        if (shift != null) Fmt.timeRange(shift.startsAt, shift.endsAt) else Fmt.timeRange(loose?.clockIn, loose?.clockOut),
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.Bold,
                        modifier = Modifier.weight(1f),
                    )
                    Text(if (shift != null) hm(ShiftMath.plannedMinutes(shift).toDouble()) else hm(workedMinutes), color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Text(place, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                Text(status, color = tint, modifier = Modifier.tagged("shift-status"))
            }
        }
        shift?.notes?.let {
            SectionHead(stringResource(R.string.weldhr_shift_notes))
            Text(it, modifier = Modifier.padding(horizontal = Tokens.Spacing.l))
        }
        // Breaks: the planned one, time clocked out in between, and break minutes recorded.
        val planned = shift?.let(ShiftMath::plannedBreak)
        val gaps = ShiftMath.clockedOutGaps(worked)
        val recorded = worked.filter { (it.breakMinutes ?: 0) > 0 }
        SectionHead(stringResource(R.string.weldhr_shift_breaks))
        if (planned == null && gaps.isEmpty() && recorded.isEmpty()) {
            HrRow(leading = { PlainTile(Icons.Filled.FreeBreakfast) }, title = stringResource(R.string.weldhr_shift_no_break), muted = true)
        } else {
            val unpaid = stringResource(R.string.weldhr_shift_unpaid)
            planned?.let { (start, end) ->
                HrRow(leading = { PlainTile(Icons.Filled.FreeBreakfast) }, title = Fmt.timeRange(start, end), subtitle = stringResource(R.string.weldhr_shift_planned_break), value = minutes(ShiftMath.minutesBetween(start, end).toDouble()), detail = unpaid)
            }
            gaps.forEach { (start, end) ->
                HrRow(leading = { PlainTile(Icons.Filled.FreeBreakfast) }, title = Fmt.timeRange(start, end), subtitle = stringResource(R.string.weldhr_shift_clocked_out), value = minutes(ShiftMath.minutesBetween(start, end).toDouble()), detail = unpaid)
            }
            recorded.forEach { record ->
                HrRow(
                    leading = { PlainTile(Icons.Filled.FreeBreakfast) },
                    title = stringResource(R.string.weldhr_shift_recorded_break),
                    subtitle = if (record.clockIn != null) Fmt.timeRange(record.clockIn, record.clockOut) else null,
                    value = minutes((record.breakMinutes ?: 0).toDouble()),
                    detail = unpaid,
                )
            }
            Note(stringResource(R.string.weldhr_shift_breaks_unpaid))
        }
        if (worked.isNotEmpty() || started) {
            SectionHead(stringResource(R.string.weldhr_shift_worked))
            if (worked.isEmpty()) HrRow(leading = { PlainTile(Icons.Filled.Schedule) }, title = stringResource(R.string.weldhr_schedule_not_clocked_in), muted = true)
            worked.forEach { record ->
                val since = if (ShiftMath.isOpen(record)) record.clockIn else null
                HrRow(
                    leading = { PlainTile(Icons.Filled.Schedule) },
                    title = if (record.clockIn != null) Fmt.timeRange(record.clockIn, record.clockOut) else attendanceStatusLabel(record.status),
                    subtitle = listOfNotNull(
                        sourceLabel(record.source),
                        record.lateMinutes?.takeIf { it > 0 }?.let { stringResource(R.string.weldhr_timesheet_late, it.toString()) },
                    ).joinToString(" · "),
                    value = if (since != null) ShiftMath.timer(now - (WeldDate.parse(since)?.toEpochMilli() ?: now)) else hm(ShiftMath.minutesOf(record, now)),
                    detail = if (since != null) stringResource(R.string.weldhr_timesheet_clocked_in) else attendanceStatusLabel(record.status),
                    detailColor = if (since != null) Tokens.Status.success.current() else statusColor(record.status),
                )
            }
            worked.mapNotNull { it.notes }.forEach { DetailRow(stringResource(R.string.weldhr_shift_notes), it) }
        }
        // Pay: the hourly rate, and what was earned or, before any hours, what the shift will pay.
        val priced = worked.firstOrNull { it.hourlyRate != null }
        val rate = shift?.hourlyRate ?: priced?.hourlyRate
        val currency = shift?.currency ?: priced?.currency ?: ShiftMath.DEFAULT_CURRENCY
        SectionHead(stringResource(R.string.weldhr_shift_pay))
        DetailRow(
            stringResource(R.string.weldhr_shift_hourly_rate),
            if (rate != null) stringResource(R.string.weldhr_shift_per_hour, Fmt.money(rate, currency)) else stringResource(R.string.weldhr_shift_no_rate),
        )
        if (worked.isNotEmpty()) {
            DetailRow(stringResource(R.string.weldhr_shift_paid_hours), hm(workedMinutes))
            DetailRow(stringResource(R.string.weldhr_shift_earned), earningsText(ShiftMath.earnings(worked, now, currency)))
        } else {
            val plannedMinutes = shift?.let(ShiftMath::plannedMinutes) ?: 0
            DetailRow(stringResource(R.string.weldhr_shift_paid_hours), hm(plannedMinutes.toDouble()))
            DetailRow(stringResource(R.string.weldhr_shift_expected), Fmt.money(if (rate != null) plannedMinutes / 60.0 * rate else 0.0, currency))
        }
    }
}

/** A shift I asked to work: when, what for, my note and the answer; withdraw while it waits. */
@Composable
fun ShiftRequestScreen(id: String, day: String) {
    val hr = LocalHr.current
    val from = HrDays.startOfWeek(day.ifEmpty { HrDays.today() })
    val query = hr.repository.attendance[from to HrDays.add(from, 6)]
    val week by query.state.collectAsStateWithLifecycle()
    LaunchedEffect(from) { query.ensure() }
    val act = rememberAction()
    var confirming by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    Page(stringResource(R.string.weldhr_shift_request_details), week.loading, { query.refresh() }, onBack = hr::back) {
        query(week, onRetry = { query.refresh() }) { data ->
            item("request") {
                val request = data.requests.firstOrNull { it.id == id }
                if (request == null) {
                    EmptyState(stringResource(R.string.weldhr_shift_request_not_found))
                    return@item
                }
                val range = Fmt.timeRange(request.startsAt, request.endsAt)
                val dayText = Fmt.longDay(HrDays.dayOf(request.startsAt))
                val hours = hm(ShiftMath.minutesBetween(request.startsAt, request.endsAt).toDouble())
                val reviewed = request.reviewedAt?.let(Fmt::date)
                HrRow(
                    leading = { ShiftBar(null) },
                    title = range,
                    subtitle = shiftRequestStatusLabel(request.status),
                    subtitleColor = statusColor(request.status),
                    value = hours,
                    detail = request.workType,
                )
                SectionHead(stringResource(R.string.weldhr_shift_details))
                facts(
                    stringResource(R.string.weldhr_shift_request_day) to dayText,
                    stringResource(R.string.weldhr_shift_time) to range,
                    stringResource(R.string.weldhr_shift_length) to hours,
                    stringResource(R.string.weldhr_shift_work) to request.workType,
                    stringResource(R.string.weldhr_shift_request_note) to request.note,
                    stringResource(R.string.weldhr_shift_request_requested) to Fmt.date(request.createdAt),
                    stringResource(R.string.weldhr_shift_request_reviewed) to (if (reviewed != null && request.reviewedByName != null) stringResource(R.string.weldhr_shift_request_reviewed_by, reviewed, request.reviewedByName) else reviewed),
                    stringResource(R.string.weldhr_shift_request_review_note) to request.reviewNote,
                )
                if (request.status == "pending") DangerButton(stringResource(R.string.weldhr_shift_request_withdraw), "shift-request-withdraw") { confirming = true }
                if (confirming) {
                    val withdrawn = stringResource(R.string.weldhr_shift_request_withdrawn)
                    Confirm(
                        title = stringResource(R.string.weldhr_shift_request_withdraw_title),
                        message = stringResource(R.string.weldhr_shift_request_withdraw_message, "$dayText $range"),
                        confirm = stringResource(R.string.weldhr_shift_request_withdraw_confirm),
                        dismiss = stringResource(R.string.weldhr_shift_request_keep),
                        busy = busy,
                        tag = "confirm-withdraw",
                        onConfirm = { act({ hr.repository.cancelShiftRequest(request.id) }, withdrawn, true) { busy = it; if (!it) confirming = false } },
                        onDismiss = { confirming = false },
                    )
                }
            }
        }
    }
}

/** The facts of a detail page, the empty ones left out. */
@Composable
fun facts(vararg rows: Pair<String, String?>) {
    rows.forEach { (label, value) -> if (!value.isNullOrBlank()) DetailRow(label, value) }
}

/** An open shift: sign up with a note, see that it waits (and withdraw), or why it is declined or full. */
@Composable
fun OpenShiftScreen(id: String) {
    val hr = LocalHr.current
    val repo = hr.repository
    val shifts by repo.openShifts.state.collectAsStateWithLifecycle()
    LaunchedEffect(Unit) { repo.openShifts.ensure() }
    val act = rememberAction()
    var note by rememberSaveable { mutableStateOf("") }
    var confirming by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    Page(stringResource(R.string.weldhr_open_shifts_details), shifts.loading, { repo.openShifts.refresh() }, onBack = hr::back) {
        query(shifts, onRetry = { repo.openShifts.refresh() }) { list ->
            item("open-shift") {
                val shift = list.firstOrNull { it.id == id }
                if (shift == null) {
                    EmptyState(stringResource(R.string.weldhr_open_shifts_not_found))
                    return@item
                }
                val now = rememberNow(60_000)
                val standing = OpenShiftRules.standingOf(shift)
                val range = Fmt.timeRange(shift.startsAt, shift.endsAt)
                val dayText = Fmt.longDay(HrDays.dayOf(shift.startsAt))
                val hours = hm(ShiftMath.plannedMinutes(shift.startsAt, shift.endsAt, shift.breakStartsAt, shift.breakEndsAt).toDouble())
                val standingText = if (standing == Standing.OPEN) {
                    pluralStringResource(R.plurals.weldhr_open_shifts_spots_left, shift.spotsLeft, shift.spotsLeft)
                } else {
                    standingLabel(standing)
                }
                HrRow(
                    leading = { ShiftBar(shift.workType ?: shift.companyName) },
                    title = range,
                    subtitle = standingText,
                    subtitleColor = standingColor(standing),
                    value = hours,
                    detail = shift.workType,
                )
                val signedUp = stringResource(R.string.weldhr_open_shifts_signed_up)
                if (OpenShiftRules.canSignUp(shift, now)) {
                    Column(Modifier.padding(Tokens.Spacing.l), verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
                        OutlinedTextField(
                            value = note,
                            onValueChange = { note = it.take(1000) },
                            label = { Text(stringResource(R.string.weldhr_open_shifts_note)) },
                            placeholder = { Text(stringResource(R.string.weldhr_open_shifts_note_placeholder)) },
                            minLines = 2,
                            modifier = Modifier.fillMaxWidth().tagged("open-shift-note"),
                        )
                        Note(stringResource(R.string.weldhr_open_shifts_sign_up_hint))
                        Button(
                            onClick = { act({ repo.signUp(shift.id, note.trim().ifEmpty { null }) }, signedUp, true) { busy = it } },
                            enabled = !busy,
                            modifier = Modifier.fillMaxWidth().tagged("open-shift-sign-up"),
                        ) {
                            if (busy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp) else Text(stringResource(R.string.weldhr_open_shifts_submit))
                        }
                    }
                }
                val requestId = shift.myRequest?.id
                if (standing == Standing.WAITING && requestId != null) {
                    Note(stringResource(R.string.weldhr_open_shifts_waiting_hint))
                    DangerButton(stringResource(R.string.weldhr_open_shifts_withdraw), "open-shift-withdraw") { confirming = true }
                }
                if (standing == Standing.DECLINED && !OpenShiftRules.canSignUp(shift, now)) Note(stringResource(R.string.weldhr_open_shifts_declined_hint))
                if (standing == Standing.FULL) Note(stringResource(R.string.weldhr_open_shifts_full_hint))
                SectionHead(stringResource(R.string.weldhr_shift_details))
                facts(
                    stringResource(R.string.weldhr_shift_request_day) to dayText,
                    stringResource(R.string.weldhr_shift_time) to range,
                    stringResource(R.string.weldhr_shift_length) to hours,
                    stringResource(R.string.weldhr_shift_planned_break) to (if (shift.breakStartsAt != null && shift.breakEndsAt != null) Fmt.timeRange(shift.breakStartsAt, shift.breakEndsAt) else null),
                    stringResource(R.string.weldhr_shift_work) to shift.workType,
                    stringResource(R.string.weldhr_open_shifts_client) to shift.companyName,
                    stringResource(R.string.weldhr_open_shifts_department) to shift.departmentName,
                    stringResource(R.string.weldhr_open_shifts_spots) to stringResource(R.string.weldhr_open_shifts_spots_of, shift.spotsLeft.toString(), shift.spots.toString()),
                    stringResource(R.string.weldhr_shift_notes) to shift.notes,
                    stringResource(R.string.weldhr_open_shifts_manager_note) to shift.myRequest?.reviewNote,
                )
                if (confirming && requestId != null) {
                    val withdrawn = stringResource(R.string.weldhr_open_shifts_withdrawn)
                    Confirm(
                        title = stringResource(R.string.weldhr_open_shifts_withdraw_title),
                        message = stringResource(R.string.weldhr_open_shifts_withdraw_message, "$dayText $range"),
                        confirm = stringResource(R.string.weldhr_open_shifts_withdraw_confirm),
                        dismiss = stringResource(R.string.weldhr_open_shifts_keep),
                        busy = busy,
                        tag = "confirm-withdraw",
                        onConfirm = { act({ repo.cancelShiftRequest(requestId) }, withdrawn, true) { busy = it; if (!it) confirming = false } },
                        onDismiss = { confirming = false },
                    )
                }
            }
        }
    }
}

/** One of my leave requests: the period, paid or not, the reason and review, the balance, cancel while allowed. */
@Composable
fun LeaveScreen(id: String) {
    val hr = LocalHr.current
    val repo = hr.repository
    val leave by repo.leave.state.collectAsStateWithLifecycle()
    LaunchedEffect(Unit) { repo.leave.ensure() }
    val act = rememberAction()
    var confirming by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    val title = leave.data?.requests?.firstOrNull { it.id == id }?.leaveTypeName ?: stringResource(R.string.weldhr_absence_leave)
    Page(title, leave.loading, { repo.leave.refresh() }, onBack = hr::back) {
        query(leave, onRetry = { repo.leave.refresh() }) { data ->
            item("leave") {
                val request = data.requests.firstOrNull { it.id == id }
                if (request == null) {
                    EmptyState(stringResource(R.string.weldhr_leave_detail_not_found))
                    return@item
                }
                val today = HrDays.today()
                val type = data.types.firstOrNull { it.id == request.leaveTypeId }
                val paid = data.balances.firstOrNull { it.leaveTypeId == request.leaveTypeId }?.isPaid
                val balance = LeaveRules.balanceForStart(data.balances, request.leaveTypeId, request.startDate, today)
                val reviewed = request.reviewedAt?.let(Fmt::date)
                HrRow(
                    leading = { LeaveTypeTile(request.leaveTypeColor ?: type?.color) },
                    title = request.leaveTypeName ?: type?.name ?: stringResource(R.string.weldhr_absence_leave),
                    subtitle = leaveStatusLabel(request.status),
                    subtitleColor = statusColor(request.status),
                    value = Fmt.span(request.startDate, request.endDate),
                    detail = daysText(request.days),
                    muted = request.status == "cancelled",
                )
                SectionHead(stringResource(R.string.weldhr_absence_leave))
                facts(
                    stringResource(R.string.weldhr_leave_detail_period) to Fmt.dateRange(request.startDate, request.endDate),
                    stringResource(R.string.weldhr_leave_detail_length) to daysText(request.days),
                    stringResource(R.string.weldhr_leave_detail_kind) to paid?.let { stringResource(if (it) R.string.weldhr_leave_detail_paid else R.string.weldhr_leave_detail_unpaid) },
                    stringResource(R.string.weldhr_leave_detail_requested) to request.createdAt?.let(Fmt::date),
                    stringResource(R.string.weldhr_leave_detail_reason) to request.reason,
                    stringResource(R.string.weldhr_leave_detail_reviewed) to (if (reviewed != null && request.reviewedByName != null) stringResource(R.string.weldhr_leave_detail_reviewed_by, reviewed, request.reviewedByName) else reviewed),
                    stringResource(R.string.weldhr_leave_detail_note) to request.reviewNote,
                )
                if (balance != null) {
                    val unlimited = stringResource(R.string.weldhr_balance_unlimited)
                    val days = { value: Double? -> value?.let(Fmt::days) ?: unlimited }
                    SectionHead(stringResource(R.string.weldhr_leave_detail_balance, today.take(4)))
                    DetailRow(stringResource(R.string.weldhr_absence_allowance), days(balance.allowance))
                    DetailRow(stringResource(R.string.weldhr_absence_taken), days(balance.used))
                    DetailRow(stringResource(R.string.weldhr_absence_waiting), days(balance.pending))
                    DetailRow(stringResource(R.string.weldhr_absence_left), days(balance.remaining))
                }
                if (LeaveRules.canCancel(request, today)) DangerButton(stringResource(R.string.weldhr_leave_detail_cancel), "leave-cancel") { confirming = true }
                if (confirming) {
                    val cancelled = stringResource(R.string.weldhr_time_off_cancelled)
                    Confirm(
                        title = stringResource(R.string.weldhr_time_off_cancel_title),
                        message = stringResource(R.string.weldhr_time_off_cancel_message, request.leaveTypeName.orEmpty(), Fmt.dateRange(request.startDate, request.endDate)),
                        confirm = stringResource(R.string.weldhr_time_off_cancel_confirm),
                        dismiss = stringResource(R.string.weldhr_time_off_keep),
                        busy = busy,
                        tag = "confirm-cancel",
                        onConfirm = { act({ repo.cancelLeave(request.id) }, cancelled, true) { busy = it; if (!it) confirming = false } },
                        onDismiss = { confirming = false },
                    )
                }
            }
        }
    }
}

/** One of my sick reports, with "I'm better" while it is open. */
@Composable
fun SickReportScreen(id: String) {
    val hr = LocalHr.current
    val repo = hr.repository
    val absences by repo.absences.state.collectAsStateWithLifecycle()
    LaunchedEffect(Unit) { repo.absences.ensure() }
    Page(stringResource(R.string.weldhr_absence_sick), absences.loading, { repo.absences.refresh() }, onBack = hr::back) {
        query(absences, onRetry = { repo.absences.refresh() }) { data ->
            item("sick") {
                val report = (listOfNotNull(data.current) + data.history).firstOrNull { it.id == id }
                if (report == null) {
                    EmptyState(stringResource(R.string.weldhr_sick_detail_not_found))
                    return@item
                }
                val ongoing = report.status == "ongoing"
                SickRow(report, null)
                SectionHead(stringResource(R.string.weldhr_absence_sick_leave))
                facts(
                    stringResource(R.string.weldhr_sick_detail_first_day) to "${Fmt.longDay(report.startDate)} · ${stringResource(if (report.firstDay == "half") R.string.weldhr_sick_half_day else R.string.weldhr_sick_full_day)}",
                    stringResource(R.string.weldhr_sick_detail_last_day) to (report.endDate?.let(Fmt::longDay) ?: stringResource(R.string.weldhr_sick_detail_still_sick)),
                    stringResource(R.string.weldhr_sick_detail_length) to daysText(report.days),
                    stringResource(R.string.weldhr_sick_detail_reported) to report.createdAt?.let(Fmt::date),
                    stringResource(R.string.weldhr_sick_detail_note) to report.note,
                )
                if (ongoing) {
                    Button(onClick = { hr.open(Routes.SICK) }, modifier = Modifier.fillMaxWidth().padding(Tokens.Spacing.l).tagged("sick-recover")) {
                        Text(stringResource(R.string.weldhr_sick_recover_submit))
                    }
                }
            }
        }
    }
}

/** One of my expense claims: the facts, the receipt to open, and withdrawing it while it waits. */
@Composable
fun ExpenseScreen(id: String) {
    val hr = LocalHr.current
    val repo = hr.repository
    val context = LocalContext.current
    val declarations by repo.declarations.state.collectAsStateWithLifecycle()
    LaunchedEffect(Unit) { repo.declarations.ensure() }
    val act = rememberAction()
    var confirming by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var opening by remember { mutableStateOf(false) }
    val failed = stringResource(R.string.weldhr_expenses_receipt_failed)
    val title = declarations.data?.declarations?.firstOrNull { it.id == id }?.description ?: stringResource(R.string.weldhr_expense_detail_title)
    Page(title, declarations.loading, { repo.declarations.refresh() }, onBack = hr::back) {
        query(declarations, onRetry = { repo.declarations.refresh() }) { data ->
            item("expense") {
                val declaration = data.declarations.firstOrNull { it.id == id }
                if (declaration == null) {
                    EmptyState(stringResource(R.string.weldhr_expense_detail_not_found))
                    return@item
                }
                val amount = Fmt.money(declaration.amount, declaration.currency)
                DeclarationRow(declaration, null)
                SectionHead(stringResource(R.string.weldhr_expense_detail_title))
                facts(
                    stringResource(R.string.weldhr_expense_form_amount) to amount,
                    stringResource(R.string.weldhr_expense_form_category) to categoryLabel(declaration.category),
                    stringResource(R.string.weldhr_expense_form_date) to Fmt.date(declaration.expenseDate),
                    stringResource(R.string.weldhr_expense_detail_submitted) to declaration.createdAt?.let(Fmt::date),
                    stringResource(R.string.weldhr_expense_detail_reviewed) to declaration.reviewedAt?.let(Fmt::date),
                    stringResource(R.string.weldhr_expense_detail_paid) to declaration.paidAt?.let(Fmt::date),
                    stringResource(R.string.weldhr_expense_detail_note) to declaration.reviewNote,
                )
                SectionHead(stringResource(R.string.weldhr_expense_form_receipt))
                if (declaration.hasReceipt) {
                    HrRow(
                        leading = { PlainTile(Icons.Filled.AttachFile) },
                        title = stringResource(R.string.weldhr_expenses_view_receipt),
                        subtitle = declaration.receiptFileName,
                        valueContent = if (opening) ({ CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp) }) else null,
                        tag = "expense-receipt",
                        onClick = if (opening) null else ({
                            opening = true
                            hr.launch {
                                val name = declaration.receiptFileName ?: "receipt-${declaration.expenseDate}.jpg"
                                val ok = try {
                                    val file = repo.download("api/weldhr/me/declarations/${declaration.id}/receipt", name, context.cacheDir)
                                    HrFiles.open(context, file, HrFiles.mimeTypeFor(name))
                                } catch (error: Exception) {
                                    false
                                }
                                opening = false
                                if (!ok) hr.toast(failed)
                            }
                        }),
                    )
                } else {
                    HrRow(leading = { PlainTile(Icons.Filled.AttachFile) }, title = stringResource(R.string.weldhr_expenses_no_receipt), muted = true)
                }
                if (declaration.status == "pending") DangerButton(stringResource(R.string.weldhr_expenses_cancel_confirm), "expense-cancel") { confirming = true }
                if (confirming) {
                    val cancelled = stringResource(R.string.weldhr_expenses_cancelled)
                    Confirm(
                        title = stringResource(R.string.weldhr_expenses_cancel_title),
                        message = "${declaration.description} · $amount",
                        confirm = stringResource(R.string.weldhr_expenses_cancel_confirm),
                        dismiss = stringResource(R.string.weldhr_expenses_keep),
                        busy = busy,
                        tag = "confirm-cancel",
                        onConfirm = { act({ repo.cancelDeclaration(declaration.id) }, cancelled, true) { busy = it; if (!it) confirming = false } },
                        onDismiss = { confirming = false },
                    )
                }
            }
        }
    }
}

/** One announcement, its text with its line breaks; opening an unread one marks it read. */
@Composable
fun AnnouncementScreen(id: String) {
    val hr = LocalHr.current
    val repo = hr.repository
    val announcements by repo.announcements.state.collectAsStateWithLifecycle()
    LaunchedEffect(Unit) { repo.announcements.ensure() }
    val announcement = announcements.data?.announcements?.firstOrNull { it.id == id }
    // Once per opening; a failed call is tried again the next time it is opened.
    var marked by remember { mutableStateOf(false) }
    LaunchedEffect(announcement?.id, announcement?.readAt) {
        if (announcement != null && announcement.readAt == null && !marked) {
            marked = true
            runCatching { repo.markRead(announcement.id) }
        }
    }
    Page(stringResource(R.string.weldhr_announcements_details), announcements.loading, { repo.announcements.refresh() }, onBack = hr::back) {
        query(announcements, onRetry = { repo.announcements.refresh() }) { data ->
            item("announcement") {
                val item = data.announcements.firstOrNull { it.id == id }
                if (item == null) {
                    EmptyState(stringResource(R.string.weldhr_announcements_not_found))
                    return@item
                }
                Column(Modifier.padding(Tokens.Spacing.l), verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
                    if (item.pinned) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            Icon(Icons.Filled.PushPin, contentDescription = null, modifier = Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                            Text(stringResource(R.string.weldhr_announcements_pinned), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                    Text(item.title, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold, modifier = Modifier.tagged("announcement-title"))
                    Text(
                        listOfNotNull(
                            item.createdByName?.let { stringResource(R.string.weldhr_announcements_by, it) },
                            "${Fmt.date(item.publishedAt)}, ${Fmt.time(item.publishedAt)}",
                        ).joinToString(" · "),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    SelectionContainer { Text(item.body, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(top = Tokens.Spacing.s)) }
                }
            }
        }
    }
}
