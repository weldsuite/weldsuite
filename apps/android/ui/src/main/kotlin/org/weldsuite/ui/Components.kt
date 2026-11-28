package org.weldsuite.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/** A spinner in the middle of the available space. */
@Composable
fun CenteredProgress(modifier: Modifier = Modifier) {
    Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        CircularProgressIndicator()
    }
}

/** A labelled action for [MessageScreen] and [EmptyState]. */
data class MessageAction(val label: String, val testTag: String? = null, val onClick: () -> Unit)

/**
 * A full screen with a title, an explanation and up to two actions: a server
 * that can't be reached, an app that needs updating, no workspace.
 */
@Composable
fun MessageScreen(
    title: String,
    description: String?,
    primary: MessageAction? = null,
    secondary: MessageAction? = null,
    modifier: Modifier = Modifier,
    header: (@Composable () -> Unit)? = null,
) {
    Box(modifier.fillMaxSize().padding(Tokens.Spacing.xl), contentAlignment = Alignment.Center) {
        Column(
            modifier = Modifier.widthIn(max = 420.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.m),
        ) {
            header?.invoke()
            Text(title, style = MaterialTheme.typography.headlineSmall, textAlign = TextAlign.Center)
            if (description != null) {
                Text(
                    description,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                )
            }
            if (primary != null) {
                Button(
                    onClick = primary.onClick,
                    modifier = Modifier.fillMaxWidth().padding(top = Tokens.Spacing.s).tagged(primary.testTag),
                ) { Text(primary.label) }
            }
            if (secondary != null) {
                TextButton(onClick = secondary.onClick, modifier = Modifier.tagged(secondary.testTag)) {
                    Text(secondary.label)
                }
            }
        }
    }
}

/** What a list shows when there is nothing in it. */
@Composable
fun EmptyState(title: String, description: String? = null, modifier: Modifier = Modifier, icon: (@Composable () -> Unit)? = null) {
    Column(
        modifier = modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.xl, vertical = 48.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
    ) {
        icon?.invoke()
        Text(title, style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center)
        if (description != null) {
            Text(
                description,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
        }
    }
}

/** A test tag, for Maestro (`id:`) and Compose tests, when one is given. */
fun Modifier.tagged(tag: String?): Modifier = if (tag == null) this else testTag(tag)

/**
 * A bottom-bar label: one line, cut with an ellipsis, so a long label (or its
 * Dutch translation) never wraps and pushes its tab out of line with the others.
 */
@Composable
fun TabLabel(text: String) {
    Text(text, maxLines = 1, softWrap = false, overflow = TextOverflow.Ellipsis)
}
