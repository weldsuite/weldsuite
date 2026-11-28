package com.weldsuite.welddesk.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Chat
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.weldsuite.welddesk.R
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.SessionState
import org.weldsuite.ui.AppearancePreference
import org.weldsuite.ui.SettingsHeader
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.commonSettingsItems
import org.weldsuite.ui.tagged

/** WeldDesk's own settings (the channels are set up on the web), then the ones every app has. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(env: AppEnvironment, session: SessionState.Ready, appearance: AppearancePreference, onSwitchWorkspace: () -> Unit) {
    val appName = stringResource(R.string.welddesk_app_name)
    Scaffold(
        topBar = { TopAppBar(title = { Text(stringResource(R.string.welddesk_settings_title)) }) },
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
    ) { padding ->
        LazyColumn(Modifier.padding(padding).fillMaxSize().tagged("settings")) {
            item("settings-channels") {
                SettingsHeader(stringResource(R.string.welddesk_settings_channels))
                ListItem(
                    headlineContent = {
                        Text(
                            stringResource(R.string.welddesk_settings_channels_hint),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    },
                    leadingContent = {
                        // The platform's neutral icon square, not an app colour.
                        Box(
                            Modifier.size(36.dp).background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(Tokens.Radius.medium)),
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(
                                Icons.AutoMirrored.Outlined.Chat,
                                contentDescription = null,
                                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.size(18.dp),
                            )
                        }
                    },
                    modifier = Modifier.tagged("channels-hint"),
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
