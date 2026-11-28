package com.weldsuite.weldcalendar.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ListItem
import org.weldsuite.ui.ModalBottomSheet
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.stringResource
import com.weldsuite.weldcalendar.R
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.SessionState
import org.weldsuite.ui.AppearancePreference
import org.weldsuite.ui.SettingsHeader
import org.weldsuite.ui.WorkspacePicker
import org.weldsuite.ui.commonSettingsItems
import org.weldsuite.ui.tagged

/** WeldSuite's privacy pages, as the Expo app linked them. */
private const val PRIVACY_URL = "https://weldsuite.com/privacy"
private const val TERMS_URL = "https://weldsuite.com/terms"
private const val SUPPORT_URL = "mailto:privacy@weldsuite.com?subject=Privacy%20Inquiry"

/**
 * The More tab: the app's own privacy links first, then the settings every
 * app shares (workspace, lock, notifications, appearance, language, and the
 * account with sign-out and account deletion).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(env: AppEnvironment, session: SessionState.Ready, appearance: AppearancePreference) {
    val uri = LocalUriHandler.current
    val appName = stringResource(R.string.weldcalendar_app_name)
    var switching by remember { mutableStateOf(false) }
    val open: (String) -> Unit = { url -> runCatching { uri.openUri(url) } }

    Scaffold(topBar = { TopAppBar(title = { Text(stringResource(R.string.weldcalendar_settings_title)) }) }) { padding ->
        LazyColumn(Modifier.padding(padding).fillMaxSize()) {
            item("privacy") {
                SettingsHeader(stringResource(R.string.weldcalendar_settings_privacy))
                ListItem(
                    headlineContent = { Text(stringResource(R.string.weldcalendar_settings_privacy_policy)) },
                    modifier = Modifier.clickable { open(PRIVACY_URL) }.tagged("privacy-policy"),
                )
                ListItem(
                    headlineContent = { Text(stringResource(R.string.weldcalendar_settings_terms)) },
                    modifier = Modifier.clickable { open(TERMS_URL) }.tagged("terms"),
                )
                ListItem(
                    headlineContent = { Text(stringResource(R.string.weldcalendar_settings_contact_support)) },
                    modifier = Modifier.clickable { open(SUPPORT_URL) }.tagged("contact-support"),
                )
            }
            commonSettingsItems(
                env = env,
                appName = appName,
                person = session.person,
                workspace = session.workspace,
                workspaces = session.workspaces,
                appearance = appearance,
                onSwitchWorkspace = { switching = true },
            )
        }
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
