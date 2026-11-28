package com.weldsuite.welddesk.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.SmartToy
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.SubcomposeAsyncImage
import org.weldsuite.ui.DayNight
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.avatarColor
import org.weldsuite.ui.tagged

// WeldDesk's pieces of the web platform's look that `:ui` doesn't have (yet):
// the single-initial avatar of its conversation list and timeline, the outline
// toggles of its filter popover, its search input, the date group header, and
// the empty and error state with the icon on a muted square.

/** The Tailwind colours WeldDesk's platform screens use, by what they mark. */
object DeskColors {
    /** `bg-blue-600`: the unread dot. */
    val unread = Color(0xFF2563EB)
    val urgent = Color(0xFFDC2626)
    val high = Color(0xFFEA580C)
    /** Tags (`#475569`). */
    val tag = Color(0xFF475569)
    val email = Color(0xFF0F766E)
    val phone = Color(0xFF1D4ED8)
    val portal = Color(0xFFB45309)
    val api = Color(0xFF7C3AED)
    val unassigned = Color(0xFF6B7280)
    val waiting = Color(0xFF2563EB)
    val slaOk = Color(0xFF0F766E)
    val slaWarning = Color(0xFFD97706)
    val slaBreached = Color(0xFFDC2626)
    val slaMuted = Color(0xFF6B7280)

    /** `emerald-500` dot, `emerald-700` / `emerald-400` text: the visitor is online. */
    val onlineDot = Color(0xFF10B981)
    val onlineText = DayNight(Color(0xFF047857), Color(0xFF34D399))

    /** An agent's bubble: `indigo-100`, dark `indigo-500/20`. */
    val agentBubble = DayNight(Color(0xFFE0E7FF), Color(0xFF6366F1).copy(alpha = 0.2f))
    val agentText = DayNight(Color(0xFF111827), Color(0xFFFFFFFF))
    val agentMeta = DayNight(Color(0xFF6B7280), Color(0xFFB5BDC9))

    /** An internal note: `amber-50` with an `amber-200` border, dark `amber-950/30` and `amber-900`. */
    val noteBubble = DayNight(Color(0xFFFFFBEB), Color(0xFF451A03).copy(alpha = 0.3f))
    val noteBorder = DayNight(Color(0xFFFDE68A), Color(0xFF78350F))
    val noteText = DayNight(Color(0xFF451A03), Color(0xFFFEF3C7))
    val noteMeta = DayNight(Color(0xFFB45309), Color(0xFFFBBF24))
    /** The composer while it writes a note: `amber-50/60`, dark `amber-950/20`. */
    val noteComposer = DayNight(Color(0xFFFFFBEB).copy(alpha = 0.6f), Color(0xFF451A03).copy(alpha = 0.2f))

    /** SLA lines in the timeline: `amber-600` / `amber-400`, `red-600` / `red-400`. */
    val slaWarningLine = DayNight(Color(0xFFD97706), Color(0xFFFBBF24))
    val slaBreachedLine = DayNight(Color(0xFFDC2626), Color(0xFFF87171))

    /** The SLA chip in the header, per tone: background and text. */
    val slaChipOk = DayNight(Color(0xFFF0FDFA), Color(0xFF042F2E).copy(alpha = 0.4f)) to DayNight(Color(0xFF0F766E), Color(0xFF2DD4BF))
    val slaChipWarning = DayNight(Color(0xFFFFFBEB), Color(0xFF451A03).copy(alpha = 0.4f)) to DayNight(Color(0xFFB45309), Color(0xFFFBBF24))
    val slaChipBreached = DayNight(Color(0xFFFEF2F2), Color(0xFF450A0A).copy(alpha = 0.4f)) to DayNight(Color(0xFFB91C1C), Color(0xFFF87171))
}

/** The first letter of a name, as the platform's list and timeline avatars show it. */
fun initialOf(name: String?): String = name?.trim()?.firstOrNull()?.uppercase() ?: "?"

/**
 * A person's picture, or the first letter of their name in white on the
 * platform's avatar colour for that name (`bot`: a robot instead).
 */
@Composable
fun InitialAvatar(name: String, url: String? = null, size: Dp = 28.dp, bot: Boolean = false, modifier: Modifier = Modifier) {
    val box = modifier.size(size).clip(CircleShape).clearAndSetSemantics { }
    val fallback: @Composable () -> Unit = {
        Box(Modifier.size(size).background(avatarColor(name)), contentAlignment = Alignment.Center) {
            if (bot) {
                Icon(Icons.Outlined.SmartToy, contentDescription = null, tint = Color.White, modifier = Modifier.size(size * 0.5f))
            } else {
                Text(initialOf(name), color = Color.White, fontWeight = FontWeight.SemiBold, fontSize = (size.value * 0.43f).sp)
            }
        }
    }
    if (url.isNullOrBlank()) {
        Box(box) { fallback() }
    } else {
        SubcomposeAsyncImage(
            model = url,
            contentDescription = null,
            contentScale = ContentScale.Crop,
            modifier = box,
            loading = { fallback() },
            error = { fallback() },
        )
    }
}

/**
 * The platform's outline toggle (`Toggle variant="outline" size="sm"`):
 * bordered, `rounded-md`, filled with the primary colour while on.
 */
@Composable
fun DeskToggle(label: String, selected: Boolean, tag: String, onClick: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    val fill = if (selected) colors.primary else Color.Transparent
    val border = if (selected) colors.primary else colors.outline
    Box(
        Modifier
            .height(30.dp)
            .clip(RoundedCornerShape(Tokens.Radius.medium))
            .background(fill)
            .border(BorderStroke(1.dp, border), RoundedCornerShape(Tokens.Radius.medium))
            .clickable(role = Role.Tab, onClick = onClick)
            .semantics { this.selected = selected }
            .padding(horizontal = 10.dp)
            .tagged(tag),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            style = MaterialTheme.typography.labelMedium,
            color = if (selected) colors.onPrimary else colors.onSurface,
            maxLines = 1,
        )
    }
}

/** The platform's outline button at toggle size, with a leading icon (the sort). */
@Composable
fun DeskOutlineChip(label: String, icon: ImageVector, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    Row(
        modifier
            .height(30.dp)
            .clip(RoundedCornerShape(Tokens.Radius.medium))
            .border(BorderStroke(1.dp, colors.outline), RoundedCornerShape(Tokens.Radius.medium))
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Icon(icon, contentDescription = null, tint = colors.onSurfaceVariant, modifier = Modifier.size(14.dp))
        Text(label, style = MaterialTheme.typography.labelMedium, color = colors.onSurface, maxLines = 1)
    }
}

/** The platform's search input: a bordered `rounded-md` field with the search icon, 14sp. */
@Composable
fun DeskSearchField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    clearLabel: String,
    modifier: Modifier = Modifier,
    tag: String? = null,
    clearTag: String? = null,
) {
    val colors = MaterialTheme.colorScheme
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        singleLine = true,
        textStyle = MaterialTheme.typography.bodyMedium.copy(color = colors.onSurface),
        cursorBrush = SolidColor(colors.onSurface),
        modifier = modifier.tagged(tag),
        decorationBox = { field ->
            Row(
                Modifier
                    .fillMaxWidth()
                    .height(40.dp)
                    .border(BorderStroke(1.dp, colors.outlineVariant), RoundedCornerShape(Tokens.Radius.medium))
                    .background(colors.background, RoundedCornerShape(Tokens.Radius.medium))
                    .padding(start = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
            ) {
                Icon(Icons.Outlined.Search, contentDescription = null, tint = colors.onSurfaceVariant, modifier = Modifier.size(16.dp))
                Box(Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
                    if (value.isEmpty()) {
                        Text(
                            placeholder,
                            style = MaterialTheme.typography.bodyMedium,
                            color = colors.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    field()
                }
                if (value.isNotEmpty()) {
                    IconButton(onClick = { onValueChange("") }, modifier = Modifier.size(40.dp).tagged(clearTag)) {
                        Icon(Icons.Outlined.Close, contentDescription = clearLabel, tint = colors.onSurfaceVariant, modifier = Modifier.size(16.dp))
                    }
                }
            }
        },
    )
}

/**
 * A date group's header in the conversation list ("Last week 2"): a muted
 * band between hairlines, its label and a count in a small mono badge.
 */
@Composable
fun GroupHeader(label: String, count: Int, modifier: Modifier = Modifier) {
    val colors = MaterialTheme.colorScheme
    Column(modifier.fillMaxWidth()) {
        Box(Modifier.fillMaxWidth().height(1.dp).background(colors.outlineVariant.copy(alpha = 0.7f)))
        Row(
            Modifier
                .fillMaxWidth()
                .height(32.dp)
                .background(colors.surfaceVariant.copy(alpha = 0.5f))
                .padding(horizontal = Tokens.Spacing.m),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
        ) {
            Text(label, style = MaterialTheme.typography.labelMedium, color = colors.onSurfaceVariant, maxLines = 1)
            Box(
                Modifier
                    .heightIn(min = 16.dp)
                    .widthIn(min = 16.dp)
                    .background(colors.surfaceVariant, RoundedCornerShape(5.dp))
                    .border(BorderStroke(1.dp, colors.outlineVariant), RoundedCornerShape(5.dp))
                    .padding(horizontal = 3.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(count.toString(), fontSize = 10.sp, lineHeight = 14.sp, fontFamily = FontFamily.Monospace, color = colors.onSurfaceVariant)
            }
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(colors.outlineVariant.copy(alpha = 0.7f)))
    }
}

/**
 * An empty or failed list, as the platform draws one: the icon on a muted
 * rounded square, a semibold title, a muted description, and an action.
 */
@Composable
fun DeskEmptyState(
    icon: ImageVector,
    title: String,
    description: String?,
    modifier: Modifier = Modifier,
    iconTint: Color = MaterialTheme.colorScheme.onSurfaceVariant,
    iconBackground: Color = MaterialTheme.colorScheme.surfaceVariant,
    action: (@Composable () -> Unit)? = null,
) {
    Column(
        modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.xl, vertical = 56.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
    ) {
        Box(
            Modifier.size(44.dp).background(iconBackground, RoundedCornerShape(Tokens.Radius.large)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, contentDescription = null, tint = iconTint, modifier = Modifier.size(20.dp))
        }
        Text(title, style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.SemiBold), textAlign = TextAlign.Center, modifier = Modifier.padding(top = Tokens.Spacing.xs))
        if (description != null) {
            Text(
                description,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
        }
        if (action != null) {
            Box(Modifier.padding(top = Tokens.Spacing.s)) { action() }
        }
    }
}
