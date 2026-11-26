package org.weldsuite.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.graphics.Color

/** A colour with a light and a dark variant, as the design tokens define them. */
data class DayNight(val light: Color, val dark: Color) {
    @Composable
    @ReadOnlyComposable
    fun current(): Color = if (isSystemInDarkTheme()) dark else light
}

/**
 * Material 3 with the app's brand as the primary colour. Everything else is
 * Material's own scheme, so the app looks at home on Android.
 */
@Composable
fun WeldTheme(brand: DayNight, dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    val scheme = if (dark) {
        darkColorScheme(
            primary = brand.dark,
            onPrimary = Color(0xFF1E1B4B),
            primaryContainer = brand.dark.copy(alpha = 0.24f),
            onPrimaryContainer = Color.White,
            error = Tokens.Status.danger.dark,
        )
    } else {
        lightColorScheme(
            primary = brand.light,
            onPrimary = Color.White,
            primaryContainer = brand.light.copy(alpha = 0.12f),
            onPrimaryContainer = brand.light,
            error = Tokens.Status.danger.light,
        )
    }
    MaterialTheme(colorScheme = scheme, content = content)
}
