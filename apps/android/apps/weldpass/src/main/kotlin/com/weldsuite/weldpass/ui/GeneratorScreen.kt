package com.weldsuite.weldpass.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Remove
import org.weldsuite.ui.Button
import org.weldsuite.ui.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import org.weldsuite.ui.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.sp
import com.weldsuite.weldpass.PassForms
import com.weldsuite.weldpass.R
import com.weldsuite.weldpass.SensitiveClipboard
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged

private const val MIN_LENGTH = 8
private const val MAX_LENGTH = 64

/**
 * The password generator, on the phone's SecureRandom. Nothing here is
 * stored or sent; a copy is cleared from the clipboard after 30 seconds.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GeneratorScreen() {
    val context = LocalContext.current
    val notify = LocalNotify.current
    var length by rememberSaveable { mutableIntStateOf(20) }
    var uppercase by rememberSaveable { mutableStateOf(true) }
    var digits by rememberSaveable { mutableStateOf(true) }
    var symbols by rememberSaveable { mutableStateOf(true) }
    var password by rememberSaveable { mutableStateOf("") }
    val regenerate = { password = PassForms.generatePassword(length, uppercase, digits, symbols) }
    LaunchedEffect(length, uppercase, digits, symbols) { regenerate() }

    Scaffold(topBar = { TopAppBar(title = { Text(stringResource(R.string.weldpass_generator_title)) }) }) { padding ->
        Column(
            Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).padding(Tokens.Spacing.l),
            verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.l),
        ) {
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(Tokens.Spacing.l), verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.m)) {
                    Text(
                        password,
                        fontFamily = FontFamily.Monospace,
                        fontSize = 20.sp,
                        modifier = Modifier.tagged("generated-password"),
                    )
                    StrengthMeter(password)
                    Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
                        Button(
                            onClick = {
                                SensitiveClipboard.copySecret(context, password)
                                notify(
                                    context.getString(
                                        R.string.weldpass_item_copied_secret,
                                        context.getString(R.string.weldpass_item_password),
                                    ),
                                )
                            },
                            modifier = Modifier.weight(1f).tagged("copy-generated"),
                        ) { Text(stringResource(R.string.weldpass_generator_copy)) }
                        OutlinedButton(onClick = regenerate, modifier = Modifier.weight(1f)) {
                            Icon(Icons.Filled.Refresh, contentDescription = null)
                            Text(stringResource(R.string.weldpass_generator_regenerate))
                        }
                    }
                }
            }

            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.weldpass_generator_length), modifier = Modifier.weight(1f))
                IconButton(onClick = { length = (length - 1).coerceAtLeast(MIN_LENGTH) }, enabled = length > MIN_LENGTH) {
                    Icon(Icons.Filled.Remove, contentDescription = stringResource(R.string.weldpass_generator_shorter))
                }
                Text("$length", style = MaterialTheme.typography.titleMedium)
                IconButton(onClick = { length = (length + 1).coerceAtMost(MAX_LENGTH) }, enabled = length < MAX_LENGTH) {
                    Icon(Icons.Filled.Add, contentDescription = stringResource(R.string.weldpass_generator_longer))
                }
            }
            Toggle(R.string.weldpass_generator_uppercase, uppercase) { uppercase = it }
            Toggle(R.string.weldpass_generator_digits, digits) { digits = it }
            Toggle(R.string.weldpass_generator_symbols, symbols) { symbols = it }
            Text(
                stringResource(R.string.weldpass_generator_hint),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun Toggle(label: Int, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(stringResource(label), modifier = Modifier.weight(1f))
        Switch(checked = checked, onCheckedChange = onChange)
    }
}
