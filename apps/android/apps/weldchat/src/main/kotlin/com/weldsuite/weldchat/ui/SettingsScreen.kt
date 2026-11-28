package com.weldsuite.weldchat.ui

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.filled.OpenInNew
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.weldsuite.weldchat.ChatStore
import com.weldsuite.weldchat.MemberProfileInfo
import com.weldsuite.weldchat.R
import kotlinx.coroutines.CancellationException
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.SessionState
import org.weldsuite.core.auth.Person
import org.weldsuite.ui.AppearancePreference
import org.weldsuite.ui.SettingsHeader
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.WorkspacePicker
import org.weldsuite.ui.commonSettingsItems
import org.weldsuite.ui.tagged
import org.weldsuite.core.R as CoreR

/** The screen's back arrow. */
@Composable
fun BackButton(onClick: () -> Unit, tag: String = "back") {
    IconButton(onClick = onClick, modifier = Modifier.tagged(tag)) {
        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.weldchat_common_back))
    }
}

/**
 * Settings: "Your profile" first, then what every app has (workspace, app
 * lock, notifications, appearance, language, account, sign-out, version).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(env: AppEnvironment, session: SessionState.Ready, appearance: AppearancePreference, nav: ChatNavigator) {
    var switching by remember { mutableStateOf(false) }
    if (switching) {
        WorkspacePicker(session.workspaces, onChoose = {
            switching = false
            if (it != session.workspace.id) env.chooseWorkspace(it)
        })
        return
    }
    val appName = stringResource(R.string.weldchat_app_name)
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(CoreR.string.core_settings_title)) },
                navigationIcon = { BackButton(onClick = { nav.back() }) },
            )
        },
    ) { padding ->
        LazyColumn(Modifier.padding(padding).fillMaxSize().tagged("settings-list")) {
            item("profile") {
                ListItem(
                    headlineContent = { Text(stringResource(R.string.weldchat_profile_your_profile)) },
                    supportingContent = (session.person.name ?: session.person.email)?.let { { Text(it) } },
                    leadingContent = { ChatAvatar(session.person.name ?: session.person.email, null, 40.dp) },
                    trailingContent = { Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null) },
                    modifier = Modifier.clickable { nav.openProfile() }.tagged("settings-profile"),
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
}

/**
 * The signed-in person: picture, name and e-mail (and phone, when the
 * profile has one); the account itself is managed on the web.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ProfileScreen(env: AppEnvironment, store: ChatStore, person: Person, nav: ChatNavigator) {
    val context = LocalContext.current
    var profile by remember { mutableStateOf<MemberProfileInfo?>(null) }
    LaunchedEffect(person.id) {
        profile = try {
            store.repository.memberProfile(person.id)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            null
        }
    }
    val name = profile?.name ?: person.name ?: person.email.orEmpty()
    val email = profile?.email ?: person.email
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.weldchat_profile_title)) },
                navigationIcon = { BackButton(onClick = { nav.back() }) },
            )
        },
    ) { padding ->
        LazyColumn(Modifier.padding(padding).fillMaxSize().tagged("profile")) {
            item("header") {
                Column(
                    Modifier.fillMaxWidth().padding(Tokens.Spacing.xl),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
                ) {
                    ChatAvatar(name, profile?.picture, 88.dp)
                    Text(name, style = MaterialTheme.typography.titleLarge)
                }
            }
            item("personal") {
                SettingsHeader(stringResource(R.string.weldchat_profile_personal_info))
                ListItem(
                    headlineContent = { Text(name) },
                    overlineContent = { Text(stringResource(R.string.weldchat_profile_name)) },
                    leadingContent = { Icon(Icons.Filled.Person, contentDescription = null) },
                )
                email?.let {
                    ListItem(
                        headlineContent = { Text(it) },
                        overlineContent = { Text(stringResource(R.string.weldchat_profile_email)) },
                        leadingContent = { Icon(Icons.Filled.Email, contentDescription = null) },
                    )
                }
                profile?.phone?.takeIf { it.isNotEmpty() }?.let {
                    ListItem(
                        headlineContent = { Text(it) },
                        overlineContent = { Text(stringResource(R.string.weldchat_member_fields_phone)) },
                        leadingContent = { Icon(Icons.Filled.Phone, contentDescription = null) },
                    )
                }
            }
            item("manage") {
                SettingsHeader(stringResource(CoreR.string.core_settings_account))
                ListItem(
                    headlineContent = { Text(stringResource(R.string.weldchat_profile_manage_on_web)) },
                    leadingContent = { Icon(Icons.AutoMirrored.Filled.OpenInNew, contentDescription = null) },
                    modifier = Modifier.clickable {
                        try {
                            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(env.serverOrigin)))
                        } catch (_: ActivityNotFoundException) {
                            // No browser on the phone: nothing to open it in.
                        }
                    }.tagged("profile-manage-on-web"),
                )
            }
        }
    }
}
