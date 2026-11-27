package com.weldsuite.weldbooks.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.text.KeyboardOptions
import com.weldsuite.weldbooks.R
import com.weldsuite.weldbooks.logic.Statuses
import org.weldsuite.ui.DayNight
import org.weldsuite.ui.StatusBadge
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset

/** Accent colours per area, matching the platform's WeldBooks sidebar. */
object Accents {
    val banking = Color(0xFF3B82F6)
    val reconciliation = Color(0xFF8B5CF6)
    val vat = Color(0xFF10B981)
    val profitLoss = Color(0xFFF59E0B)
    val balanceSheet = Color(0xFFEC4899)
    val contacts = Color(0xFF06B6D4)
    val settings = Color(0xFF6B7280)
}

/** A screen with a title bar, a back arrow when it has somewhere to go back to, and the snackbar. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BooksScaffold(
    title: String,
    onBack: (() -> Unit)? = null,
    subtitle: String? = null,
    onTitleClick: (() -> Unit)? = null,
    actions: @Composable RowScope.() -> Unit = {},
    bottomBar: @Composable () -> Unit = {},
    content: @Composable (androidx.compose.foundation.layout.PaddingValues) -> Unit,
) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column(if (onTitleClick != null) Modifier.clickable(onClick = onTitleClick).tagged("title-switcher") else Modifier) {
                        Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (subtitle != null) {
                            Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                        }
                    }
                },
                navigationIcon = {
                    if (onBack != null) {
                        IconButton(onClick = onBack, modifier = Modifier.tagged("back")) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.weldbooks_screen_go_back))
                        }
                    }
                },
                actions = actions,
            )
        },
        snackbarHost = { SnackbarHost(LocalSnackbar.current) },
        bottomBar = bottomBar,
        content = content,
    )
}

/** A rounded card with an optional title and action. */
@Composable
fun SectionCard(
    title: String? = null,
    modifier: Modifier = Modifier,
    action: (@Composable () -> Unit)? = null,
    padded: Boolean = true,
    content: @Composable ColumnScope.() -> Unit,
) {
    Card(
        modifier = modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.m, vertical = Tokens.Spacing.xs + 2.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
        shape = RoundedCornerShape(Tokens.Radius.large),
    ) {
        Column(if (padded) Modifier.padding(Tokens.Spacing.l) else Modifier.padding(vertical = Tokens.Spacing.s)) {
            if (title != null || action != null) {
                Row(
                    Modifier.fillMaxWidth().padding(bottom = Tokens.Spacing.s).let { if (padded) it else it.padding(horizontal = Tokens.Spacing.l) },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    if (title != null) Text(title, style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                    action?.invoke()
                }
            }
            content()
        }
    }
}

/** A label and its value on one row. */
@Composable
fun DetailRow(label: String, value: String, valueColor: Color? = null, strong: Boolean = false) {
    Row(Modifier.fillMaxWidth().padding(vertical = 5.dp), horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.l)) {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
        Text(
            value,
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = if (strong) FontWeight.SemiBold else FontWeight.Normal,
            color = valueColor ?: MaterialTheme.colorScheme.onSurface,
            textAlign = TextAlign.End,
            modifier = Modifier.weight(1.4f),
        )
    }
}

/** Rows of amounts and a total under a rule. */
@Composable
fun TotalsBlock(rows: List<Pair<String, String>>, total: Pair<String, String>) {
    rows.forEach { (label, value) -> DetailRow(label, value) }
    HorizontalDivider(Modifier.padding(vertical = Tokens.Spacing.s))
    Row(Modifier.fillMaxWidth()) {
        Text(total.first, style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
        Text(total.second, style = MaterialTheme.typography.titleSmall)
    }
}

/** An icon on a tinted rounded tile. */
@Composable
fun IconTile(icon: ImageVector, color: Color, size: Dp = 40.dp) {
    Box(
        Modifier.size(size).background(color.copy(alpha = 0.12f), RoundedCornerShape(size * 0.3f)),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = null, tint = color, modifier = Modifier.size(size * 0.5f))
    }
}

/** A list row: a tile, a title and subtitle, and an amount with a badge or meta line. */
@Composable
fun RecordRow(
    leading: @Composable () -> Unit,
    title: String,
    subtitle: String? = null,
    meta: String? = null,
    amount: String? = null,
    amountColor: Color? = null,
    badge: (@Composable () -> Unit)? = null,
    tag: String? = null,
    onClick: (() -> Unit)? = null,
) {
    Row(
        Modifier.fillMaxWidth()
            .let { if (onClick != null) it.clickable(onClick = onClick) else it }
            .padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.m)
            .tagged(tag),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m),
    ) {
        leading()
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (subtitle != null) Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
            if (meta != null) Text(meta, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
        }
        Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            if (amount != null) Text(amount, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold, color = amountColor ?: MaterialTheme.colorScheme.onSurface)
            badge?.invoke()
        }
    }
}

/** A status as a coloured label. */
@Composable
fun StatusPill(status: String) {
    val color = when (Statuses.tone(status)) {
        "success" -> Tokens.Status.success.current()
        "warning" -> Tokens.Status.warning.current()
        "danger" -> Tokens.Status.danger.current()
        "neutral" -> MaterialTheme.colorScheme.onSurfaceVariant
        else -> MaterialTheme.colorScheme.primary
    }
    StatusBadge(statusLabel(status), color)
}

@Composable
fun statusLabel(status: String): String = when (status) {
    "draft" -> stringResource(R.string.weldbooks_status_draft)
    "finalized" -> stringResource(R.string.weldbooks_status_finalized)
    "sent" -> stringResource(R.string.weldbooks_status_sent)
    "viewed" -> stringResource(R.string.weldbooks_status_viewed)
    "partially_paid", "partial" -> stringResource(R.string.weldbooks_status_partially_paid)
    "paid" -> stringResource(R.string.weldbooks_status_paid)
    "overdue" -> stringResource(R.string.weldbooks_status_overdue)
    "cancelled" -> stringResource(R.string.weldbooks_status_cancelled)
    "uncollectible" -> stringResource(R.string.weldbooks_status_uncollectible)
    "pending" -> stringResource(R.string.weldbooks_status_pending)
    "approved" -> stringResource(R.string.weldbooks_status_approved)
    "rejected" -> stringResource(R.string.weldbooks_status_rejected)
    "submitted" -> stringResource(R.string.weldbooks_status_submitted)
    "accepted" -> stringResource(R.string.weldbooks_status_accepted)
    "calculated" -> stringResource(R.string.weldbooks_status_calculated)
    "reviewed" -> stringResource(R.string.weldbooks_status_reviewed)
    "filed" -> stringResource(R.string.weldbooks_status_filed)
    else -> status.replace('_', ' ').replaceFirstChar { it.uppercase() }
}

/** A notice in the flow of a screen: info, success, warning or error. */
@Composable
fun Banner(text: String, tone: String = "info", title: String? = null, onClose: (() -> Unit)? = null, modifier: Modifier = Modifier) {
    val color = when (tone) {
        "success" -> Tokens.Status.success.current()
        "warning" -> Tokens.Status.warning.current()
        "error" -> Tokens.Status.danger.current()
        else -> MaterialTheme.colorScheme.primary
    }
    Row(
        modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.m, vertical = Tokens.Spacing.xs)
            .background(color.copy(alpha = 0.1f), RoundedCornerShape(Tokens.Radius.medium))
            .padding(Tokens.Spacing.m),
        verticalAlignment = Alignment.Top,
    ) {
        Column(Modifier.weight(1f)) {
            if (title != null) Text(title, style = MaterialTheme.typography.titleSmall, color = color)
            Text(text, style = MaterialTheme.typography.bodyMedium)
        }
        if (onClose != null) {
            IconButton(onClick = onClose, modifier = Modifier.size(24.dp)) {
                Icon(Icons.Filled.Close, contentDescription = stringResource(org.weldsuite.core.R.string.core_common_close))
            }
        }
    }
}

/** A text field that fills the width, with an error or helper line. */
@Composable
fun FormField(
    label: String,
    value: String,
    onChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    placeholder: String? = null,
    error: String? = null,
    helper: String? = null,
    keyboard: KeyboardType = KeyboardType.Text,
    singleLine: Boolean = true,
    minLines: Int = 1,
    maxLength: Int? = null,
    tag: String? = null,
) {
    OutlinedTextField(
        value = value,
        onValueChange = { text -> onChange(if (maxLength != null) text.take(maxLength) else text) },
        label = { Text(label) },
        placeholder = placeholder?.let { { Text(it) } },
        isError = error != null,
        supportingText = (error ?: helper)?.let { { Text(it) } },
        keyboardOptions = KeyboardOptions(keyboardType = keyboard),
        singleLine = singleLine,
        minLines = minLines,
        modifier = modifier.fillMaxWidth().padding(vertical = 2.dp).tagged(tag),
    )
}

/** A choice from a list, as a dropdown. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun Dropdown(
    label: String,
    value: String?,
    options: List<Pair<String, String>>,
    onChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    placeholder: String? = null,
    error: String? = null,
    tag: String? = null,
) {
    var open by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(expanded = open && enabled, onExpandedChange = { if (enabled) open = it }, modifier = modifier.padding(vertical = 2.dp)) {
        OutlinedTextField(
            value = options.firstOrNull { it.first == value }?.second ?: value.orEmpty(),
            onValueChange = {},
            readOnly = true,
            enabled = enabled,
            label = { Text(label) },
            placeholder = placeholder?.let { { Text(it) } },
            isError = error != null,
            supportingText = error?.let { { Text(it) } },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = open) },
            modifier = Modifier.fillMaxWidth().menuAnchor(MenuAnchorType.PrimaryNotEditable, enabled).tagged(tag),
        )
        ExposedDropdownMenu(expanded = open && enabled, onDismissRequest = { open = false }) {
            options.forEach { (key, text) ->
                DropdownMenuItem(text = { Text(text) }, onClick = {
                    onChange(key)
                    open = false
                })
            }
        }
    }
}

/** A switch with its label. */
@Composable
fun SwitchRow(label: String, checked: Boolean, onChange: (Boolean) -> Unit, tag: String? = null) {
    Row(
        Modifier.fillMaxWidth().clickable { onChange(!checked) }.padding(vertical = Tokens.Spacing.s).tagged(tag),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
        Switch(checked = checked, onCheckedChange = onChange)
    }
}

/** A calendar day, picked from Material's date picker. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DateField(label: String, value: LocalDate, onChange: (LocalDate) -> Unit, error: String? = null, tag: String? = null) {
    val books = LocalBooks.current
    var open by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        Text(label, style = MaterialTheme.typography.labelLarge)
        Text(
            formatDay(value, books.locale),
            style = MaterialTheme.typography.bodyLarge,
            modifier = Modifier.fillMaxWidth().clickable { open = true }.padding(vertical = Tokens.Spacing.s).tagged(tag),
        )
        if (error != null) Text(error, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
        HorizontalDivider()
    }
    if (open) {
        val state = rememberDatePickerState(initialSelectedDateMillis = value.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli())
        DatePickerDialog(
            onDismissRequest = { open = false },
            confirmButton = {
                TextButton(onClick = {
                    state.selectedDateMillis?.let { onChange(Instant.ofEpochMilli(it).atZone(ZoneOffset.UTC).toLocalDate()) }
                    open = false
                }) { Text(stringResource(R.string.weldbooks_common_confirm)) }
            },
            dismissButton = { TextButton(onClick = { open = false }) { Text(stringResource(org.weldsuite.core.R.string.core_common_cancel)) } },
        ) { DatePicker(state = state) }
    }
}

/** An "are you sure" dialog. */
@Composable
fun ConfirmDialog(
    title: String,
    message: String?,
    confirm: String,
    destructive: Boolean = false,
    dismiss: String = stringResource(org.weldsuite.core.R.string.core_common_cancel),
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = message?.let { { Text(it) } },
        confirmButton = {
            TextButton(onClick = onConfirm, modifier = Modifier.tagged("confirm")) {
                Text(confirm, color = if (destructive) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary)
            }
        },
        dismissButton = { TextButton(onClick = onDismiss, modifier = Modifier.tagged("cancel")) { Text(dismiss) } },
    )
}

/** A small uppercase heading over a group of rows. */
@Composable
fun GroupLabel(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.labelLarge,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(start = Tokens.Spacing.xl, top = Tokens.Spacing.l, bottom = Tokens.Spacing.s),
    )
}

/** A spacer for the bottom of a scrolling form. */
@Composable
fun BottomSpace() = Spacer(Modifier.size(Tokens.Spacing.xl))

/** The brand colour of the theme. */
val Brand: DayNight get() = Tokens.Brand.weldbooks

@Composable
fun HintText(text: String) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 4.dp))
}

@Composable
fun Gap(width: Dp) = Spacer(Modifier.width(width))
