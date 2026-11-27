package com.weldsuite.weldmail.ui

import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import com.weldsuite.weldmail.R
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.SessionState
import org.weldsuite.push.NotificationPermissionRequest
import org.weldsuite.ui.AppearancePreference
import org.weldsuite.ui.WorkspacePicker
import org.weldsuite.ui.commonSettingsItems

/** WeldMail once signed in, in a workspace and unlocked. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WeldMailApp(env: AppEnvironment, session: SessionState.Ready, appearance: AppearancePreference) {
    NotificationPermissionRequest()
    var switching by remember { mutableStateOf(false) }
    if (switching) {
        WorkspacePicker(session.workspaces, onChoose = {
            env.chooseWorkspace(it)
            switching = false
        })
        return
    }
    val appName = stringResource(R.string.weldmail_app_name)
    Scaffold(topBar = { TopAppBar(title = { Text(appName) }) }) { padding ->
        LazyColumn(Modifier.padding(padding)) {
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
}
