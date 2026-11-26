package com.weldsuite.weldpass.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import com.weldsuite.weldpass.BuildConfig
import com.weldsuite.weldpass.PassRepository
import com.weldsuite.weldpass.R
import kotlinx.coroutines.launch
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.SessionState
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.WorkspacePicker
import org.weldsuite.ui.tagged

/** The workspace, the server, the lock and the account. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(env: AppEnvironment, repository: PassRepository, session: SessionState.Ready, onHealth: () -> Unit) {
    val scope = rememberCoroutineScope()
    var confirmSignOut by remember { mutableStateOf(false) }
    var switching by remember { mutableStateOf(false) }

    Scaffold(topBar = { TopAppBar(title = { Text(stringResource(R.string.weldpass_settings_title)) }) }) { padding ->
        Column(Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState())) {
            Section(stringResource(R.string.weldpass_settings_workspace))
            ListItem(
                headlineContent = { Text(session.workspace.name) },
                supportingContent = if (session.workspaces.size > 1) {
                    { Text(stringResource(R.string.weldpass_settings_switch_workspace)) }
                } else {
                    null
                },
                modifier = Modifier
                    .clickable(enabled = session.workspaces.size > 1) { switching = true }
                    .tagged("switch-workspace"),
            )

            Section(stringResource(R.string.weldpass_settings_server))
            ListItem(headlineContent = { Text(env.serverOrigin.removePrefix("https://")) })

            Section(stringResource(R.string.weldpass_settings_security))
            ListItem(
                headlineContent = { Text(stringResource(R.string.weldpass_settings_lock, stringResource(R.string.weldpass_lock_biometrics))) },
                supportingContent = { Text(stringResource(R.string.weldpass_settings_lock_always_on)) },
            )
            ListItem(
                headlineContent = { Text(stringResource(R.string.weldpass_settings_health)) },
                modifier = Modifier.clickable(onClick = onHealth).tagged("password-health"),
            )

            Section(stringResource(R.string.weldpass_settings_offline))
            OfflineSettings(repository.offline)

            Section(stringResource(R.string.weldpass_settings_account))
            ListItem(
                headlineContent = { Text(session.person.name ?: session.person.email.orEmpty()) },
                supportingContent = session.person.email?.takeIf { session.person.name != null }?.let { { Text(it) } },
            )
            ListItem(
                headlineContent = {
                    Text(stringResource(R.string.weldpass_settings_sign_out), color = MaterialTheme.colorScheme.error)
                },
                modifier = Modifier.clickable { confirmSignOut = true }.tagged("sign-out"),
            )

            Text(
                stringResource(R.string.weldpass_settings_version, BuildConfig.VERSION_NAME),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().padding(Tokens.Spacing.xl),
            )
        }
    }

    if (confirmSignOut) {
        AlertDialog(
            onDismissRequest = { confirmSignOut = false },
            title = { Text(stringResource(R.string.weldpass_settings_sign_out_title)) },
            text = { Text(stringResource(R.string.weldpass_settings_sign_out_message)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirmSignOut = false
                        repository.clear()
                        scope.launch {
                            // Revoke this phone and wipe its copies and key first: signing
                            // out takes the token the revoke needs.
                            repository.offline.signOut()
                            env.signOut()
                        }
                    },
                    modifier = Modifier.tagged("confirm-sign-out"),
                ) { Text(stringResource(R.string.weldpass_settings_sign_out)) }
            },
            dismissButton = {
                TextButton(onClick = { confirmSignOut = false }) { Text(stringResource(R.string.weldpass_common_cancel)) }
            },
        )
    }

    if (switching) {
        ModalBottomSheet(onDismissRequest = { switching = false }) {
            WorkspacePicker(session.workspaces, onChoose = { id ->
                switching = false
                env.chooseWorkspace(id)
            })
        }
    }
}

@Composable
private fun Section(title: String) {
    Text(
        title,
        style = MaterialTheme.typography.labelLarge,
        color = MaterialTheme.colorScheme.primary,
        modifier = Modifier.padding(start = Tokens.Spacing.l, end = Tokens.Spacing.l, top = Tokens.Spacing.xl, bottom = Tokens.Spacing.xs),
    )
}
