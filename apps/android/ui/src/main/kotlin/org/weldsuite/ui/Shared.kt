package org.weldsuite.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.SubcomposeAsyncImage
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.weldsuite.core.AppEnvironment
import org.weldsuite.core.R
import org.weldsuite.core.api.ApiException
import org.weldsuite.core.apiErrorMessage

/**
 * A person's picture, or their initials when there is none (or it doesn't
 * load): white on the colour the web platform gives that name, or in `tint`
 * on a light wash of it when one is passed.
 */
@Composable
fun Avatar(name: String?, url: String? = null, size: Dp = 36.dp, tint: Color? = null, modifier: Modifier = Modifier) {
    val box = modifier.size(size).clip(CircleShape).clearAndSetSemantics { }
    if (url.isNullOrBlank()) {
        Initials(name, size, tint, box)
    } else {
        SubcomposeAsyncImage(
            model = url,
            contentDescription = null,
            contentScale = ContentScale.Crop,
            modifier = box,
            loading = { Initials(name, size, tint, Modifier.fillMaxSize()) },
            error = { Initials(name, size, tint, Modifier.fillMaxSize()) },
        )
    }
}

@Composable
private fun Initials(name: String?, size: Dp, tint: Color?, modifier: Modifier) {
    val background = tint?.copy(alpha = 0.15f) ?: avatarColor(name.orEmpty())
    Box(modifier.background(background), contentAlignment = Alignment.Center) {
        Text(initialsOf(name), color = tint ?: Color.White, fontWeight = FontWeight.SemiBold, fontSize = (size.value * 0.38f).sp)
    }
}

private val AvatarColors = listOf(
    0xFF4F46E5, 0xFF7C3AED, 0xFFEC4899, 0xFFEF4444, 0xFFF97316,
    0xFFEAB308, 0xFF22C55E, 0xFF14B8A6, 0xFF06B6D4, 0xFF3B82F6,
).map { Color(it) }

private val LabelColors = listOf(
    0xFFEF4444, 0xFFF97316, 0xFFF59E0B, 0xFFEAB308, 0xFF84CC16,
    0xFF22C55E, 0xFF10B981, 0xFF14B8A6, 0xFF06B6D4, 0xFF0EA5E9,
    0xFF3B82F6, 0xFF6366F1, 0xFF8B5CF6, 0xFFA855F7, 0xFFD946EF,
    0xFFEC4899, 0xFFF43F5E,
).map { Color(it) }

/**
 * The web platform's string hash (`hashString` in the platform's
 * conversation-list utils), JavaScript number semantics included, so a name
 * gets the same colour here as there.
 */
internal fun platformHash(text: String): Long {
    var hash = 0.0
    for (i in text.indices) {
        val shifted = hash.toLong().toInt() shl 5
        hash = text.codePointAt(i) + (shifted - hash)
    }
    return kotlin.math.abs(hash).toLong()
}

/** The colour the web platform gives a person's avatar. */
fun avatarColor(name: String): Color = AvatarColors[(platformHash(name) % AvatarColors.size).toInt()]

/** The colour the web platform gives a label or tag without one of its own. */
fun labelColor(name: String): Color = LabelColors[(platformHash(name) % LabelColors.size).toInt()]

/** "Ann de Vries" → "AV", "ann@example.com" → "A". */
fun initialsOf(name: String?): String {
    val text = name.orEmpty()
    val words = text.split(' ', '@', '.').filter { it.isNotEmpty() }
    val first = words.firstOrNull()?.firstOrNull() ?: return "?"
    if (words.size < 2 || text.contains('@')) return first.uppercase()
    return "${first.uppercaseChar()}${words.last().first().uppercaseChar()}"
}

/** A short coloured label: a status, a count, a priority. */
@Composable
fun StatusBadge(text: String, color: Color, modifier: Modifier = Modifier) {
    Text(
        text,
        color = color,
        style = MaterialTheme.typography.labelMedium,
        fontWeight = FontWeight.Medium,
        modifier = modifier
            .background(color.copy(alpha = 0.12f), RoundedCornerShape(Tokens.Radius.small))
            .padding(horizontal = Tokens.Spacing.s, vertical = 2.dp),
    )
}

/** A list that couldn't load, with a way to try again. */
@Composable
fun LoadErrorState(error: Throwable?, onRetry: () -> Unit, modifier: Modifier = Modifier) {
    Column(
        modifier = modifier.fillMaxSize().padding(Tokens.Spacing.xl),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.m, Alignment.CenterVertically),
    ) {
        val offline = (error as? ApiException)?.isNetwork == true
        Icon(if (offline) Icons.Filled.CloudOff else Icons.Filled.ErrorOutline, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(stringResource(R.string.core_errors_load_failed), style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center)
        Text(
            stringResource(apiErrorMessage(error)),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
        Button(onClick = onRetry, modifier = Modifier.tagged("retry")) { Text(stringResource(R.string.core_common_try_again)) }
    }
}

/**
 * Reload while this is in the composition whenever the workspace hub says
 * something on [topics] changed (and after a reconnect).
 *
 * ```kotlin
 * RealtimeRefresh(env, listOf("ticket")) { viewModel.load() }
 * ```
 */
@Composable
fun RealtimeRefresh(env: AppEnvironment, topics: List<String>, onChange: suspend () -> Unit) {
    val latest by rememberUpdatedState(onChange)
    LaunchedEffect(topics) {
        env.realtime?.events(topics)?.collect { latest() }
    }
}

/**
 * A short message at the bottom of the screen: "Saved", "Couldn't send". One
 * per app; show it with [ToastHost].
 */
class Toaster {
    var message by mutableStateOf<String?>(null)
        private set
    private var hide: Job? = null

    fun show(text: String, scope: kotlinx.coroutines.CoroutineScope) {
        message = text
        hide?.cancel()
        hide = scope.launch {
            delay(3_000)
            message = null
        }
    }
}

/** Shows the [toaster]'s message at the bottom of [content]. */
@Composable
fun ToastHost(toaster: Toaster, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Box(modifier.fillMaxSize()) {
        content()
        toaster.message?.let { message ->
            Text(
                message,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.inverseOnSurface,
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(bottom = 96.dp)
                    .background(MaterialTheme.colorScheme.inverseSurface, RoundedCornerShape(50))
                    .padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.m)
                    .tagged("toast"),
            )
        }
    }
}
