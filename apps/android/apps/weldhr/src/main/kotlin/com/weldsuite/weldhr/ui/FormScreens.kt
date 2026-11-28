package com.weldsuite.weldhr.ui

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.PhotoLibrary
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import org.weldsuite.ui.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
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
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.weldsuite.weldhr.HrDays
import com.weldsuite.weldhr.LeaveRules
import com.weldsuite.weldhr.PickedFile
import com.weldsuite.weldhr.R
import com.weldsuite.weldhr.Receipts
import com.weldsuite.weldhr.parseAmount
import org.weldsuite.core.WeldDate
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged
import java.time.LocalDateTime
import java.time.ZoneId
import org.weldsuite.core.R as CoreR

/** A form in its own page: close on the left, the action (Submit, Post) on the right. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FormPage(
    title: String,
    action: String?,
    actionTag: String? = null,
    enabled: Boolean = true,
    busy: Boolean = false,
    onAction: () -> Unit = {},
    content: @Composable ColumnScope.() -> Unit,
) {
    val hr = LocalHr.current
    Column(Modifier.fillMaxSize().imePadding()) {
        TopAppBar(
            title = { Text(title) },
            navigationIcon = {
                IconButton(onClick = hr::back, modifier = Modifier.tagged("form-close")) {
                    Icon(Icons.Filled.Close, contentDescription = stringResource(CoreR.string.core_common_close))
                }
            },
            actions = {
                if (action != null) {
                    if (busy) {
                        CircularProgressIndicator(Modifier.padding(end = Tokens.Spacing.l).size(20.dp), strokeWidth = 2.dp)
                    } else {
                        TextButton(onClick = onAction, enabled = enabled, modifier = Modifier.tagged(actionTag)) { Text(action) }
                    }
                }
            },
        )
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).navigationBarsPadding().padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.s),
            verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.m),
            content = content,
        )
    }
}

/** A hint under a field, red for an error. */
@Composable
fun Hint(text: String?, error: Boolean = false) {
    if (text.isNullOrBlank()) return
    Text(
        text,
        style = MaterialTheme.typography.bodySmall,
        color = if (error) org.weldsuite.ui.Tokens.Status.danger.current() else MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.tagged(if (error) "form-error" else null),
    )
}

@Composable
private fun Label(text: String) = Text(text, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)

/** Choices as chips (currency, category, whole or half day). */
@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
private fun Chips(options: List<Pair<String, String>>, value: String, onChange: (String) -> Unit, tag: String) {
    androidx.compose.foundation.layout.FlowRow(horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
        options.forEach { (key, label) ->
            FilterChip(selected = key == value, onClick = { onChange(key) }, label = { Text(label) }, modifier = Modifier.tagged("$tag-$key"))
        }
    }
}

/** What the write's failure says: the server's message, else a general one. */
@Composable
private fun rememberFailure(): (Exception) -> String {
    val generic = stringResource(CoreR.string.core_errors_generic)
    return { error -> error.message?.takeIf { it.isNotBlank() } ?: generic }
}

/** Requesting time off: the type with its balance, the days, and a reason. */
@Composable
fun LeaveFormScreen() {
    val hr = LocalHr.current
    val repo = hr.repository
    val leave by repo.leave.state.collectAsStateWithLifecycle()
    val me by repo.me.state.collectAsStateWithLifecycle()
    LaunchedEffect(Unit) { repo.leave.ensure() }
    val title = stringResource(R.string.weldhr_leave_form_title)
    val data = leave.data
    if (me.data?.features?.leaveRequests == false) {
        FormPage(title, null) { Hint(stringResource(R.string.weldhr_time_off_turned_off)) }
        return
    }
    if (data == null) {
        FormPage(title, null) {
            if (leave.error != null) Hint(errorText(leave.error), error = true) else CircularProgressIndicator(Modifier.align(Alignment.CenterHorizontally))
        }
        return
    }
    val today = HrDays.today()
    val firstDay = remember { HrDays.nextWeekday(today) }
    var typeId by rememberSaveable { mutableStateOf(data.types.singleOrNull()?.id) }
    var start by rememberSaveable { mutableStateOf(firstDay) }
    var end by rememberSaveable { mutableStateOf(firstDay) }
    var reason by rememberSaveable { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val type = data.types.firstOrNull { it.id == typeId }
    val balance = LeaveRules.balanceForStart(data.balances, typeId, start, today)
    val days = HrDays.weekdaysBetween(start, end)
    val allowance = LeaveRules.checkAllowance(balance, days)
    val blocked = allowance is LeaveRules.Allowance.Over && allowance.blocked
    val chooseType = stringResource(R.string.weldhr_leave_form_choose_type)
    val endBeforeStart = stringResource(R.string.weldhr_leave_form_end_before_start)
    val approvedText = stringResource(R.string.weldhr_leave_form_approved)
    val sentText = stringResource(R.string.weldhr_leave_form_sent)
    val failure = rememberFailure()
    FormPage(
        title,
        stringResource(R.string.weldhr_common_submit),
        "leave-submit",
        enabled = !blocked && typeId != null,
        busy = busy,
        onAction = {
            error = null
            val chosen = typeId
            when {
                chosen == null -> error = chooseType
                end < start -> error = endBeforeStart
                else -> {
                    busy = true
                    hr.launch {
                        try {
                            val status = repo.requestLeave(chosen, start, end, reason.trim().ifEmpty { null })
                            hr.toast(if (status == "approved") approvedText else sentText)
                            hr.back()
                        } catch (failed: Exception) {
                            error = failure(failed)
                        } finally {
                            busy = false
                        }
                    }
                }
            }
        },
    ) {
        Label(stringResource(R.string.weldhr_leave_form_type))
        val balances = if (start.take(4) == today.take(4)) data.balances else emptyList()
        data.types.forEach { option ->
            val optionBalance = balances.firstOrNull { it.leaveTypeId == option.id }
            val remaining = optionBalance?.remaining
            val sub = when {
                remaining != null -> "${stringResource(R.string.weldhr_balance_left, Fmt.days(remaining))} · ${stringResource(R.string.weldhr_balance_of_allowance, Fmt.days(optionBalance.allowance ?: 0.0))}"
                optionBalance != null -> stringResource(R.string.weldhr_balance_unlimited)
                else -> null
            }
            ListItem(
                leadingContent = { ColorDot(option.color, size = 10.dp) },
                headlineContent = { Text(option.name) },
                supportingContent = sub?.let { { Text(it) } },
                trailingContent = { RadioButton(selected = option.id == typeId, onClick = { typeId = option.id }) },
                modifier = Modifier.clickable { typeId = option.id }.tagged("leave-type-${option.id}"),
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.l)) {
            DateField(stringResource(R.string.weldhr_leave_form_from), start, onChange = {
                start = it
                if (end < it) end = it
            }, tag = "leave-from", modifier = Modifier.weight(1f))
            DateField(stringResource(R.string.weldhr_leave_form_to), end, onChange = { end = it }, min = start, tag = "leave-to", modifier = Modifier.weight(1f))
        }
        Hint(pluralStringResource(R.plurals.weldhr_leave_form_estimate, days, days))
        if (allowance is LeaveRules.Allowance.Over) {
            Hint(
                stringResource(if (allowance.blocked) R.string.weldhr_leave_form_over_allowance_blocked else R.string.weldhr_leave_form_over_allowance, Fmt.days(allowance.remaining)),
                error = allowance.blocked,
            )
        }
        OutlinedTextField(
            value = reason,
            onValueChange = { reason = it.take(2000) },
            label = { Text(stringResource(R.string.weldhr_leave_form_reason)) },
            placeholder = { Text(stringResource(R.string.weldhr_leave_form_reason_placeholder)) },
            minLines = 3,
            modifier = Modifier.fillMaxWidth().tagged("leave-reason"),
        )
        if (error != null) {
            Hint(error, error = true)
        } else if (type != null) {
            Hint(stringResource(if (type.requiresApproval) R.string.weldhr_leave_form_needs_approval else R.string.weldhr_leave_form_auto_approved))
        }
    }
}

private val CURRENCIES = listOf("EUR", "USD", "GBP")
private val CATEGORIES = listOf("travel", "meals", "accommodation", "equipment", "training", "other")

/** A new expense: amount, currency, day, category, what for, and the receipt (camera or photos). */
@Composable
fun ExpenseFormScreen(startWith: String) {
    val hr = LocalHr.current
    val repo = hr.repository
    val context = LocalContext.current
    val me by repo.me.state.collectAsStateWithLifecycle()
    val title = stringResource(R.string.weldhr_expense_form_title)
    if (me.data?.features?.declarations == false) {
        FormPage(title, null) { Hint(stringResource(R.string.weldhr_expenses_turned_off)) }
        return
    }
    val today = HrDays.today()
    var amountText by rememberSaveable { mutableStateOf("") }
    var currency by rememberSaveable { mutableStateOf("EUR") }
    var date by rememberSaveable { mutableStateOf(today) }
    var category by rememberSaveable { mutableStateOf("travel") }
    var description by rememberSaveable { mutableStateOf("") }
    var receipt by remember { mutableStateOf<PickedFile?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var cameraUri by rememberSaveable { mutableStateOf<String?>(null) }
    val typeText = stringResource(R.string.weldhr_expense_form_receipt_type)
    val sizeText = stringResource(R.string.weldhr_expense_form_receipt_size)
    val noCamera = stringResource(R.string.weldhr_expense_form_no_camera)
    val generic = stringResource(CoreR.string.core_errors_generic)
    fun take(uri: Uri?) {
        if (uri == null) return
        hr.launch {
            when (val picked = HrFiles.read(context, uri, today)) {
                is HrFiles.Picked.File -> receipt = picked.file
                is HrFiles.Picked.Problem -> error = if (picked.problem == Receipts.Problem.TYPE) typeText else sizeText
                HrFiles.Picked.Failed -> error = generic
            }
        }
    }
    val camera = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { saved ->
        if (saved) take(cameraUri?.let(Uri::parse))
    }
    // The system photo picker: no storage permission.
    val library = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri -> take(uri) }
    val openCamera = {
        error = null
        try {
            val uri = HrFiles.cameraUri(context)
            cameraUri = uri.toString()
            camera.launch(uri)
        } catch (_: Exception) {
            error = noCamera
        }
    }
    val openLibrary = {
        error = null
        library.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
    }
    // From the "+" on Expenses: start with the receipt, once.
    var started by rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(startWith) {
        if (!started && (startWith == "camera" || startWith == "library")) {
            started = true
            if (startWith == "camera") openCamera() else openLibrary()
        }
    }
    val amountInvalid = stringResource(R.string.weldhr_expense_form_amount_invalid)
    val descriptionRequired = stringResource(R.string.weldhr_expense_form_description_required)
    val sent = stringResource(R.string.weldhr_expense_form_sent)
    val sentNoReceipt = stringResource(R.string.weldhr_expense_form_sent_no_receipt)
    val failure = rememberFailure()
    FormPage(
        title,
        stringResource(R.string.weldhr_common_submit),
        "expense-submit",
        busy = busy,
        onAction = {
            error = null
            val amount = parseAmount(amountText)
            when {
                amount == null -> error = amountInvalid
                description.isBlank() -> error = descriptionRequired
                else -> {
                    busy = true
                    hr.launch {
                        try {
                            val withReceipt = repo.createDeclaration(amount, currency, date, category, description.trim(), receipt)
                            hr.toast(if (withReceipt) sent else sentNoReceipt)
                            hr.back()
                        } catch (failed: Exception) {
                            error = failure(failed)
                        } finally {
                            busy = false
                        }
                    }
                }
            }
        },
    ) {
        OutlinedTextField(
            value = amountText,
            onValueChange = { amountText = it },
            label = { Text(stringResource(R.string.weldhr_expense_form_amount)) },
            placeholder = { Text(stringResource(R.string.weldhr_expense_form_amount_placeholder)) },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
            singleLine = true,
            modifier = Modifier.fillMaxWidth().tagged("expense-amount"),
        )
        Chips(CURRENCIES.map { it to it }, currency, { currency = it }, "expense-currency")
        DateField(stringResource(R.string.weldhr_expense_form_date), date, onChange = { date = it }, max = today, tag = "expense-date")
        Label(stringResource(R.string.weldhr_expense_form_category))
        Chips(CATEGORIES.map { it to categoryLabel(it) }, category, { category = it }, "expense-category")
        OutlinedTextField(
            value = description,
            onValueChange = { description = it.take(2000) },
            label = { Text(stringResource(R.string.weldhr_expense_form_description)) },
            placeholder = { Text(stringResource(R.string.weldhr_expense_form_description_placeholder)) },
            minLines = 2,
            modifier = Modifier.fillMaxWidth().tagged("expense-description"),
        )
        Label(stringResource(R.string.weldhr_expense_form_receipt))
        val picked = receipt
        if (picked != null) {
            ListItem(
                leadingContent = { Icon(if (picked.mimeType == "application/pdf") Icons.Filled.Description else Icons.Filled.PhotoLibrary, contentDescription = null) },
                headlineContent = { Text(picked.name, maxLines = 1) },
                trailingContent = {
                    IconButton(onClick = { receipt = null }, modifier = Modifier.tagged("expense-receipt-remove")) {
                        Icon(Icons.Filled.Close, contentDescription = stringResource(R.string.weldhr_expense_form_remove_receipt))
                    }
                },
            )
        } else {
            Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
                OutlinedButton(onClick = openCamera, modifier = Modifier.weight(1f).tagged("expense-take-photo")) {
                    Icon(Icons.Filled.CameraAlt, contentDescription = null)
                    Text(stringResource(R.string.weldhr_expense_form_take_photo), modifier = Modifier.padding(start = Tokens.Spacing.s))
                }
                OutlinedButton(onClick = openLibrary, modifier = Modifier.weight(1f).tagged("expense-choose-photo")) {
                    Icon(Icons.Filled.PhotoLibrary, contentDescription = null)
                    Text(stringResource(R.string.weldhr_expense_form_choose_photo), modifier = Modifier.padding(start = Tokens.Spacing.s))
                }
            }
        }
        Hint(error, error = true)
    }
}

/** Report sick, or "I'm better" while a report is open. Always available: an ill employee has to be able to say so. */
@Composable
fun SickFormScreen() {
    val hr = LocalHr.current
    val repo = hr.repository
    val absences by repo.absences.state.collectAsStateWithLifecycle()
    LaunchedEffect(Unit) { repo.absences.ensure() }
    val data = absences.data
    if (data == null) {
        FormPage(stringResource(R.string.weldhr_sick_title), null) {
            if (absences.error != null) Hint(errorText(absences.error), error = true) else CircularProgressIndicator(Modifier.align(Alignment.CenterHorizontally))
        }
        return
    }
    val current = data.current
    val today = HrDays.today()
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val failure = rememberFailure()
    if (current != null) {
        // Most people report it the morning they are back, so yesterday was the last sick day.
        var end by rememberSaveable { mutableStateOf(HrDays.add(today, -1).let { if (it < current.startDate) current.startDate else it }) }
        val recovered = stringResource(R.string.weldhr_sick_recovered)
        FormPage(stringResource(R.string.weldhr_sick_recover_title), stringResource(R.string.weldhr_common_submit), "sick-recover-submit", busy = busy, onAction = {
            error = null
            busy = true
            hr.launch {
                try {
                    repo.reportRecovered(current.id, end)
                    hr.toast(recovered)
                    hr.back()
                } catch (failed: Exception) {
                    error = failure(failed)
                } finally {
                    busy = false
                }
            }
        }) {
            DateField(stringResource(R.string.weldhr_sick_last_day), end, onChange = { end = it }, min = current.startDate, max = today, tag = "sick-last-day")
            if (error != null) Hint(error, error = true) else Hint(stringResource(R.string.weldhr_sick_recover_hint, Fmt.day(current.startDate)))
            SickHistory(data.history)
        }
        return
    }
    var start by rememberSaveable { mutableStateOf(today) }
    var firstDay by rememberSaveable { mutableStateOf("full") }
    var note by rememberSaveable { mutableStateOf("") }
    val reported = stringResource(R.string.weldhr_sick_reported)
    FormPage(stringResource(R.string.weldhr_sick_title), stringResource(R.string.weldhr_common_submit), "sick-submit", busy = busy, onAction = {
        error = null
        busy = true
        hr.launch {
            try {
                repo.reportSick(start, firstDay, note.trim().ifEmpty { null })
                hr.toast(reported)
                hr.back()
            } catch (failed: Exception) {
                error = failure(failed)
            } finally {
                busy = false
            }
        }
    }) {
        // A report can start a few days back (ill over the weekend), never in the future.
        DateField(stringResource(R.string.weldhr_sick_first_day), start, onChange = { start = it }, min = HrDays.add(today, -14), max = today, tag = "sick-first-day")
        Label(stringResource(R.string.weldhr_sick_first_day_length))
        Chips(listOf("full" to stringResource(R.string.weldhr_sick_full_day), "half" to stringResource(R.string.weldhr_sick_half_day)), firstDay, { firstDay = it }, "sick-length")
        OutlinedTextField(
            value = note,
            onValueChange = { note = it.take(1000) },
            label = { Text(stringResource(R.string.weldhr_sick_note)) },
            placeholder = { Text(stringResource(R.string.weldhr_sick_note_placeholder)) },
            minLines = 2,
            modifier = Modifier.fillMaxWidth().tagged("sick-note"),
        )
        if (error != null) Hint(error, error = true) else Hint(stringResource(R.string.weldhr_sick_note_hint))
        SickHistory(data.history)
    }
}

/** The last reports, under the form: when and how many days. */
@Composable
private fun SickHistory(history: List<com.weldsuite.weldhr.Absence>) {
    if (history.isEmpty()) return
    Label(stringResource(R.string.weldhr_sick_history))
    history.take(10).forEach { absence ->
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(Fmt.dateRange(absence.startDate, absence.endDate ?: absence.startDate), modifier = Modifier.weight(1f), maxLines = 1)
            Text(daysText(absence.days), color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/** `day` at `time` ("09:30") on the phone's clock, as the server takes a timestamp. */
fun instantOf(day: String, time: String, zone: ZoneId = ZoneId.systemDefault()): java.time.Instant? {
    val date = HrDays.parse(day) ?: return null
    val parts = time.split(':')
    val hour = parts.getOrNull(0)?.toIntOrNull() ?: return null
    val minute = parts.getOrNull(1)?.toIntOrNull() ?: return null
    return LocalDateTime.of(date, java.time.LocalTime.of(hour.coerceIn(0, 23), minute.coerceIn(0, 59))).atZone(zone).toInstant()
}

/** Asking to work a shift: the day, from and until (until before from ends the next day), the work and a note. */
@Composable
fun ShiftRequestFormScreen() {
    val hr = LocalHr.current
    val today = HrDays.today()
    var day by rememberSaveable { mutableStateOf(HrDays.add(today, 1)) }
    var from by rememberSaveable { mutableStateOf("09:00") }
    var until by rememberSaveable { mutableStateOf("17:00") }
    var work by rememberSaveable { mutableStateOf("") }
    var note by rememberSaveable { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val nextDay = until <= from
    val startsAt = instantOf(day, from)
    val endsAt = instantOf(if (nextDay) HrDays.add(day, 1) else day, until)
    val minutes = if (startsAt != null && endsAt != null) (endsAt.toEpochMilli() - startsAt.toEpochMilli()) / 60_000.0 else 0.0
    val inPast = stringResource(R.string.weldhr_shift_request_in_past)
    val sent = stringResource(R.string.weldhr_shift_request_sent)
    val failure = rememberFailure()
    FormPage(stringResource(R.string.weldhr_shift_request_title), stringResource(R.string.weldhr_common_submit), "shift-request-submit", busy = busy, onAction = {
        error = null
        if (startsAt == null || endsAt == null || startsAt.toEpochMilli() <= System.currentTimeMillis()) {
            error = inPast
        } else {
            busy = true
            hr.launch {
            try {
                hr.repository.requestShift(WeldDate.timestampString(startsAt), WeldDate.timestampString(endsAt), work.trim().ifEmpty { null }, note.trim().ifEmpty { null })
                hr.toast(sent)
                hr.back()
            } catch (failed: Exception) {
                    error = failure(failed)
                } finally {
                    busy = false
                }
            }
        }
    }) {
        DateField(stringResource(R.string.weldhr_shift_request_day), day, onChange = { day = it }, min = today, tag = "shift-request-day")
        Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.l)) {
            TimeField(stringResource(R.string.weldhr_shift_request_from), from, onChange = { from = it }, tag = "shift-request-from", modifier = Modifier.weight(1f))
            TimeField(stringResource(R.string.weldhr_shift_request_to), until, onChange = { until = it }, tag = "shift-request-until", modifier = Modifier.weight(1f))
        }
        Hint(listOfNotNull(hm(minutes), if (nextDay) stringResource(R.string.weldhr_shift_request_next_day) else null).joinToString(" · "))
        OutlinedTextField(
            value = work,
            onValueChange = { work = it.take(100) },
            label = { Text(stringResource(R.string.weldhr_shift_request_work)) },
            placeholder = { Text(stringResource(R.string.weldhr_shift_request_work_placeholder)) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth().tagged("shift-request-work"),
        )
        OutlinedTextField(
            value = note,
            onValueChange = { note = it.take(1000) },
            label = { Text(stringResource(R.string.weldhr_shift_request_note)) },
            placeholder = { Text(stringResource(R.string.weldhr_shift_request_note_placeholder)) },
            minLines = 2,
            modifier = Modifier.fillMaxWidth().tagged("shift-request-note"),
        )
        if (error != null) Hint(error, error = true) else Hint(stringResource(R.string.weldhr_shift_request_hint))
    }
}

/** Posting an announcement to every employee: title, message, pinned, and a push. */
@Composable
fun AnnouncementFormScreen() {
    val hr = LocalHr.current
    var title by rememberSaveable { mutableStateOf("") }
    var body by rememberSaveable { mutableStateOf("") }
    var pinned by rememberSaveable { mutableStateOf(false) }
    var notify by rememberSaveable { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val posted = stringResource(R.string.weldhr_announcement_form_posted)
    val failed = stringResource(R.string.weldhr_announcement_form_failed)
    FormPage(
        stringResource(R.string.weldhr_announcement_form_title),
        stringResource(R.string.weldhr_announcement_form_post),
        "announcement-submit",
        enabled = title.isNotBlank() && body.isNotBlank(),
        busy = busy,
        onAction = {
            error = null
            busy = true
            hr.launch {
                try {
                    hr.repository.createAnnouncement(title.trim(), body.trim(), pinned, notify)
                    hr.toast(posted)
                    hr.back()
                } catch (_: Exception) {
                    error = failed
                } finally {
                    busy = false
                }
            }
        },
    ) {
        OutlinedTextField(
            value = title,
            onValueChange = {
                title = it.take(200)
                error = null
            },
            label = { Text(stringResource(R.string.weldhr_announcement_form_title_label)) },
            placeholder = { Text(stringResource(R.string.weldhr_announcement_form_title_placeholder)) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth().tagged("announcement-title"),
        )
        OutlinedTextField(
            value = body,
            onValueChange = {
                body = it.take(20_000)
                error = null
            },
            label = { Text(stringResource(R.string.weldhr_announcement_form_body)) },
            placeholder = { Text(stringResource(R.string.weldhr_announcement_form_body_placeholder)) },
            minLines = 6,
            modifier = Modifier.fillMaxWidth().tagged("announcement-body"),
        )
        Hint(error, error = true)
        ListItem(
            headlineContent = { Text(stringResource(R.string.weldhr_announcement_form_pinned)) },
            supportingContent = { Text(stringResource(R.string.weldhr_announcement_form_pinned_hint)) },
            trailingContent = { Switch(checked = pinned, onCheckedChange = { pinned = it }, modifier = Modifier.tagged("announcement-pinned")) },
        )
        ListItem(
            headlineContent = { Text(stringResource(R.string.weldhr_announcement_form_notify)) },
            supportingContent = { Text(stringResource(R.string.weldhr_announcement_form_notify_hint)) },
            trailingContent = { Switch(checked = notify, onCheckedChange = { notify = it }, modifier = Modifier.tagged("announcement-notify")) },
        )
    }
}
