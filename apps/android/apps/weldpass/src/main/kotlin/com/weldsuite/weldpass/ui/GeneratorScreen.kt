package com.weldsuite.weldpass.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.weldsuite.weldpass.PassForms
import com.weldsuite.weldpass.R
import com.weldsuite.weldpass.SensitiveClipboard
import com.weldsuite.weldpass.Strength
import org.weldsuite.ui.Button
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged
import kotlin.math.roundToInt

private const val MIN_LENGTH = 8
private const val MAX_LENGTH = 64

/** The generator's choices, as the platform's (`GeneratePasswordOptions`). */
data class GeneratorOptions(
    val length: Int = 20,
    val uppercase: Boolean = true,
    val digits: Boolean = true,
    val symbols: Boolean = true,
) {
    fun generate(): String = PassForms.generatePassword(length, uppercase, digits, symbols)
}

/**
 * The password generator tab, on the phone's SecureRandom, laid out as the
 * platform's generator panel. Nothing here is stored or sent; a copy is
 * cleared from the clipboard after 30 seconds, and the password on screen is
 * replaced when the app goes to the background.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GeneratorScreen() {
    val context = LocalContext.current
    val notify = LocalNotify.current
    var options by remember { mutableStateOf(GeneratorOptions()) }
    var password by remember { mutableStateOf(options.generate()) }
    val update: (GeneratorOptions) -> Unit = { next ->
        options = next
        password = next.generate()
    }

    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_STOP) password = options.generate()
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }

    Scaffold(topBar = { TopAppBar(title = { Text(stringResource(R.string.weldpass_generator_title)) }) }) { padding ->
        Column(
            Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).padding(Tokens.Spacing.l),
            verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.l),
        ) {
            GeneratorBox {
                GeneratedPassword(password, fontSize = 16, onRegenerate = { password = options.generate() })
                StrengthMeter(password)
                GeneratorControls(options, update)
            }
            Button(
                onClick = {
                    SensitiveClipboard.copySecret(context, password)
                    notify(context.getString(R.string.weldpass_item_copied_secret, context.getString(R.string.weldpass_item_password)))
                },
                modifier = Modifier.fillMaxWidth().tagged("copy-generated"),
            ) { Text(stringResource(R.string.weldpass_generator_copy)) }
            Text(
                stringResource(R.string.weldpass_generator_hint),
                style = secondaryTextStyle(),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/**
 * The generator inside the item form, as the platform's: a fresh password
 * with every change, then Cancel or "Use this password".
 */
@Composable
fun GeneratorPanel(onUse: (String) -> Unit, onCancel: () -> Unit) {
    var options by remember { mutableStateOf(GeneratorOptions()) }
    var generated by remember { mutableStateOf(options.generate()) }
    GeneratorBox {
        GeneratedPassword(generated, fontSize = 13, onRegenerate = { generated = options.generate() })
        StrengthMeter(generated)
        GeneratorControls(options) { next ->
            options = next
            generated = next.generate()
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s, Alignment.End)) {
            TextButton(onClick = onCancel) {
                Text(stringResource(R.string.weldpass_common_cancel), color = MaterialTheme.colorScheme.onSurface)
            }
            Button(onClick = { onUse(generated) }, modifier = Modifier.tagged("use-generated")) {
                Text(stringResource(R.string.weldpass_generator_use))
            }
        }
    }
}

/** The generator's panel: `rounded-md border bg-muted/30 p-3`. */
@Composable
private fun GeneratorBox(content: @Composable () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant, MaterialTheme.shapes.small)
            .background(Tokens.Palette.muted.current().copy(alpha = 0.3f), MaterialTheme.shapes.small)
            .padding(Tokens.Spacing.m),
        verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.m),
    ) { content() }
}

/** The password in monospace on the background, with "Generate another" beside it. */
@Composable
private fun GeneratedPassword(password: String, fontSize: Int, onRegenerate: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
        Text(
            password,
            fontFamily = FontFamily.Monospace,
            fontSize = fontSize.sp,
            color = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier
                .weight(1f)
                .background(MaterialTheme.colorScheme.background, RoundedCornerShape(Tokens.Radius.small))
                .padding(horizontal = Tokens.Spacing.s, vertical = 6.dp)
                .tagged("generated-password"),
        )
        FieldIconButton(Icons.Filled.Refresh, stringResource(R.string.weldpass_generator_regenerate), onClick = onRegenerate, modifier = Modifier.tagged("regenerate"))
    }
}

/** "Length: 20" over a slider, and the three kinds of character as checkboxes. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun GeneratorControls(options: GeneratorOptions, onChange: (GeneratorOptions) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.xs)) {
        Text(
            stringResource(R.string.weldpass_generator_length, options.length),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurface,
        )
        Slider(
            value = options.length.toFloat(),
            onValueChange = { value ->
                val length = value.roundToInt().coerceIn(MIN_LENGTH, MAX_LENGTH)
                if (length != options.length) onChange(options.copy(length = length))
            },
            valueRange = MIN_LENGTH.toFloat()..MAX_LENGTH.toFloat(),
            modifier = Modifier.tagged("generator-length"),
        )
    }
    FlowRow(horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.l)) {
        Option(R.string.weldpass_generator_uppercase, options.uppercase) { onChange(options.copy(uppercase = it)) }
        Option(R.string.weldpass_generator_digits, options.digits) { onChange(options.copy(digits = it)) }
        Option(R.string.weldpass_generator_symbols, options.symbols) { onChange(options.copy(symbols = it)) }
    }
}

@Composable
private fun Option(label: Int, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(
        Modifier.toggleable(value = checked, role = Role.Checkbox, onValueChange = onChange),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Checkbox(checked = checked, onCheckedChange = null, modifier = Modifier.padding(end = Tokens.Spacing.s).height(40.dp))
        Text(stringResource(label), style = secondaryTextStyle(), color = MaterialTheme.colorScheme.onSurface)
    }
}

/**
 * How strong a password is, as the platform's meter: three bars filled red,
 * amber or green, and the word beside them.
 */
@Composable
fun StrengthMeter(password: String) {
    if (password.isEmpty()) return
    val (filled, bar, text, label) = when (PassForms.strength(password)) {
        Strength.WEAK -> Meter(1, PassColors.weakBar, PassColors.weakText.current(), R.string.weldpass_strength_weak)
        Strength.FAIR -> Meter(2, PassColors.fairBar, PassColors.fairText.current(), R.string.weldpass_strength_fair)
        Strength.STRONG -> Meter(3, PassColors.strongBar, PassColors.strongText.current(), R.string.weldpass_strength_strong)
    }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
        Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.xs)) {
            repeat(3) { index ->
                Box(
                    Modifier
                        .weight(1f)
                        .height(4.dp)
                        .background(if (index < filled) bar else Tokens.Palette.muted.current(), CircleShape),
                )
            }
        }
        Text(stringResource(label), style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Medium, color = text)
    }
}

private data class Meter(
    val filled: Int,
    val bar: androidx.compose.ui.graphics.Color,
    val text: androidx.compose.ui.graphics.Color,
    val label: Int,
)
