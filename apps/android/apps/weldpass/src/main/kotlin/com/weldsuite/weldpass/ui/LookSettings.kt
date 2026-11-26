package com.weldsuite.weldpass.ui

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ListItem
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.weldsuite.weldpass.Appearance
import com.weldsuite.weldpass.AppearancePreference
import com.weldsuite.weldpass.R
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged
import java.util.Locale

/** Light, dark or the phone's setting. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AppearanceSettings(preference: AppearancePreference) {
    val current by preference.value.collectAsStateWithLifecycle()
    val options = listOf(
        Appearance.SYSTEM to R.string.weldpass_settings_system,
        Appearance.LIGHT to R.string.weldpass_settings_light,
        Appearance.DARK to R.string.weldpass_settings_dark,
    )
    SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.s)) {
        options.forEachIndexed { index, (appearance, label) ->
            SegmentedButton(
                selected = current == appearance,
                onClick = { preference.set(appearance) },
                shape = SegmentedButtonDefaults.itemShape(index, options.size),
                modifier = Modifier.tagged("appearance-${appearance.name.lowercase()}"),
            ) { Text(stringResource(label)) }
        }
    }
}

/**
 * The app's language: the system's per-app language setting (Android 13+),
 * which lists English and Dutch (`res/xml/locales_config.xml`). Older phones
 * follow the phone's language.
 */
@Composable
fun LanguageSettings() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
    val context = LocalContext.current
    ListItem(
        headlineContent = { Text(stringResource(R.string.weldpass_settings_language)) },
        supportingContent = { Text(Locale.getDefault().getDisplayLanguage(Locale.getDefault()).replaceFirstChar { it.titlecase() }) },
        modifier = Modifier
            .clickable {
                context.startActivity(
                    Intent(Settings.ACTION_APP_LOCALE_SETTINGS, Uri.fromParts("package", context.packageName, null)),
                )
            }
            .tagged("language"),
    )
}
