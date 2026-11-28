package com.weldsuite.weldhr.ui

import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Campaign
import androidx.compose.material.icons.filled.Checklist
import androidx.compose.material.icons.filled.EditCalendar
import androidx.compose.material.icons.filled.Forum
import androidx.compose.material.icons.filled.Place
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
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
import com.weldsuite.weldhr.ClockLocator
import com.weldsuite.weldhr.Features
import com.weldsuite.weldhr.GeoFix
import com.weldsuite.weldhr.HrDays
import com.weldsuite.weldhr.Overview
import com.weldsuite.weldhr.R
import com.weldsuite.weldhr.SelfState
import com.weldsuite.weldhr.Swatches
import com.weldsuite.weldhr.UpcomingShift
import org.weldsuite.core.WeldDate
import org.weldsuite.ui.Avatar
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged
import org.weldsuite.core.R as CoreR

/**
 * Home: the workspace at the top (tap for the profile), the next shift with
 * the clock button right on the page, then My schedule, My absences and
 * what is waiting to be done.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen() {
    val hr = LocalHr.current
    val repo = hr.repository
    val me by repo.me.state.collectAsStateWithLifecycle()
    val access by repo.access.state.collectAsStateWithLifecycle()
    val self = SelfState.of(me, access)
    val overview by repo.overview.state.collectAsStateWithLifecycle()
    val leave by repo.leave.state.collectAsStateWithLifecycle()
    val absences by repo.absences.state.collectAsStateWithLifecycle()
    LaunchedEffect(self is SelfState.Ready) {
        if (self is SelfState.Ready) {
            repo.overview.ensure()
            repo.leave.ensure()
            repo.absences.ensure()
        }
    }
    val workspace = hr.session.workspace.name
    Page(
        title = workspace,
        refreshing = me.loading || overview.loading,
        onRefresh = {
            repo.me.refresh()
            repo.access.refresh()
            if (self is SelfState.Ready) repo.invalidate()
        },
        actions = {},
        header = { WorkspaceHeading(workspace) { hr.open(Routes.PROFILE) } },
    ) {
        if (!gate(self, onRetry = { repo.me.refresh() })) return@Page
        val ready = self as SelfState.Ready
        query(overview, onRetry = { repo.overview.refresh() }) { data ->
            item("hero") { HomeBody(data, ready.features, workspace) }
            item("absences") {
                MyAbsences(
                    canRequest = ready.features.leaveRequests,
                    leave = leave.data?.requests.orEmpty(),
                    current = absences.data?.current,
                )
            }
            item("todo") { ToDo(data) }
        }
    }
}

/** The workspace's logo and name on top of Home; a tap opens the profile and settings. */
@Composable
private fun WorkspaceHeading(name: String, onClick: () -> Unit) {
    val label = stringResource(R.string.weldhr_home_profile_and_settings)
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClickLabel = label, onClick = onClick)
            .padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.s)
            .tagged("home-workspace"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m),
    ) {
        Avatar(name = name, size = 32.dp, tint = brand())
        Text(label, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
        Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun HomeBody(data: Overview, features: Features, workspace: String) {
    val hr = LocalHr.current
    val now = rememberNow(if (data.clockedIn) 1_000 else 30_000)
    val today = HrDays.today()
    val shifts = data.upcomingShifts
        .filter { (WeldDate.parse(it.endsAt)?.toEpochMilli() ?: 0) >= now }
        .sortedBy { it.startsAt }
    val next = shifts.firstOrNull()
    val onShift = data.clockShiftId?.let { id -> data.upcomingShifts.firstOrNull { it.id == id } }
    val switchable = shifts.filter { it.id != data.clockShiftId && HrDays.dayOf(it.startsAt) <= today }
    Column {
        if (features.selfClockIn || next != null || data.clockedIn) {
            ShiftHero(data, next, onShift, switchable, features, workspace, now)
        }
        SectionHead(stringResource(R.string.weldhr_home_my_schedule))
        if (shifts.isEmpty()) {
            HrRow(
                leading = { PlainTile(Icons.Filled.Schedule) },
                title = stringResource(R.string.weldhr_home_no_shifts),
                muted = true,
                onClick = { hr.open(Routes.SCHEDULE) },
            )
        } else {
            shifts.take(3).forEach { shift ->
                ShiftRow(shift.startsAt, shift.endsAt, shift.companyName, workspace, tag = "home-shift-${shift.id}") {
                    hr.open(Routes.shift(shift.id, HrDays.dayOf(shift.startsAt)))
                }
            }
        }
    }
}

/**
 * The next shift with the clock button: its hours on top and where (and
 * which day, when not today) under them; while clocked in, how long, since
 * when, the shift it is on, and Switch shift next to Clock out.
 */
@Composable
private fun ShiftHero(
    data: Overview,
    next: UpcomingShift?,
    onShift: UpcomingShift?,
    switchable: List<UpcomingShift>,
    features: Features,
    workspace: String,
    now: Long,
) {
    val hr = LocalHr.current
    val context = LocalContext.current
    var working by remember { mutableStateOf(false) }
    var switching by remember { mutableStateOf(false) }
    var denied by remember { mutableStateOf(false) }
    var pending by remember { mutableStateOf<Pair<String, String?>?>(null) }
    val requiresLocation = features.clockInRequiresLocation
    val canClock = features.selfClockIn
    val clockedInText = stringResource(R.string.weldhr_home_clocked_in)
    val clockedOutText = stringResource(R.string.weldhr_home_clocked_out)
    val switchedText = stringResource(R.string.weldhr_home_switched)
    val unavailableText = stringResource(R.string.weldhr_location_unavailable)
    val genericError = stringResource(CoreR.string.core_errors_generic)

    /** Clock in, out or to another shift; with the phone's position where the workspace requires it. */
    fun send(action: String, shiftId: String?, fix: GeoFix?) {
        hr.launch {
            try {
                hr.repository.clock(action, shiftId, fix)
                hr.toast(
                    when (action) {
                        "in" -> clockedInText
                        "out" -> clockedOutText
                        else -> switchedText
                    },
                )
                switching = false
            } catch (error: Exception) {
                hr.toast(error.message?.takeIf { it.isNotBlank() } ?: genericError)
            } finally {
                working = false
            }
        }
    }

    fun locateAndSend(action: String, shiftId: String?) {
        hr.launch {
            when (val found = ClockLocator.locate(context)) {
                is ClockLocator.Result.Found -> send(action, shiftId, found.fix)
                ClockLocator.Result.Denied -> {
                    working = false
                    denied = true
                }
                ClockLocator.Result.Unavailable -> {
                    working = false
                    hr.toast(unavailableText)
                }
            }
        }
    }

    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        val request = pending ?: return@rememberLauncherForActivityResult
        pending = null
        if (result.values.any { it }) {
            locateAndSend(request.first, request.second)
        } else {
            working = false
            denied = true
        }
    }

    fun clock(action: String, shiftId: String? = null) {
        working = true
        if (!requiresLocation) {
            send(action, shiftId, null)
        } else if (ClockLocator.hasPermission(context)) {
            locateAndSend(action, shiftId)
        } else {
            pending = action to shiftId
            permission.launch(ClockLocator.PERMISSIONS)
        }
    }

    val sinceMillis = WeldDate.parse(data.since)?.toEpochMilli()
    val running = data.clockedIn && sinceMillis != null
    val shown = if (running) onShift else next
    val title: String
    val lines: List<String>
    if (running && sinceMillis != null) {
        title = com.weldsuite.weldhr.ShiftMath.timer(now - sinceMillis)
        lines = if (onShift != null) shiftLines(onShift, workspace) else listOf(stringResource(R.string.weldhr_home_no_shift_today))
    } else if (next == null) {
        title = stringResource(R.string.weldhr_home_no_shift_today)
        lines = listOf(Fmt.longDay(HrDays.today()))
    } else {
        val (hours, place) = shiftLines(next, workspace).let { it.first() to it.getOrNull(1) }
        val day = HrDays.dayOf(next.startsAt)
        val today = HrDays.today()
        val whenText = when (day) {
            today -> null
            HrDays.add(today, 1) -> stringResource(CoreR.string.core_common_tomorrow)
            else -> Fmt.day(day)
        }
        title = hours
        lines = listOfNotNull(listOfNotNull(whenText, place).joinToString(" · ").ifEmpty { null })
    }
    val barColor = if (shown != null) Color(Swatches.shift(shown.companyName ?: workspace).toInt()) else MaterialTheme.colorScheme.outlineVariant

    Column(Modifier.fillMaxWidth().padding(Tokens.Spacing.l), verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.l)) {
        Row(Modifier.height(androidx.compose.foundation.layout.IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m)) {
            Box(Modifier.width(5.dp).fillMaxHeight().background(barColor, RoundedCornerShape(3.dp)))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f).tagged("home-hero-title"))
                    if (running) {
                        Icon(Icons.Filled.Schedule, contentDescription = null, modifier = Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(
                            stringResource(R.string.weldhr_home_since, Fmt.time(data.since)),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(start = 4.dp),
                        )
                    }
                }
                lines.forEach { Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1) }
            }
        }
        if (canClock || data.clockedIn) {
            Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
                Button(
                    onClick = { clock(if (data.clockedIn) "out" else "in") },
                    enabled = !working,
                    modifier = Modifier.weight(1f).tagged("home-clock"),
                ) {
                    if (working && !switching) {
                        CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                    } else {
                        Text(stringResource(if (data.clockedIn) R.string.weldhr_home_clock_out else R.string.weldhr_home_clock_in))
                    }
                }
                if (data.clockedIn && canClock) {
                    FilledTonalButton(onClick = { switching = true }, enabled = !working, modifier = Modifier.tagged("home-switch-shift")) {
                        Text(stringResource(R.string.weldhr_home_switch_shift))
                    }
                }
            }
            if (requiresLocation) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Icon(Icons.Filled.Place, contentDescription = null, modifier = Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(stringResource(R.string.weldhr_location_required), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }

    if (switching) SwitchShiftSheet(switchable, workspace, working, onPick = { clock("switch", it) }, onDismiss = { switching = false })
    if (denied) {
        Confirm(
            title = stringResource(R.string.weldhr_location_denied_title),
            message = stringResource(R.string.weldhr_location_denied_message),
            confirm = stringResource(R.string.weldhr_location_open_settings),
            dismiss = stringResource(CoreR.string.core_common_close),
            destructive = false,
            onConfirm = {
                denied = false
                context.startActivity(
                    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            },
            onDismiss = { denied = false },
        )
    }
}

/** "09:00 - 17:00" and "Workspace | Client". */
private fun shiftLines(shift: UpcomingShift, workspace: String): List<String> =
    listOf(Fmt.timeRange(shift.startsAt, shift.endsAt), listOfNotNull(workspace, shift.companyName).joinToString(" | ")).filter { it.isNotEmpty() }

/** Today's other shifts; picking one clocks out of this one and in on that one. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SwitchShiftSheet(shifts: List<UpcomingShift>, workspace: String, working: Boolean, onPick: (String) -> Unit, onDismiss: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.padding(bottom = Tokens.Spacing.xl)) {
            Text(stringResource(R.string.weldhr_home_switch_shift), style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(horizontal = Tokens.Spacing.l))
            Text(
                stringResource(R.string.weldhr_home_switch_hint),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(Tokens.Spacing.l),
            )
            if (shifts.isEmpty()) {
                HrRow(leading = { PlainTile(Icons.Filled.Schedule) }, title = stringResource(R.string.weldhr_home_no_other_shifts), muted = true)
            }
            shifts.forEach { shift ->
                ShiftRow(shift.startsAt, shift.endsAt, shift.companyName, workspace, tag = "switch-${shift.id}", onClick = if (working) null else ({ onPick(shift.id) }))
            }
            if (working) CircularProgressIndicator(Modifier.align(Alignment.CenterHorizontally).padding(Tokens.Spacing.m))
        }
    }
}

/** This year's open sick report and the next leave, or a row to add some. */
@Composable
private fun MyAbsences(canRequest: Boolean, leave: List<com.weldsuite.weldhr.LeaveRequest>, current: com.weldsuite.weldhr.Absence?) {
    val hr = LocalHr.current
    val today = HrDays.today()
    val year = today.take(4)
    val upcoming = leave
        .filter { (it.status == "approved" || it.status == "pending") && it.endDate >= today && it.startDate.startsWith(year) }
        .sortedBy { it.startDate }
        .take(3)
    Column {
        SectionHead(stringResource(R.string.weldhr_home_my_absences, year))
        current?.let { SickRow(it) { hr.open(Routes.sickReport(it.id)) } }
        upcoming.forEach { request -> LeaveRow(request) { hr.open(Routes.leave(request.id)) } }
        if (current == null && upcoming.isEmpty()) {
            HrRow(
                leading = { PlainTile(Icons.Filled.EditCalendar) },
                title = stringResource(R.string.weldhr_home_no_absences),
                muted = true,
                value = if (canRequest) stringResource(R.string.weldhr_home_add_absence) else null,
                tag = "home-add-absence",
                onClick = if (canRequest) ({ hr.open(Routes.LEAVE_NEW) }) else null,
            )
        }
    }
}

/** Unread announcements, open shifts, open tasks and reviews to read, when there are any. */
@Composable
private fun ToDo(data: Overview) {
    val hr = LocalHr.current
    if (data.openTasks == 0 && data.toAcknowledge == 0 && data.openShifts == 0 && data.unreadAnnouncements == 0) return
    Column {
        SectionHead(stringResource(R.string.weldhr_home_to_do))
        if (data.unreadAnnouncements > 0) {
            HrRow(
                leading = { PlainTile(Icons.Filled.Campaign) },
                title = stringResource(R.string.weldhr_announcements_title),
                subtitle = pluralStringResource(R.plurals.weldhr_home_unread_announcements, data.unreadAnnouncements, data.unreadAnnouncements),
                tag = "home-announcements",
                onClick = { hr.open(Routes.ANNOUNCEMENTS) },
            )
        }
        if (data.openShifts > 0) {
            HrRow(
                leading = { PlainTile(Icons.Filled.EditCalendar) },
                title = stringResource(R.string.weldhr_open_shifts_title),
                subtitle = pluralStringResource(R.plurals.weldhr_home_open_shifts_to_sign_up, data.openShifts, data.openShifts),
                tag = "home-open-shifts",
                onClick = { hr.open(Routes.SCHEDULE) },
            )
        }
        if (data.openTasks > 0) {
            HrRow(
                leading = { PlainTile(Icons.Filled.Checklist) },
                title = stringResource(R.string.weldhr_me_tasks),
                subtitle = pluralStringResource(R.plurals.weldhr_home_open_tasks, data.openTasks, data.openTasks),
                tag = "home-tasks",
                onClick = { hr.open(Routes.TASKS) },
            )
        }
        if (data.toAcknowledge > 0) {
            HrRow(
                leading = { PlainTile(Icons.Filled.Forum) },
                title = stringResource(R.string.weldhr_me_reviews),
                subtitle = pluralStringResource(R.plurals.weldhr_home_to_acknowledge, data.toAcknowledge, data.toAcknowledge),
                tag = "home-reviews",
                onClick = { hr.open(Routes.REVIEWS) },
            )
        }
    }
}

