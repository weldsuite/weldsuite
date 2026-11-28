package com.weldsuite.weldmail.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.AddCircleOutline
import androidx.compose.material.icons.outlined.CloudSync
import androidx.compose.material.icons.outlined.Unsubscribe
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.weldsuite.weldmail.MailStore
import com.weldsuite.weldmail.R
import kotlinx.coroutines.launch
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.R as CoreR
import org.weldsuite.core.SessionState
import org.weldsuite.ui.AppearancePreference
import org.weldsuite.ui.SettingsHeader
import org.weldsuite.ui.commonSettingsItems
import org.weldsuite.ui.tagged

/** WeldMail's own settings (new mailboxes, subscriptions, the offline outbox), then the shared ones. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    env: AppEnvironment,
    store: MailStore,
    session: SessionState.Ready,
    appearance: AppearancePreference,
    onSwitchWorkspace: () -> Unit,
    onSubscriptions: () -> Unit,
    onAddAccount: () -> Unit,
) {
    val pending by store.pending.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val appName = stringResource(R.string.weldmail_app_name)
    val canAdd = env.isAvailable("mail-free-addresses") || env.isAvailable("mail-domains")
    Scaffold(topBar = { TopAppBar(title = { Text(stringResource(CoreR.string.core_settings_title)) }) }) { padding ->
        LazyColumn(Modifier.padding(padding).fillMaxSize().tagged("settings-list")) {
            item("mail") {
                SettingsHeader(stringResource(R.string.weldmail_settings_mail))
                if (canAdd) {
                    ListItem(
                        headlineContent = { Text(stringResource(R.string.weldmail_settings_add_account)) },
                        leadingContent = { Icon(Icons.Outlined.AddCircleOutline, contentDescription = null) },
                        trailingContent = { Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, contentDescription = null) },
                        modifier = Modifier.clickable(onClick = onAddAccount).tagged("settings-add-account"),
                    )
                }
                ListItem(
                    headlineContent = { Text(stringResource(R.string.weldmail_settings_subscriptions)) },
                    leadingContent = { Icon(Icons.Outlined.Unsubscribe, contentDescription = null) },
                    trailingContent = { Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, contentDescription = null) },
                    modifier = Modifier.clickable(onClick = onSubscriptions).tagged("settings-subscriptions"),
                )
                ListItem(
                    headlineContent = { Text(stringResource(R.string.weldmail_settings_outbox)) },
                    supportingContent = {
                        Text(
                            if (pending == 0) {
                                stringResource(R.string.weldmail_settings_outbox_empty)
                            } else {
                                pluralStringResource(R.plurals.weldmail_settings_outbox_waiting, pending, pending)
                            } + "\n" + stringResource(R.string.weldmail_settings_outbox_description),
                        )
                    },
                    leadingContent = { Icon(Icons.Outlined.CloudSync, contentDescription = null) },
                    trailingContent = {
                        if (pending > 0) {
                            TextButton(onClick = { scope.launch { store.flush() } }, modifier = Modifier.tagged("settings-sync-now")) {
                                Text(stringResource(R.string.weldmail_settings_send_now))
                            }
                        }
                    },
                    modifier = Modifier.tagged("settings-outbox"),
                )
            }
            commonSettingsItems(
                env = env,
                appName = appName,
                person = session.person,
                workspace = session.workspace,
                workspaces = session.workspaces,
                appearance = appearance,
                onSwitchWorkspace = onSwitchWorkspace,
            )
        }
    }
}
