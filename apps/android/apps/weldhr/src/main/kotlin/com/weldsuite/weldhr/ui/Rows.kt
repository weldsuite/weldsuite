package com.weldsuite.weldhr.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.weldsuite.weldhr.Absence
import com.weldsuite.weldhr.HrDays
import com.weldsuite.weldhr.LeaveRequest
import com.weldsuite.weldhr.R
import com.weldsuite.weldhr.ShiftMath
import kotlinx.coroutines.delay
import org.weldsuite.ui.Tokens

/** The current time, ticking every [intervalMs] (a running clock-in). */
@Composable
fun rememberNow(intervalMs: Long): Long {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(intervalMs) {
        while (true) {
            now = System.currentTimeMillis()
            delay(intervalMs)
        }
    }
    return now
}

/** A day on a small tile: "MA" over "26". */
@Composable
fun DateTile(day: String) {
    val date = HrDays.parse(day)
    Column(
        Modifier.size(ROW_TILE).background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(10.dp)),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(Fmt.weekdayShort(day).uppercase(), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(date?.dayOfMonth?.toString().orEmpty(), style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold)
    }
}

/** A shift on Home and in the switch sheet: its day, its hours, and where. */
@Composable
fun ShiftRow(startsAt: String, endsAt: String, place: String?, workspace: String?, tag: String? = null, onClick: (() -> Unit)?) {
    HrRow(
        leading = {
            Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s), verticalAlignment = Alignment.CenterVertically) {
                ShiftBar(place ?: workspace)
                DateTile(HrDays.dayOf(startsAt))
            }
        },
        title = Fmt.timeRange(startsAt, endsAt),
        subtitle = listOfNotNull(place, workspace).joinToString(" • "),
        tag = tag,
        onClick = onClick,
    )
}

/** A leave request of the member's own, its status in colour. */
@Composable
fun LeaveRow(request: LeaveRequest, onClick: (() -> Unit)?) {
    val status = leaveStatusLabel(request.status)
    val note = request.reviewNote?.let { stringResource(R.string.weldhr_time_off_review_note_anonymous, it) }
    HrRow(
        leading = { LeaveTypeTile(request.leaveTypeColor) },
        title = request.leaveTypeName ?: stringResource(R.string.weldhr_absence_leave),
        subtitle = if (note != null) "$status • $note" else status,
        subtitleLines = 2,
        subtitleColor = statusColor(request.status),
        value = Fmt.span(request.startDate, request.endDate),
        detail = daysText(request.days),
        muted = request.status == "cancelled",
        tag = "leave-${request.id}",
        onClick = onClick,
    )
}

/** A sick report: running ("since 3 Mar - …") or recovered. */
@Composable
fun SickRow(absence: Absence, onClick: (() -> Unit)?) {
    val ongoing = absence.status == "ongoing"
    HrRow(
        leading = { SickTile() },
        title = stringResource(R.string.weldhr_absence_sick),
        subtitle = stringResource(if (ongoing) R.string.weldhr_absence_ongoing else R.string.weldhr_absence_recovered),
        subtitleColor = if (ongoing) Tokens.Status.danger.current() else null,
        value = if (ongoing || absence.endDate == null) "${Fmt.shortDate(absence.startDate)}${Fmt.RANGE}…" else Fmt.span(absence.startDate, absence.endDate),
        detail = daysText(absence.days),
        tag = "sick-${absence.id}",
        onClick = onClick,
    )
}

/** A time with the clock glyph in front, for hours still counting. */
@Composable
fun Running(text: String) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Icon(Icons.Filled.Schedule, contentDescription = null, modifier = Modifier.size(15.dp))
        Text(text, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
    }
}

/** "0:24 | € 7,40": hours and what they earn, € 0,00 without a rate. */
fun earningsText(pairs: List<Pair<String, Double>>): String = pairs.joinToString(" · ") { (currency, amount) -> Fmt.money(amount, currency) }

/** Minutes as "7:45". */
fun duration(minutes: Double): String = ShiftMath.duration(minutes)
