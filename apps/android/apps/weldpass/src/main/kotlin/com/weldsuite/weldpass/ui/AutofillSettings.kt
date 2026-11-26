package com.weldsuite.weldpass.ui

import android.content.Intent
import android.provider.Settings
import android.view.autofill.AutofillManager
import androidx.compose.material3.ListItem
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.core.net.toUri
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.weldsuite.weldpass.R
import com.weldsuite.weldpass.offline.OfflineStore
import org.weldsuite.ui.tagged

/**
 * Autofill in Settings: whether WeldPass is the phone's autofill service,
 * with a way to turn it on. It reads the offline copy, so it needs one.
 */
@Composable
fun AutofillSettings(offline: OfflineStore) {
    // Android's autofill framework came with Android 8.
    if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.O) return
    val context = LocalContext.current
    val state by offline.snapshot.collectAsStateWithLifecycle()
    var enabled by remember { mutableStateOf(isOurs(context)) }
    // Back from the system's autofill settings: read it again.
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { enabled = isOurs(context) }

    val line = when {
        state.readable == null -> stringResource(R.string.weldpass_settings_autofill_needs_copy)
        enabled -> stringResource(R.string.weldpass_settings_autofill_on)
        else -> stringResource(R.string.weldpass_settings_autofill_off)
    }
    ListItem(
        headlineContent = { Text(stringResource(R.string.weldpass_settings_autofill)) },
        supportingContent = { Text(line) },
        trailingContent = if (!enabled) {
            {
                TextButton(
                    onClick = {
                        context.startActivity(
                            Intent(Settings.ACTION_REQUEST_SET_AUTOFILL_SERVICE).setData("package:${context.packageName}".toUri()),
                        )
                    },
                    modifier = Modifier.tagged("autofill-turn-on"),
                ) { Text(stringResource(R.string.weldpass_settings_autofill_turn_on)) }
            }
        } else {
            null
        },
    )
}

@androidx.annotation.RequiresApi(android.os.Build.VERSION_CODES.O)
private fun isOurs(context: android.content.Context): Boolean =
    runCatching { context.getSystemService(AutofillManager::class.java)?.hasEnabledAutofillServices() == true }
        .getOrDefault(false)
