package com.weldsuite.weldpass.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.VerifiedUser
import androidx.compose.material3.AssistChip
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.weldsuite.weldpass.PassRepository
import com.weldsuite.weldpass.R
import org.weldsuite.api.weldpass.models.HealthEntry
import org.weldsuite.api.weldpass.models.HealthReport
import org.weldsuite.api.weldpass.models.Item
import org.weldsuite.core.api.ApiException
import org.weldsuite.ui.CenteredProgress
import org.weldsuite.ui.EmptyState
import org.weldsuite.ui.Tokens

/**
 * Weak, reused and old passwords in the vaults the person can open. The
 * server works it out without sending a password; this lists what needs
 * fixing, worst first.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HealthScreen(repository: PassRepository, onBack: () -> Unit, onOpen: (vaultId: String, itemId: String) -> Unit) {
    var report by remember { mutableStateOf<HealthReport?>(null) }
    var error by remember { mutableStateOf<ApiException?>(null) }
    LaunchedEffect(Unit) {
        try {
            report = repository.health()
        } catch (failure: ApiException) {
            error = failure
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(title = { Text(stringResource(R.string.weldpass_health_title)) }, navigationIcon = { BackButton(onBack) })
        },
    ) { padding ->
        val current = report
        when {
            error != null -> EmptyState(stringResource(passErrorMessage(error)), modifier = Modifier.padding(padding))
            current == null -> CenteredProgress(Modifier.padding(padding))
            current.checked == 0 -> EmptyState(stringResource(R.string.weldpass_health_nothing_checked), modifier = Modifier.padding(padding))
            else -> LazyColumn(Modifier.padding(padding).fillMaxSize()) {
                item {
                    Text(
                        stringResource(R.string.weldpass_health_summary, current.healthy, current.checked),
                        style = MaterialTheme.typography.titleMedium,
                        modifier = Modifier.padding(Tokens.Spacing.l),
                    )
                    Row(
                        Modifier.padding(horizontal = Tokens.Spacing.l),
                        horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
                    ) {
                        AssistChip(onClick = {}, label = { Text("${stringResource(R.string.weldpass_health_weak)} · ${current.weak}") })
                        AssistChip(onClick = {}, label = { Text("${stringResource(R.string.weldpass_health_reused)} · ${current.reused}") })
                        AssistChip(onClick = {}, label = { Text("${stringResource(R.string.weldpass_health_old)} · ${current.old}") })
                    }
                }
                if (current.items.isEmpty()) {
                    item {
                        EmptyState(
                            stringResource(R.string.weldpass_health_all_good),
                            stringResource(R.string.weldpass_health_all_good_description),
                            icon = {
                                Icon(
                                    Icons.Outlined.VerifiedUser,
                                    contentDescription = null,
                                    tint = Tokens.Status.success.current(),
                                    modifier = Modifier.size(32.dp),
                                )
                            },
                        )
                    }
                } else {
                    items(current.items, key = { it.id }) { entry -> HealthRow(entry) { onOpen(entry.vaultId, entry.id) } }
                    item {
                        Text(
                            stringResource(R.string.weldpass_health_fix_hint),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(Tokens.Spacing.l),
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun HealthRow(entry: HealthEntry, onClick: () -> Unit) {
    val issues = entry.issues.mapNotNull { issue ->
        when (issue) {
            HealthEntry.Issues.WEAK -> stringResource(R.string.weldpass_health_weak)
            HealthEntry.Issues.REUSED -> pluralStringResource(R.plurals.weldpass_health_reused_count, entry.reuseCount - 1, entry.reuseCount - 1)
            HealthEntry.Issues.OLD -> stringResource(R.string.weldpass_health_old)
            else -> null
        }
    }
    ListItem(
        headlineContent = { Text(entry.title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        supportingContent = { Text(issues.joinToString(" · "), color = Tokens.Status.danger.current()) },
        leadingContent = { ItemIcon(Item.Type.LOGIN) },
        modifier = Modifier.clickable(onClick = onClick),
    )
}
