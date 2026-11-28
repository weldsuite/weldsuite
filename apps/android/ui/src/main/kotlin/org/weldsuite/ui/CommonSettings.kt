package org.weldsuite.ui

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.LocalActivity
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.stringResource
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.edit
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.R
import org.weldsuite.core.auth.Person
import org.weldsuite.core.auth.WorkspaceRef

/** Light, dark, or the phone's setting. */
enum class AppAppearance {
    SYSTEM, LIGHT, DARK;

    /** Whether to draw dark, given the phone's setting. */
    fun isDark(systemDark: Boolean): Boolean = when (this) {
        SYSTEM -> systemDark
        LIGHT -> false
        DARK -> true
    }

    val label: Int
        get() = when (this) {
            SYSTEM -> R.string.core_settings_system
            LIGHT -> R.string.core_settings_light
            DARK -> R.string.core_settings_dark
        }
}

/** The app's appearance choice, kept on the phone. */
class AppearancePreference(context: Context, appCode: String) {
    private val prefs = context.applicationContext.getSharedPreferences("weldsuite.appearance", Context.MODE_PRIVATE)
    private val key = "$appCode.appearance"
    private val state = MutableStateFlow(
        prefs.getString(key, null)?.let { stored -> AppAppearance.entries.firstOrNull { it.name == stored } } ?: AppAppearance.SYSTEM,
    )

    val value: StateFlow<AppAppearance> = state.asStateFlow()

    fun set(appearance: AppAppearance) {
        state.value = appearance
        prefs.edit { putString(key, appearance.name) }
    }
}

/**
 * The settings every app has, as items for the app's own settings
 * `LazyColumn`, below its own: the workspace (and switching it), the app
 * lock, notifications, appearance, language, and the account with sign-out
 * and the version. Test tags: `switch-workspace`, `app-lock`,
 * `notifications`, `appearance`, `language`, `sign-out`, `confirm-sign-out`.
 */
fun LazyListScope.commonSettingsItems(
    env: AppEnvironment,
    appName: String,
    person: Person,
    workspace: WorkspaceRef,
    workspaces: List<WorkspaceRef>,
    appearance: AppearancePreference,
    onSwitchWorkspace: () -> Unit,
) {
    item("settings-workspace") {
        SettingsHeader(stringResource(R.string.core_settings_workspace))
        ListItem(
            headlineContent = { Text(workspace.name) },
            supportingContent = if (workspaces.size > 1) {
                { Text(stringResource(R.string.core_settings_switch_workspace)) }
            } else {
                null
            },
            modifier = if (workspaces.size > 1) Modifier.clickable(onClick = onSwitchWorkspace).tagged("switch-workspace") else Modifier,
        )
    }
    if (env.lock.isOptional && env.lock.hasScreenLock()) {
        item("settings-lock") { LockSetting(env, appName) }
    }
    item("settings-look") { LookSettings(env, appName, appearance) }
    item("settings-account") { AccountSettings(env, appName, person) }
}

@Composable
fun SettingsHeader(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.titleSmall,
        color = MaterialTheme.colorScheme.primary,
        modifier = Modifier.padding(start = Tokens.Spacing.l, end = Tokens.Spacing.l, top = Tokens.Spacing.xl, bottom = Tokens.Spacing.xs),
    )
}

@Composable
private fun LockSetting(env: AppEnvironment, appName: String) {
    val activity = LocalActivity.current as? FragmentActivity
    val scope = rememberCoroutineScope()
    val enabled by env.lock.optionalEnabled.collectAsStateWithLifecycle()
    val method = stringResource(R.string.core_settings_passcode)
    val title = stringResource(R.string.core_settings_lock, method)
    SettingsHeader(stringResource(R.string.core_settings_security))
    ListItem(
        headlineContent = { Text(title) },
        supportingContent = { Text(stringResource(R.string.core_settings_lock_description, appName, method)) },
        trailingContent = {
            Switch(
                checked = enabled,
                onCheckedChange = { on -> if (activity != null) scope.launch { env.lock.setEnabled(activity, on, title) } },
                modifier = Modifier.tagged("app-lock"),
            )
        },
    )
}

@Composable
private fun LookSettings(env: AppEnvironment, appName: String, appearance: AppearancePreference) {
    val context = LocalContext.current
    val current by appearance.value.collectAsStateWithLifecycle()
    var choosing by remember { mutableStateOf(false) }
    if (env.usesPush) {
        val allowed = NotificationManagerCompat.from(context).areNotificationsEnabled()
        SettingsHeader(stringResource(R.string.core_settings_notifications))
        ListItem(
            headlineContent = { Text(stringResource(R.string.core_settings_notifications)) },
            supportingContent = {
                Text(
                    if (allowed) {
                        stringResource(R.string.core_settings_notifications_on)
                    } else {
                        stringResource(R.string.core_settings_notifications_off, appName)
                    },
                )
            },
            modifier = Modifier.clickable { openAppNotificationSettings(context) }.tagged("notifications"),
        )
    }
    SettingsHeader(stringResource(R.string.core_settings_appearance))
    ListItem(
        headlineContent = { Text(stringResource(R.string.core_settings_appearance)) },
        supportingContent = { Text(stringResource(current.label)) },
        modifier = Modifier.clickable { choosing = true }.tagged("appearance"),
    )
    ListItem(
        headlineContent = { Text(stringResource(R.string.core_settings_language)) },
        supportingContent = { Text(java.util.Locale.getDefault().displayLanguage.replaceFirstChar { it.uppercase() }) },
        modifier = Modifier.clickable { openAppLanguageSettings(context) }.tagged("language"),
    )
    if (choosing) {
        AlertDialog(
            onDismissRequest = { choosing = false },
            title = { Text(stringResource(R.string.core_settings_appearance)) },
            text = {
                Column {
                    AppAppearance.entries.forEach { option ->
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable {
                                    appearance.set(option)
                                    choosing = false
                                }
                                .tagged("appearance-${option.name.lowercase()}"),
                        ) {
                            RadioButton(selected = option == current, onClick = null)
                            Text(stringResource(option.label), modifier = Modifier.padding(start = Tokens.Spacing.m))
                        }
                    }
                }
            },
            confirmButton = {},
            dismissButton = { TextButton(onClick = { choosing = false }) { Text(stringResource(R.string.core_common_cancel)) } },
        )
    }
}

@Composable
private fun AccountSettings(env: AppEnvironment, appName: String, person: Person) {
    val scope = rememberCoroutineScope()
    val uri = LocalUriHandler.current
    var confirm by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf(false) }
    SettingsHeader(stringResource(R.string.core_settings_account))
    ListItem(
        headlineContent = { Text(person.name ?: person.email.orEmpty()) },
        supportingContent = if (person.name != null && person.email != null) {
            { Text(person.email.orEmpty()) }
        } else {
            null
        },
    )
    ListItem(
        headlineContent = { Text(stringResource(R.string.core_settings_server)) },
        supportingContent = { Text(env.serverOrigin.removePrefix("https://")) },
    )
    ListItem(
        headlineContent = { Text(stringResource(R.string.core_settings_sign_out), color = MaterialTheme.colorScheme.error) },
        modifier = Modifier.clickable { confirm = true }.tagged("sign-out"),
    )
    // Account deletion in the app, finished on the sign-in provider's account page.
    ListItem(
        headlineContent = { Text(stringResource(R.string.core_settings_delete_account), color = MaterialTheme.colorScheme.error) },
        modifier = Modifier.clickable { deleting = true }.tagged("delete-account"),
    )
    HorizontalDivider()
    Text(
        stringResource(R.string.core_settings_version, env.app.versionName),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(Tokens.Spacing.l),
    )
    if (confirm) {
        AlertDialog(
            onDismissRequest = { confirm = false },
            title = { Text(stringResource(R.string.core_settings_sign_out_title, appName)) },
            text = { Text(stringResource(R.string.core_settings_sign_out_message, appName)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirm = false
                        scope.launch { env.signOut() }
                    },
                    modifier = Modifier.tagged("confirm-sign-out"),
                ) { Text(stringResource(R.string.core_settings_sign_out), color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { confirm = false }) { Text(stringResource(R.string.core_common_cancel)) } },
        )
    }
    if (deleting) {
        val page = env.accountUrl
        AlertDialog(
            onDismissRequest = { deleting = false },
            title = { Text(stringResource(R.string.core_settings_delete_account_title)) },
            text = {
                Text(
                    stringResource(
                        if (page != null) R.string.core_settings_delete_account_message else R.string.core_settings_delete_account_unavailable,
                    ),
                )
            },
            confirmButton = {
                if (page != null) {
                    TextButton(
                        onClick = {
                            deleting = false
                            runCatching { uri.openUri(page) }
                        },
                        modifier = Modifier.tagged("delete-account-continue"),
                    ) { Text(stringResource(R.string.core_settings_delete_account_continue), color = MaterialTheme.colorScheme.error) }
                }
            },
            dismissButton = { TextButton(onClick = { deleting = false }) { Text(stringResource(R.string.core_common_cancel)) } },
        )
    }
}

private fun openAppNotificationSettings(context: Context) {
    val intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
    runCatching { context.startActivity(intent) }.onFailure { openAppDetails(context) }
}

/** Android 13+ has a per-app language page; before that, the app's details. */
private fun openAppLanguageSettings(context: Context) {
    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
        val intent = Intent(Settings.ACTION_APP_LOCALE_SETTINGS, Uri.fromParts("package", context.packageName, null))
        if (runCatching { context.startActivity(intent) }.isSuccess) return
    }
    openAppDetails(context)
}

private fun openAppDetails(context: Context) {
    context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null)))
}
