package com.weldsuite.weldbooks.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.outlined.CalendarToday
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.UnfoldMore
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MenuAnchorType
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.weldsuite.weldbooks.R
import com.weldsuite.weldbooks.logic.Statuses
import org.weldsuite.ui.Button
import org.weldsuite.ui.Card
import org.weldsuite.ui.DayNight
import org.weldsuite.ui.OutlinedButton
import org.weldsuite.ui.StatusBadge
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.initialsOf
import org.weldsuite.ui.tagged
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset

// The pieces every WeldBooks screen is built from, drawn as the web platform's
// WeldBooks draws them (`apps/web/platform/app/weldbooks`,
// `components/accounting/weldbooks-row-cells.tsx`, `@weldsuite/ui`): plain rows
// with hairlines on the page, coloured status chips, bordered cards only for
// figures, forms and settings, labels above bordered inputs.

/**
 * The platform's chip colours (`weldbooks-row-cells.tsx`): the text colour,
 * light and dark; the chip's fill is a wash of it.
 */
object Tones {
    /** `text-gray-600`, `dark:text-muted-foreground`. */
    val gray = DayNight(Color(0xFF4B5563), Color(0xFFB5BDC9))
    val blue = DayNight(Color(0xFF2563EB), Color(0xFF60A5FA))
    val green = DayNight(Color(0xFF059669), Color(0xFF34D399))
    val amber = DayNight(Color(0xFFD97706), Color(0xFFFBBF24))
    val red = DayNight(Color(0xFFDC2626), Color(0xFFF87171))
    val purple = DayNight(Color(0xFF9333EA), Color(0xFFC084FC))
    val indigo = DayNight(Color(0xFF4338CA), Color(0xFF818CF8))

    /** A money amount coming in: `text-emerald-600 dark:text-emerald-400`. */
    val positive = green

    /** A tone by name (`Statuses.tone`); gray for anything else. */
    fun of(name: String): DayNight = when (name) {
        "blue" -> blue
        "green" -> green
        "amber" -> amber
        "red" -> red
        "purple" -> purple
        "indigo" -> indigo
        else -> gray
    }
}

/** Figures set in tabular numerals, as the platform sets amounts and dates. */
val Tabular = TextStyle(fontFeatureSettings = "tnum")

/** 13 sp: the platform's secondary line under a row title. */
@Composable
fun secondaryStyle(): TextStyle = MaterialTheme.typography.bodyMedium.copy(fontSize = 13.sp, lineHeight = 18.sp)

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
                        Text(title, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
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

/**
 * The platform's card: bordered, `rounded-xl`, on the card colour, with an
 * optional title and action. For figures, forms and settings; a record's
 * details sit on the page in a [PanelSection].
 */
@Composable
fun SectionCard(
    title: String? = null,
    modifier: Modifier = Modifier,
    action: (@Composable () -> Unit)? = null,
    padded: Boolean = true,
    content: @Composable ColumnScope.() -> Unit,
) {
    Card(modifier = modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l, vertical = 6.dp)) {
        Column(if (padded) Modifier.padding(Tokens.Spacing.l) else Modifier.padding(vertical = Tokens.Spacing.xs)) {
            if (title != null || action != null) {
                Row(
                    Modifier.fillMaxWidth().padding(bottom = Tokens.Spacing.s).let { if (padded) it else it.padding(start = Tokens.Spacing.l, end = Tokens.Spacing.s, top = Tokens.Spacing.m) },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    if (title != null) Text(title, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                    action?.invoke()
                }
            }
            content()
        }
    }
}

/**
 * The platform's `KpiCard`: a card with the label (and its icon) on top, the
 * figure large and bold in tabular numerals, coloured by [tone], and a muted hint.
 */
@Composable
fun KpiCard(
    label: String,
    value: String,
    modifier: Modifier = Modifier,
    hint: String? = null,
    icon: ImageVector? = null,
    tone: Color? = null,
    tag: String? = null,
    onClick: (() -> Unit)? = null,
) {
    val content: @Composable ColumnScope.() -> Unit = {
        Column(Modifier.padding(Tokens.Spacing.l)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(label, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                if (icon != null) Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(16.dp))
            }
            Text(
                value,
                style = MaterialTheme.typography.headlineSmall.merge(Tabular),
                fontWeight = FontWeight.Bold,
                color = tone ?: MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = Tokens.Spacing.s),
            )
            if (hint != null) Text(hint, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp))
        }
    }
    if (onClick != null) {
        Card(onClick = onClick, modifier = modifier.tagged(tag), content = content)
    } else {
        Card(modifier = modifier.tagged(tag), content = content)
    }
}

/** A titled block of a record's details, on the page (the platform's `PanelSection`). */
@Composable
fun PanelSection(
    title: String? = null,
    modifier: Modifier = Modifier,
    action: (@Composable () -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.s)) {
        if (title != null || action != null) {
            Row(Modifier.fillMaxWidth().heightIn(min = 32.dp), verticalAlignment = Alignment.CenterVertically) {
                if (title != null) Text(title, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                action?.invoke()
            }
        }
        content()
    }
}

/** A hairline between blocks of a page. */
@Composable
fun Hairline(modifier: Modifier = Modifier) = HorizontalDivider(modifier, color = MaterialTheme.colorScheme.outlineVariant)

/** A label and its value on one row. */
@Composable
fun DetailRow(label: String, value: String, valueColor: Color? = null, strong: Boolean = false) {
    Row(Modifier.fillMaxWidth().padding(vertical = 5.dp), horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.l)) {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
        Text(
            value,
            style = MaterialTheme.typography.bodyMedium.merge(Tabular),
            fontWeight = if (strong) FontWeight.SemiBold else FontWeight.Normal,
            color = valueColor ?: MaterialTheme.colorScheme.onSurface,
            textAlign = TextAlign.End,
            modifier = Modifier.weight(1.4f),
        )
    }
}

/**
 * A property of a record, as the platform's object panels list them: the icon
 * and label in a column, the value beside it; a dash when there is none.
 */
@Composable
fun PropertyRow(
    icon: ImageVector,
    label: String,
    value: String?,
    valueColor: Color? = null,
    tag: String? = null,
    content: (@Composable () -> Unit)? = null,
) {
    Row(Modifier.fillMaxWidth().heightIn(min = 36.dp).padding(vertical = 6.dp).tagged(tag), verticalAlignment = Alignment.Top) {
        Row(Modifier.width(132.dp).padding(end = Tokens.Spacing.s), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
            Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(16.dp))
            Text(label, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        Box(Modifier.weight(1f)) {
            when {
                content != null -> content()
                value.isNullOrBlank() -> Text(stringResource(R.string.weldbooks_common_dash), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                else -> Text(value, style = MaterialTheme.typography.bodyMedium.merge(Tabular), color = valueColor ?: MaterialTheme.colorScheme.onSurface)
            }
        }
    }
}

/** Rows of amounts and a total under a rule (the platform's totals: muted labels, a semibold total). */
@Composable
fun TotalsBlock(rows: List<Pair<String, String>>, total: Pair<String, String>, after: List<Triple<String, String, Color?>> = emptyList()) {
    Column(verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
        rows.forEach { (label, value) -> TotalsRow(label, value) }
        Hairline()
        Row(Modifier.fillMaxWidth()) {
            Text(total.first, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            Text(total.second, style = MaterialTheme.typography.bodyLarge.merge(Tabular), fontWeight = FontWeight.SemiBold)
        }
        after.forEach { (label, value, color) ->
            if (color != null) {
                TotalsRow(label, value, color = color)
            } else {
                Row(Modifier.fillMaxWidth()) {
                    Text(label, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                    Text(value, style = MaterialTheme.typography.bodyLarge.merge(Tabular), fontWeight = FontWeight.SemiBold)
                }
            }
        }
    }
}

@Composable
private fun TotalsRow(label: String, value: String, color: Color? = null) {
    Row(Modifier.fillMaxWidth()) {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = color ?: MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
        Text(value, style = MaterialTheme.typography.bodyMedium.merge(Tabular), color = color ?: MaterialTheme.colorScheme.onSurface)
    }
}

/**
 * The small round avatar of a list row (the platform's `RowAvatar`): the
 * initial, or [icon] (a building, a person), on a neutral fill.
 */
@Composable
fun RowAvatar(name: String?, icon: ImageVector? = null, size: Dp = 20.dp) {
    val fill = DayNight(Color(0xFFE5E7EB), Color(0xFF2E3238)).current()
    val ink = Tones.gray.current()
    Box(Modifier.size(size).clip(CircleShape).background(fill), contentAlignment = Alignment.Center) {
        if (icon != null) {
            Icon(icon, contentDescription = null, tint = ink, modifier = Modifier.size(size * 0.6f))
        } else {
            Text(initialsOf(name).take(1), color = ink, style = MaterialTheme.typography.labelSmall.copy(fontSize = (size.value * 0.5f).sp, lineHeight = (size.value * 0.5f).sp))
        }
    }
}

/** A list item's leading icon, as the platform's menus draw them: plain and muted, no tile. */
@Composable
fun ListIcon(icon: ImageVector, tint: Color? = null) =
    Icon(icon, contentDescription = null, tint = tint ?: MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(20.dp))

/**
 * A list row as the platform's WeldBooks lists draw it: a medium title, muted
 * lines under it, the amount and a chip on the right, a hairline under the row.
 */
@Composable
fun RecordRow(
    title: String,
    subtitle: String? = null,
    meta: String? = null,
    amount: String? = null,
    amountColor: Color? = null,
    badge: (@Composable () -> Unit)? = null,
    tag: String? = null,
    leading: (@Composable () -> Unit)? = null,
    divider: Boolean = true,
    onClick: (() -> Unit)? = null,
) {
    Column {
        Row(
            Modifier.fillMaxWidth()
                .let { if (onClick != null) it.clickable(onClick = onClick) else it }
                .padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.m)
                .tagged(tag),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m),
        ) {
            leading?.invoke()
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(title, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (subtitle != null) Text(subtitle, style = secondaryStyle(), color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (meta != null) Text(meta, style = MaterialTheme.typography.bodySmall.merge(Tabular), color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
            }
            if (amount != null || badge != null) {
                Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (amount != null) {
                        Text(amount, style = MaterialTheme.typography.titleSmall.merge(Tabular), color = amountColor ?: MaterialTheme.colorScheme.onSurface, maxLines = 1)
                    }
                    badge?.invoke()
                }
            }
        }
        if (divider) Hairline()
    }
}

/**
 * The header over a group of rows (the platform's list groups, "Overdue 3"):
 * a small muted label and the count in a chip, on a muted band.
 */
@Composable
fun GroupHeader(label: String, count: Int, more: Boolean = false) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Column(Modifier.background(MaterialTheme.colorScheme.background)) {
        Row(
            Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f)).heightIn(min = 32.dp).padding(horizontal = Tokens.Spacing.l),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
        ) {
            Text(label, style = MaterialTheme.typography.labelMedium, color = muted)
            Text(
                if (more) "$count+" else count.toString(),
                style = MaterialTheme.typography.labelSmall.copy(fontSize = 10.sp, fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace),
                color = muted,
                modifier = Modifier
                    .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(5.dp))
                    .border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(5.dp))
                    .padding(horizontal = 4.dp),
            )
        }
        Hairline()
    }
}

/**
 * An empty list or screen, as the platform draws one: the icon in a muted
 * rounded square, a semibold title, a muted line, and the action that fills it.
 */
@Composable
fun BooksEmptyState(
    icon: ImageVector,
    title: String,
    description: String? = null,
    action: String? = null,
    actionTag: String? = null,
    modifier: Modifier = Modifier,
    onAction: (() -> Unit)? = null,
) {
    Column(
        modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.xl, vertical = 48.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
    ) {
        Box(
            Modifier.size(48.dp).background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(Tokens.Radius.large)),
            contentAlignment = Alignment.Center,
        ) { Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(24.dp)) }
        Text(
            title,
            style = MaterialTheme.typography.titleSmall.copy(fontSize = 15.sp),
            fontWeight = FontWeight.SemiBold,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = Tokens.Spacing.s),
        )
        if (description != null) {
            Text(description, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
        }
        if (action != null && onAction != null) {
            Button(onClick = onAction, modifier = Modifier.padding(top = Tokens.Spacing.m).tagged(actionTag)) {
                Icon(Icons.Filled.Add, contentDescription = null, modifier = Modifier.size(16.dp))
                Text(action, modifier = Modifier.padding(start = 6.dp))
            }
        }
    }
}

/** A status as the platform's coloured chip. */
@Composable
fun StatusPill(status: String) {
    StatusBadge(statusLabel(status), Tones.of(Statuses.tone(status)).current())
}

/** A chip in one of the platform's tones (a role, a payment's direction). */
@Composable
fun ToneChip(text: String, tone: DayNight) {
    StatusBadge(text, tone.current())
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

/** The colours of the platform's `InfoBanner` variants: border, fill, text, icon. */
private class BannerColors(val border: DayNight, val fill: DayNight, val text: DayNight, val icon: DayNight)

private val InfoColors = BannerColors(
    DayNight(Color(0xFFBFDBFE), Color(0xFF1E3A8A)),
    DayNight(Color(0xFFEFF6FF), Color(0xFF172554)),
    DayNight(Color(0xFF1E3A8A), Color(0xFFDBEAFE)),
    DayNight(Color(0xFF2563EB), Color(0xFF60A5FA)),
)
private val WarningColors = BannerColors(
    DayNight(Color(0xFFFEF08A), Color(0xFF713F12)),
    DayNight(Color(0xFFFEFCE8), Color(0xFF422006)),
    DayNight(Color(0xFF713F12), Color(0xFFFEF9C3)),
    DayNight(Color(0xFFCA8A04), Color(0xFFFACC15)),
)
private val SuccessColors = BannerColors(
    DayNight(Color(0xFFBBF7D0), Color(0xFF14532D)),
    DayNight(Color(0xFFF0FDF4), Color(0xFF052E16)),
    DayNight(Color(0xFF14532D), Color(0xFFDCFCE7)),
    DayNight(Color(0xFF16A34A), Color(0xFF4ADE80)),
)

/** A notice in the flow of a screen, as the platform's `InfoBanner`: info, success, warning or error. */
@Composable
fun Banner(text: String, tone: String = "info", title: String? = null, onClose: (() -> Unit)? = null, modifier: Modifier = Modifier) {
    val danger = Tokens.Status.danger.current()
    val (border, fill, ink, iconTint) = when (tone) {
        "success" -> SuccessColors.let { listOf(it.border.current(), it.fill.current(), it.text.current(), it.icon.current()) }
        "warning" -> WarningColors.let { listOf(it.border.current(), it.fill.current(), it.text.current(), it.icon.current()) }
        "error" -> listOf(danger.copy(alpha = 0.4f), danger.copy(alpha = 0.1f), danger, danger)
        else -> InfoColors.let { listOf(it.border.current(), it.fill.current(), it.text.current(), it.icon.current()) }
    }
    val icon = when (tone) {
        "success" -> Icons.Outlined.CheckCircle
        "warning", "error" -> Icons.Outlined.WarningAmber
        else -> Icons.Outlined.Info
    }
    val shape = RoundedCornerShape(Tokens.Radius.large)
    Row(
        modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.xs)
            .background(fill, shape)
            .border(1.dp, border, shape)
            .padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.m),
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m),
    ) {
        Icon(icon, contentDescription = null, tint = iconTint, modifier = Modifier.padding(top = 2.dp).size(16.dp))
        Column(Modifier.weight(1f)) {
            if (title != null) Text(title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, color = ink)
            Text(text, style = MaterialTheme.typography.bodyMedium, color = ink)
        }
        if (onClose != null) {
            IconButton(onClick = onClose, modifier = Modifier.size(20.dp)) {
                Icon(Icons.Filled.Close, contentDescription = stringResource(org.weldsuite.core.R.string.core_common_close), tint = ink, modifier = Modifier.size(16.dp))
            }
        }
    }
}

/** A field's label: the platform's `Label`, medium and in the foreground. */
@Composable
fun FieldLabel(text: String) {
    Text(text, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurface)
}

/**
 * The platform's input: a bordered `rounded-md` box, the ring colour while it
 * has focus, the danger colour with an error.
 */
@Composable
fun PlatformInput(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    placeholder: String? = null,
    isError: Boolean = false,
    keyboard: KeyboardType = KeyboardType.Text,
    singleLine: Boolean = true,
    minLines: Int = 1,
    leading: (@Composable () -> Unit)? = null,
    trailing: (@Composable () -> Unit)? = null,
) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    val border = when {
        isError -> MaterialTheme.colorScheme.error
        focused -> Tokens.Palette.ring.current()
        else -> MaterialTheme.colorScheme.outline
    }
    val shape = MaterialTheme.shapes.small
    val textStyle = MaterialTheme.typography.bodyMedium.copy(color = MaterialTheme.colorScheme.onSurface)
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        textStyle = textStyle,
        singleLine = singleLine,
        minLines = if (singleLine) 1 else minLines,
        keyboardOptions = KeyboardOptions(keyboardType = keyboard),
        interactionSource = interaction,
        cursorBrush = SolidColor(MaterialTheme.colorScheme.onSurface),
        modifier = modifier.fillMaxWidth(),
        decorationBox = { inner ->
            Row(
                Modifier.fillMaxWidth().heightIn(min = 44.dp)
                    .background(MaterialTheme.colorScheme.background, shape)
                    .border(1.dp, border, shape)
                    .padding(horizontal = Tokens.Spacing.m, vertical = 10.dp),
                verticalAlignment = if (singleLine) Alignment.CenterVertically else Alignment.Top,
                horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
            ) {
                leading?.invoke()
                Box(Modifier.weight(1f)) {
                    if (value.isEmpty() && placeholder != null) {
                        Text(placeholder, style = textStyle, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = if (singleLine) 1 else Int.MAX_VALUE)
                    }
                    inner()
                }
                trailing?.invoke()
            }
        },
    )
}

/** The line under a field: the error in the danger colour, else the help text, muted. */
@Composable
private fun FieldNote(error: String?, helper: String?) {
    when {
        error != null -> Text(error, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
        helper != null -> Text(helper, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** A text field that fills the width: the label above, an error or help line under it. */
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
    Column(modifier.fillMaxWidth().padding(vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        FieldLabel(label)
        PlatformInput(
            value = value,
            onValueChange = { text -> onChange(if (maxLength != null) text.take(maxLength) else text) },
            placeholder = placeholder,
            isError = error != null,
            keyboard = keyboard,
            singleLine = singleLine,
            minLines = minLines,
            modifier = Modifier.tagged(tag),
        )
        FieldNote(error, helper)
    }
}

/** A choice from a list: the platform's select, opening a menu. */
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
    val current = options.firstOrNull { it.first == value }?.second ?: value.orEmpty()
    val border = if (error != null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.outline
    val shape = MaterialTheme.shapes.small
    Column(modifier.padding(vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        FieldLabel(label)
        ExposedDropdownMenuBox(expanded = open && enabled, onExpandedChange = { if (enabled) open = it }) {
            Row(
                Modifier.fillMaxWidth().heightIn(min = 44.dp)
                    .menuAnchor(MenuAnchorType.PrimaryNotEditable, enabled)
                    .background(if (enabled) MaterialTheme.colorScheme.background else MaterialTheme.colorScheme.surfaceVariant, shape)
                    .border(1.dp, border, shape)
                    .padding(horizontal = Tokens.Spacing.m)
                    .tagged(tag),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    current.ifEmpty { placeholder.orEmpty() },
                    style = MaterialTheme.typography.bodyMedium,
                    color = if (current.isEmpty() || !enabled) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Icon(Icons.Outlined.UnfoldMore, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(16.dp))
            }
            ExposedDropdownMenu(expanded = open && enabled, onDismissRequest = { open = false }) {
                options.forEach { (key, text) ->
                    DropdownMenuItem(
                        text = { Text(text, style = MaterialTheme.typography.bodyMedium) },
                        onClick = {
                            onChange(key)
                            open = false
                        },
                    )
                }
            }
        }
        FieldNote(error, null)
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

/** A calendar day: a field like the others that opens Material's date picker. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DateField(label: String, value: LocalDate, onChange: (LocalDate) -> Unit, error: String? = null, tag: String? = null) {
    val books = LocalBooks.current
    var open by remember { mutableStateOf(false) }
    val shape = MaterialTheme.shapes.small
    Column(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        FieldLabel(label)
        Row(
            Modifier.fillMaxWidth().heightIn(min = 44.dp)
                .clip(shape)
                .background(MaterialTheme.colorScheme.background, shape)
                .border(1.dp, if (error != null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.outline, shape)
                .clickable { open = true }
                .padding(horizontal = Tokens.Spacing.m)
                .tagged(tag),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(formatDay(value, books.locale), style = MaterialTheme.typography.bodyMedium.merge(Tabular), modifier = Modifier.weight(1f))
            Icon(Icons.Outlined.CalendarToday, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(16.dp))
        }
        FieldNote(error, null)
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

/** An "are you sure" dialog, with the platform's buttons: cancel outlined, the action filled (red when destructive). */
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
        title = { Text(title, style = MaterialTheme.typography.titleMedium) },
        text = message?.let { { Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) } },
        confirmButton = {
            Button(
                onClick = onConfirm,
                colors = if (destructive) {
                    ButtonDefaults.buttonColors(containerColor = Tokens.Status.danger.current(), contentColor = Color.White)
                } else {
                    ButtonDefaults.buttonColors()
                },
                modifier = Modifier.tagged("confirm"),
            ) { Text(confirm) }
        },
        dismissButton = { OutlinedButton(onClick = onDismiss, modifier = Modifier.tagged("cancel")) { Text(dismiss) } },
    )
}

/** The label over a group of menu rows: the platform sidebar's group label, small, medium and muted. */
@Composable
fun GroupLabel(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(start = Tokens.Spacing.l, end = Tokens.Spacing.l, top = Tokens.Spacing.l, bottom = Tokens.Spacing.s),
    )
}

/** A spacer for the bottom of a scrolling form. */
@Composable
fun BottomSpace() = Spacer(Modifier.size(Tokens.Spacing.xl))

@Composable
fun HintText(text: String) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 4.dp))
}

@Composable
fun Gap(width: Dp) = Spacer(Modifier.width(width))

