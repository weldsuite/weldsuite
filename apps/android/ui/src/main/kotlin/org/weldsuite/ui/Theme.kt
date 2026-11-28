package org.weldsuite.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/** Whether the app is drawn dark: the person's choice in Settings, else the system's. */
val LocalWeldDark = staticCompositionLocalOf<Boolean?> { null }

/** A colour with a light and a dark variant, as the design tokens define them. */
data class DayNight(val light: Color, val dark: Color) {
    /** The variant for the app's appearance, which can differ from the system's. */
    @Composable
    @ReadOnlyComposable
    fun current(): Color = if (LocalWeldDark.current ?: isSystemInDarkTheme()) dark else light
}

/** Inter, the web platform's typeface, in the four weights the apps use. */
val Inter = FontFamily(
    Font(R.font.inter_regular, FontWeight.Normal),
    Font(R.font.inter_medium, FontWeight.Medium),
    Font(R.font.inter_semibold, FontWeight.SemiBold),
    Font(R.font.inter_bold, FontWeight.Bold),
)

/**
 * The web platform's look: its neutral palette (black on white, a blue primary
 * when dark), Inter, and its radii. Material 3 supplies the components and
 * their behaviour; the colours, type and shapes are the platform's.
 */
@Composable
fun WeldTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalWeldDark provides dark) {
        MaterialTheme(
            colorScheme = weldColors(dark),
            typography = WeldTypography,
            shapes = WeldShapes,
            content = content,
        )
    }
}

private fun weldColors(dark: Boolean): ColorScheme {
    fun DayNight.pick() = if (dark) this.dark else light
    val p = Tokens.Palette
    val background = p.background.pick()
    val foreground = p.foreground.pick()
    val danger = Tokens.Status.danger.pick()
    val scheme = if (dark) darkColorScheme() else lightColorScheme()
    return scheme.copy(
        primary = p.primary.pick(),
        onPrimary = p.primaryForeground.pick(),
        // Containers (the FAB, tonal buttons, selected rows) are the platform's
        // accent: a neutral fill, never a tinted one.
        primaryContainer = p.accent.pick(),
        onPrimaryContainer = p.accentForeground.pick(),
        inversePrimary = p.ring.pick(),
        secondary = p.mutedForeground.pick(),
        onSecondary = background,
        // The navigation bar's indicator, selected chips and segments.
        secondaryContainer = p.accent.pick(),
        onSecondaryContainer = p.accentForeground.pick(),
        tertiary = p.link.pick(),
        onTertiary = background,
        tertiaryContainer = p.accent.pick(),
        onTertiaryContainer = p.accentForeground.pick(),
        background = background,
        onBackground = foreground,
        surface = background,
        onSurface = foreground,
        surfaceVariant = p.muted.pick(),
        onSurfaceVariant = p.mutedForeground.pick(),
        surfaceTint = Color.Transparent,
        inverseSurface = foreground,
        inverseOnSurface = background,
        error = danger,
        onError = Color.White,
        errorContainer = danger.copy(alpha = 0.12f),
        onErrorContainer = danger,
        outline = p.input.pick(),
        outlineVariant = p.border.pick(),
        scrim = Color.Black,
        surfaceBright = background,
        surfaceDim = p.muted.pick(),
        surfaceContainerLowest = if (dark) Color(0xFF101113) else Color.White,
        // Sheets, menus, dialogs, scrolled top bars and cards: the platform's
        // card and popover colour. The bottom bar takes the sidebar's chrome
        // itself (see NavigationBar).
        surfaceContainerLow = p.card.pick(),
        surfaceContainer = p.card.pick(),
        surfaceContainerHigh = p.card.pick(),
        surfaceContainerHighest = p.muted.pick(),
    )
}

private fun style(size: Int, line: Int, weight: FontWeight, tracking: Double = 0.0) = TextStyle(
    fontFamily = Inter,
    fontWeight = weight,
    fontSize = size.sp,
    lineHeight = line.sp,
    letterSpacing = tracking.sp,
)

/** Material's scale in Inter, with the platform's weights: semibold headings, medium labels. */
val WeldTypography = Typography(
    displayLarge = style(57, 64, FontWeight.SemiBold, -0.5),
    displayMedium = style(45, 52, FontWeight.SemiBold, -0.5),
    displaySmall = style(36, 44, FontWeight.SemiBold, -0.4),
    headlineLarge = style(32, 40, FontWeight.SemiBold, -0.4),
    headlineMedium = style(28, 36, FontWeight.SemiBold, -0.3),
    headlineSmall = style(24, 32, FontWeight.SemiBold, -0.2),
    titleLarge = style(20, 28, FontWeight.SemiBold, -0.2),
    titleMedium = style(16, 24, FontWeight.SemiBold),
    titleSmall = style(14, 20, FontWeight.Medium),
    bodyLarge = style(16, 24, FontWeight.Normal),
    bodyMedium = style(14, 20, FontWeight.Normal),
    bodySmall = style(12, 16, FontWeight.Normal),
    labelLarge = style(14, 20, FontWeight.Medium),
    labelMedium = style(12, 16, FontWeight.Medium),
    labelSmall = style(11, 16, FontWeight.Medium),
)

/**
 * The platform's radii: `rounded-md` (8) for inputs, menus, chips and buttons,
 * `rounded-lg` (10), and `rounded-xl` (14) for cards, sheets and dialogs.
 */
val WeldShapes = Shapes(
    extraSmall = RoundedCornerShape(Tokens.Radius.medium),
    small = RoundedCornerShape(Tokens.Radius.medium),
    medium = RoundedCornerShape(Tokens.Radius.large),
    large = RoundedCornerShape(Tokens.Radius.xlarge),
    extraLarge = RoundedCornerShape(Tokens.Radius.xlarge),
)
