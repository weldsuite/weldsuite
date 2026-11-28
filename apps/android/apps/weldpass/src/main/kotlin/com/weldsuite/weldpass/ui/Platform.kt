package com.weldsuite.weldpass.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import com.weldsuite.weldpass.R
import kotlinx.coroutines.launch
import org.weldsuite.ui.Button
import org.weldsuite.ui.DayNight
import org.weldsuite.ui.StatusBadge
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged

// The web platform's building blocks that WeldPass needs and `:ui` doesn't
// have yet: the list's group header, the empty state, labelled inputs and
// read-only fields, and the copy button. Candidates for `:ui`.

/** Tailwind colours the platform's WeldPass code uses by name. */
object PassColors {
    /** `text-emerald-500`: the copy button's check. */
    val copied = Color(0xFF10B981)

    /** `bg-red-500`, `bg-amber-500`, `bg-emerald-500`: the strength meter's bars. */
    val weakBar = Color(0xFFEF4444)
    val fairBar = Color(0xFFF59E0B)
    val strongBar = Color(0xFF10B981)

    /** `text-red-600 dark:text-red-400` and the amber and emerald pairs: the strength word. */
    val weakText = DayNight(Color(0xFFDC2626), Color(0xFFF87171))
    val fairText = DayNight(Color(0xFFD97706), Color(0xFFFBBF24))
    val strongText = DayNight(Color(0xFF059669), Color(0xFF34D399))
}

/** Secondary text: 13, muted. */
@Composable
fun secondaryTextStyle(): TextStyle = MaterialTheme.typography.bodyMedium.copy(fontSize = 13.sp, lineHeight = 18.sp)

/** The list's hairline between rows (`border-b border-border/70`). */
@Composable
fun RowDivider(modifier: Modifier = Modifier) {
    HorizontalDivider(modifier, thickness = 0.5.dp, color = MaterialTheme.colorScheme.outlineVariant)
}

/**
 * A group's header in a list, as `EntityList` draws it: a small muted label
 * and its count in a bordered chip, on a muted band.
 */
@Composable
fun GroupHeader(label: String, count: Int, modifier: Modifier = Modifier) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Column(modifier.fillMaxWidth()) {
        Row(
            Modifier
                .fillMaxWidth()
                .background(MaterialTheme.colorScheme.background)
                .background(Tokens.Palette.muted.current().copy(alpha = 0.5f))
                .height(32.dp)
                .padding(horizontal = Tokens.Spacing.l),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
        ) {
            Text(label, style = MaterialTheme.typography.labelMedium, color = muted, maxLines = 1)
            Box(
                Modifier
                    .heightIn(min = 16.dp)
                    .widthIn(min = 16.dp)
                    .background(Tokens.Palette.muted.current(), RoundedCornerShape(5.dp))
                    .border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(5.dp))
                    .padding(horizontal = 4.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text("$count", fontFamily = FontFamily.Monospace, fontSize = 10.sp, lineHeight = 14.sp, color = muted)
            }
        }
        RowDivider()
    }
}

/**
 * What a list shows when it has nothing: the icon in a muted rounded square,
 * a semibold title, a muted description and, maybe, the main action.
 */
@Composable
fun EmptyMessage(
    icon: ImageVector,
    title: String,
    modifier: Modifier = Modifier,
    description: String? = null,
    action: Pair<String, () -> Unit>? = null,
    actionTag: String? = null,
) {
    Column(
        modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.xl, vertical = 48.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(
            Modifier.size(48.dp).background(Tokens.Palette.muted.current(), RoundedCornerShape(Tokens.Radius.large)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(24.dp))
        }
        Text(
            title,
            style = MaterialTheme.typography.titleMedium.copy(fontSize = 15.sp),
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = Tokens.Spacing.l),
        )
        if (description != null) {
            Text(
                description,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
                modifier = Modifier.widthIn(max = 320.dp).padding(top = 6.dp),
            )
        }
        if (action != null) {
            Button(onClick = action.second, modifier = Modifier.padding(top = Tokens.Spacing.l).tagged(actionTag)) {
                Text(action.first)
            }
        }
    }
}

/** A neutral badge: the platform's `secondary` variant. */
@Composable
fun NeutralBadge(text: String, modifier: Modifier = Modifier) {
    StatusBadge(text, MaterialTheme.colorScheme.onSurfaceVariant, modifier)
}

/** A field's label (`Label`, `FormLabel`): 14, medium. */
@Composable
fun FieldLabel(text: String, modifier: Modifier = Modifier) {
    Text(text, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurface, modifier = modifier)
}

/** A field's hint or error under it (`FormDescription`, `FormMessage`). */
@Composable
fun FieldHint(text: String, error: Boolean = false) {
    Text(
        text,
        style = secondaryTextStyle(),
        color = if (error) Tokens.Status.danger.current() else MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

/** A label, the control under it, and a hint or error under that, as the platform's forms stack them. */
@Composable
fun LabeledField(
    label: String,
    modifier: Modifier = Modifier,
    hint: String? = null,
    error: String? = null,
    content: @Composable () -> Unit,
) {
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
        FieldLabel(label)
        content()
        when {
            error != null -> FieldHint(error, error = true)
            hint != null -> FieldHint(hint)
        }
    }
}

/** An input's background: none, or a wash of the input colour when dark (`dark:bg-input/30`). */
@Composable
private fun inputBackground(): Color =
    DayNight(Color.Transparent, Tokens.Palette.input.dark.copy(alpha = 0.3f)).current()

/** The box every input and read-only value sits in: `rounded-md`, `border-input`. */
private fun Modifier.inputBox(border: Color, background: Color, shape: Shape): Modifier = this
    .heightIn(min = 40.dp)
    .background(background, shape)
    .border(1.dp, border, shape)

/**
 * The platform's `Input` and `Textarea`: a bordered `rounded-md` box with the
 * text at 14, the ring colour around it while focused and the danger colour on
 * an error. Actions sit inside its right edge.
 */
@Composable
fun PlatformTextField(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    placeholder: String? = null,
    singleLine: Boolean = true,
    minLines: Int = 1,
    monospace: Boolean = false,
    isError: Boolean = false,
    visualTransformation: VisualTransformation = VisualTransformation.None,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    leading: (@Composable () -> Unit)? = null,
    trailing: (@Composable RowScope.() -> Unit)? = null,
) {
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    val border = when {
        isError -> Tokens.Status.danger.current()
        focused -> Tokens.Palette.ring.current()
        else -> MaterialTheme.colorScheme.outline
    }
    val style = MaterialTheme.typography.bodyMedium.copy(
        color = MaterialTheme.colorScheme.onSurface,
        fontFamily = if (monospace) FontFamily.Monospace else MaterialTheme.typography.bodyMedium.fontFamily,
    )
    val background = inputBackground()
    val shape = MaterialTheme.shapes.small
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = modifier.fillMaxWidth(),
        textStyle = style,
        singleLine = singleLine,
        minLines = if (singleLine) 1 else minLines,
        visualTransformation = visualTransformation,
        keyboardOptions = keyboardOptions,
        interactionSource = interaction,
        cursorBrush = SolidColor(MaterialTheme.colorScheme.onSurface),
        decorationBox = { inner ->
            Row(
                Modifier.fillMaxWidth().inputBox(border, background, shape)
                    .padding(start = Tokens.Spacing.m, end = if (trailing != null) 2.dp else Tokens.Spacing.m),
                verticalAlignment = if (singleLine) Alignment.CenterVertically else Alignment.Top,
            ) {
                if (leading != null) {
                    Box(Modifier.padding(end = Tokens.Spacing.s)) { leading() }
                }
                Box(Modifier.weight(1f).padding(vertical = 10.dp)) {
                    if (value.isEmpty() && placeholder != null) {
                        Text(placeholder, style = style, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                    }
                    inner()
                }
                trailing?.invoke(this)
            }
        },
    )
}

/**
 * A value shown the way the platform's item dialog shows one: a read-only
 * input, with its actions inside the right edge. Not selectable, so a secret
 * only leaves through the copy button and its 30-second clipboard.
 */
@Composable
fun ReadOnlyField(
    label: String,
    value: String,
    modifier: Modifier = Modifier,
    monospace: Boolean = false,
    multiline: Boolean = false,
    actions: (@Composable RowScope.() -> Unit)? = null,
) {
    LabeledField(label, modifier) {
        Row(
            Modifier.fillMaxWidth().inputBox(MaterialTheme.colorScheme.outline, inputBackground(), MaterialTheme.shapes.small)
                .padding(start = Tokens.Spacing.m, end = if (actions != null) 2.dp else Tokens.Spacing.m),
            verticalAlignment = if (multiline) Alignment.Top else Alignment.CenterVertically,
        ) {
            Text(
                value.ifEmpty { stringResource(R.string.weldpass_common_dash) },
                style = MaterialTheme.typography.bodyMedium,
                fontFamily = if (monospace) FontFamily.Monospace else null,
                color = if (value.isEmpty()) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
                maxLines = if (multiline) Int.MAX_VALUE else 1,
                modifier = Modifier.weight(1f).padding(vertical = 10.dp),
            )
            actions?.invoke(this)
        }
    }
}

/** A small icon button for inside a field (`size="icon-xs"`). */
@Composable
fun FieldIconButton(
    icon: ImageVector,
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    tint: Color = MaterialTheme.colorScheme.onSurfaceVariant,
) {
    IconButton(onClick = onClick, enabled = enabled, modifier = modifier.size(36.dp)) {
        Icon(icon, contentDescription = label, tint = tint, modifier = Modifier.size(18.dp))
    }
}

/**
 * Copy, as the platform's `CopyButton`: the icon turns into a green check for
 * a moment after a copy. [onCopy] returns whether something was copied.
 */
@Composable
fun CopyIconButton(label: String, modifier: Modifier = Modifier, onCopy: suspend () -> Boolean) {
    var copied by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val copy by rememberUpdatedState(onCopy)
    FieldIconButton(
        icon = if (copied) Icons.Filled.Check else Icons.Outlined.ContentCopy,
        label = label,
        onClick = {
            scope.launch {
                busy = true
                val done = try {
                    copy()
                } finally {
                    busy = false
                }
                if (done) {
                    copied = true
                    delay(1_500)
                    copied = false
                }
            }
        },
        enabled = !busy,
        tint = if (copied) PassColors.copied else MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = modifier,
    )
}

/** Medium-weight text in a row's title: 15. */
@Composable
fun rowTitleStyle(): TextStyle = MaterialTheme.typography.titleSmall.copy(fontSize = 15.sp, fontWeight = FontWeight.Medium)
