package com.weldsuite.welddesk.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import org.weldsuite.core.api.ApiException
import org.weldsuite.core.apiErrorMessage
import org.weldsuite.ui.OutlinedButton
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged

/**
 * What couldn't load, in the platform's words ("Failed to load
 * conversations"), why, and a way to try again: the warning on a red-tinted
 * square, as the platform's list shows a failed load.
 */
@Composable
fun DeskLoadError(title: String, error: Throwable?, onRetry: () -> Unit, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxSize().tagged("load-error"), contentAlignment = Alignment.Center) {
        val offline = (error as? ApiException)?.isNetwork == true
        val danger = Tokens.Status.danger.current()
        DeskEmptyState(
            icon = if (offline) Icons.Outlined.CloudOff else Icons.Outlined.WarningAmber,
            title = title,
            description = stringResource(apiErrorMessage(error)),
            iconTint = danger,
            iconBackground = danger.copy(alpha = 0.12f),
            action = {
                OutlinedButton(onClick = onRetry, modifier = Modifier.tagged("retry")) {
                    Text(stringResource(org.weldsuite.core.R.string.core_common_try_again))
                }
            },
        )
    }
}
