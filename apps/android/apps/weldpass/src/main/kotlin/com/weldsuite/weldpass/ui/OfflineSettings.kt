package com.weldsuite.weldpass.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.weldsuite.weldpass.R
import com.weldsuite.weldpass.offline.OfflineStatus
import com.weldsuite.weldpass.offline.OfflineStore
import kotlinx.coroutines.launch
import org.weldsuite.api.weldpass.models.Device
import org.weldsuite.core.api.ApiException
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged

/**
 * The offline copy in Settings: where it stands, "Sync now" or "Turn on
 * again", and the person's phones with a copy, which they can remove.
 */
@Composable
fun OfflineSettings(offline: OfflineStore) {
    val context = LocalContext.current
    val notify = LocalNotify.current
    val scope = rememberCoroutineScope()
    val state by offline.snapshot.collectAsStateWithLifecycle()
    var devices by remember { mutableStateOf<List<Device>>(emptyList()) }
    var removing by remember { mutableStateOf<Device?>(null) }

    LaunchedEffect(state.status, state.copy?.syncedAt) {
        if (state.status == OfflineStatus.READY) devices = runCatching { offline.devices() }.getOrDefault(devices)
    }

    val copy = state.copy
    val line = when (state.status) {
        OfflineStatus.READY -> when {
            state.syncing -> stringResource(R.string.weldpass_settings_offline_syncing)
            state.offline && copy != null && copy.syncedAt.isNotEmpty() ->
                stringResource(R.string.weldpass_settings_offline_no_connection, formatWhen(copy.syncedAt))
            copy != null && copy.syncedAt.isNotEmpty() ->
                stringResource(R.string.weldpass_settings_offline_ready, formatWhen(copy.syncedAt))
            else -> stringResource(R.string.weldpass_settings_offline_syncing)
        }
        OfflineStatus.LOCKED -> stringResource(R.string.weldpass_settings_offline_locked)
        OfflineStatus.UNAVAILABLE -> stringResource(R.string.weldpass_settings_offline_unavailable)
        OfflineStatus.DISABLED -> stringResource(R.string.weldpass_settings_offline_disabled)
        OfflineStatus.REVOKED -> stringResource(R.string.weldpass_settings_offline_revoked)
        OfflineStatus.OFF -> stringResource(R.string.weldpass_settings_offline_off)
    }

    Column {
        ListItem(
            headlineContent = { Text(stringResource(R.string.weldpass_settings_offline)) },
            supportingContent = { Text(line) },
            trailingContent = {
                when (state.status) {
                    OfflineStatus.READY -> TextButton(
                        onClick = { scope.launch { offline.sync() } },
                        enabled = !state.syncing,
                        modifier = Modifier.tagged("sync-now"),
                    ) { Text(stringResource(R.string.weldpass_settings_sync_now)) }
                    OfflineStatus.REVOKED -> TextButton(
                        onClick = { scope.launch { offline.enableAgain() } },
                        modifier = Modifier.tagged("offline-on-again"),
                    ) { Text(stringResource(R.string.weldpass_settings_turn_on_again)) }
                    else -> Unit
                }
            },
        )
        Text(
            stringResource(R.string.weldpass_settings_offline_footer),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = Tokens.Spacing.l),
        )
        if (devices.isNotEmpty()) {
            Text(
                stringResource(R.string.weldpass_settings_devices),
                style = MaterialTheme.typography.labelLarge,
                modifier = Modifier.padding(start = Tokens.Spacing.l, top = Tokens.Spacing.l),
            )
            devices.forEach { device ->
                val thisPhone = device.id == state.deviceId
                ListItem(
                    headlineContent = { Text(device.name) },
                    supportingContent = {
                        Text(
                            listOfNotNull(
                                if (thisPhone) stringResource(R.string.weldpass_settings_this_phone) else null,
                                device.lastSyncAt?.let { stringResource(R.string.weldpass_settings_last_sync, formatWhen(it)) }
                                    ?: stringResource(R.string.weldpass_settings_never_synced),
                            ).joinToString(" · "),
                        )
                    },
                    trailingContent = if (thisPhone) {
                        null
                    } else {
                        {
                            TextButton(onClick = { removing = device }) {
                                Text(stringResource(R.string.weldpass_settings_remove_device), color = MaterialTheme.colorScheme.error)
                            }
                        }
                    },
                )
            }
        }
    }

    removing?.let { device ->
        AlertDialog(
            onDismissRequest = { removing = null },
            title = { Text(stringResource(R.string.weldpass_settings_remove_device_title, device.name)) },
            text = { Text(stringResource(R.string.weldpass_settings_remove_device_message)) },
            confirmButton = {
                TextButton(onClick = {
                    removing = null
                    scope.launch {
                        try {
                            offline.revoke(device.id)
                            devices = devices.filterNot { it.id == device.id }
                            notify(context.getString(R.string.weldpass_settings_removed))
                        } catch (error: ApiException) {
                            notify(context.getString(passErrorMessage(error)))
                        }
                    }
                }) { Text(stringResource(R.string.weldpass_settings_remove_device), color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = {
                TextButton(onClick = { removing = null }) { Text(stringResource(R.string.weldpass_common_cancel)) }
            },
        )
    }
}
