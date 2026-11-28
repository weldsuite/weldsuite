package com.weldsuite.weldhr.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
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

/**
 * A shift on Home and in the switch sheet, as the platform's Upcoming
 * shifts: the day, its hours under it, and the client on the right.
 */
@Composable
fun ShiftRow(startsAt: String, endsAt: String, client: String?, tag: String? = null, onClick: (() -> Unit)?) {
    HrRow(
        title = Fmt.day(HrDays.dayOf(startsAt)),
        subtitle = Fmt.timeRange(startsAt, endsAt),
        detail = client,
        tag = tag,
        onClick = onClick,
    )
}

/**
 * A leave request of the member's own, as the platform's Leave list: the
 * type's colour dot and name, the dates and days under it, the status badge.
 */
@Composable
fun LeaveRow(request: LeaveRequest, onClick: (() -> Unit)?) {
    val note = request.reviewNote?.let { stringResource(R.string.weldhr_time_off_review_note_anonymous, it) }
    val period = "${Fmt.dateRange(request.startDate, request.endDate)} · ${daysText(request.days)}"
    HrRow(
        marker = { ColorDot(request.leaveTypeColor) },
        title = request.leaveTypeName ?: stringResource(R.string.weldhr_absence_leave),
        subtitle = if (note != null) "$period\n$note" else period,
        subtitleLines = 3,
        badge = { StatusTag(request.status, leaveStatusLabel(request.status)) },
        tag = "leave-${request.id}",
        onClick = onClick,
    )
}

/**
 * A sick report, as the platform's Sick reports list: the first sick day,
 * the last one (or "still sick") and the days under it, Sick or Recovered.
 */
@Composable
fun SickRow(absence: Absence, onClick: (() -> Unit)?) {
    val first = Fmt.date(absence.startDate).let {
        if (absence.firstDay == "half") "$it · ${stringResource(R.string.weldhr_sick_half_day)}" else it
    }
    val last = absence.endDate?.let(Fmt::date) ?: stringResource(R.string.weldhr_sick_detail_still_sick)
    HrRow(
        title = first,
        subtitle = "$last · ${daysText(absence.days)}",
        badge = { StatusTag(absence.status, absenceStatusLabel(absence.status)) },
        tag = "sick-${absence.id}",
        onClick = onClick,
    )
}

/** A time with the clock glyph in front, for hours still counting. */
@Composable
fun Running(text: String) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Icon(Icons.Filled.Schedule, contentDescription = null, modifier = Modifier.size(15.dp))
        Text(text, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
    }
}

/** "0:24 | € 7,40": hours and what they earn, € 0,00 without a rate. */
fun earningsText(pairs: List<Pair<String, Double>>): String = pairs.joinToString(" · ") { (currency, amount) -> Fmt.money(amount, currency) }

/** Minutes as "7:45". */
fun duration(minutes: Double): String = ShiftMath.duration(minutes)
