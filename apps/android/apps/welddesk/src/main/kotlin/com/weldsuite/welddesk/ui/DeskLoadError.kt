package com.weldsuite.welddesk.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import org.weldsuite.core.api.ApiException
import org.weldsuite.core.apiErrorMessage
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged

/**
 * What couldn't load, in WeldDesk's words ("Could not load conversations."),
 * why, and a way to try again. The core's `LoadErrorState` with the app's
 * own title.
 */
@Composable
fun DeskLoadError(title: String, error: Throwable?, onRetry: () -> Unit, modifier: Modifier = Modifier) {
    Column(
        modifier = modifier.fillMaxSize().padding(Tokens.Spacing.xl).tagged("load-error"),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.m, Alignment.CenterVertically),
    ) {
        val offline = (error as? ApiException)?.isNetwork == true
        Icon(if (offline) Icons.Filled.CloudOff else Icons.Filled.ErrorOutline, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(title, style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center)
        Text(
            stringResource(apiErrorMessage(error)),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
        Button(onClick = onRetry, modifier = Modifier.tagged("retry")) {
            Text(stringResource(org.weldsuite.core.R.string.core_common_try_again))
        }
    }
}
