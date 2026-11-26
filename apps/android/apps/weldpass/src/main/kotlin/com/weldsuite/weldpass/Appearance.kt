package com.weldsuite.weldpass

import android.content.Context
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.Composable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.weldsuite.core.storage.PreferencesStore

/** Light, dark, or the phone's setting. */
enum class Appearance { SYSTEM, LIGHT, DARK }

/** The person's appearance choice, kept on the phone. */
class AppearancePreference(context: Context) {
    private val store = PreferencesStore(context, "weldpass.ui")
    private val state = MutableStateFlow(
        store.get(KEY)?.let { saved -> Appearance.entries.firstOrNull { it.name == saved } } ?: Appearance.SYSTEM,
    )
    val value: StateFlow<Appearance> = state.asStateFlow()

    fun set(appearance: Appearance) {
        store.set(KEY, appearance.name)
        state.value = appearance
    }

    private companion object {
        const val KEY = "appearance"
    }
}

/** Whether to draw dark, for [appearance]. */
@Composable
fun Appearance.isDark(): Boolean = when (this) {
    Appearance.SYSTEM -> isSystemInDarkTheme()
    Appearance.LIGHT -> false
    Appearance.DARK -> true
}
