package com.weldsuite.weldpass.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.VerifiedUser
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.weldsuite.weldpass.PassLogic
import com.weldsuite.weldpass.PassRepository
import com.weldsuite.weldpass.R
import org.weldsuite.api.weldpass.models.HealthEntry
import org.weldsuite.api.weldpass.models.HealthReport
import org.weldsuite.api.weldpass.models.Item
import org.weldsuite.core.api.ApiException
import org.weldsuite.ui.CenteredProgress
import org.weldsuite.ui.StatusBadge
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged

/**
 * Weak, reused and old passwords in the vaults the person can open, as the
 * platform's health page: one group per issue, worst first, each login under
 * its worst one. The server works it out without sending a password.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
fun HealthScreen(repository: PassRepository, onBack: () -> Unit, onOpen: (vaultId: String, itemId: String) -> Unit) {
    var report by remember { mutableStateOf<HealthReport?>(null) }
    var error by remember { mutableStateOf<ApiException?>(null) }
    var attempt by remember { mutableIntStateOf(0) }
    LaunchedEffect(attempt) {
        error = null
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
            error != null -> EmptyMessage(
                icon = Icons.Outlined.ErrorOutline,
                title = stringResource(passErrorMessage(error)),
                action = stringResource(R.string.weldpass_common_try_again) to { attempt++; Unit },
                actionTag = "retry",
                modifier = Modifier.padding(padding),
            )
            current == null -> CenteredProgress(Modifier.padding(padding))
            current.items.isEmpty() -> EmptyMessage(
                icon = Icons.Outlined.VerifiedUser,
                title = stringResource(R.string.weldpass_health_attention_title),
                // Nothing checked yet reads differently from everything checked and fine.
                description = stringResource(
                    if (current.checked > 0) R.string.weldpass_health_all_healthy else R.string.weldpass_health_empty_description,
                ),
                modifier = Modifier.padding(padding),
            )
            else -> LazyColumn(Modifier.padding(padding).fillMaxSize()) {
                PassLogic.groupByWorstIssue(current.items).forEach { (issue, entries) ->
                    stickyHeader(key = "issue-${issue.value}") { GroupHeader(issueTitle(issue), entries.size) }
                    items(entries, key = { it.id }) { entry -> HealthRow(entry) { onOpen(entry.vaultId, entry.id) } }
                }
                item {
                    Text(
                        stringResource(R.string.weldpass_health_fix_hint),
                        style = secondaryTextStyle(),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(Tokens.Spacing.l),
                    )
                }
            }
        }
    }
}

@Composable
private fun issueTitle(issue: HealthEntry.Issues): String = stringResource(
    when (issue) {
        HealthEntry.Issues.WEAK -> R.string.weldpass_health_weak
        HealthEntry.Issues.REUSED -> R.string.weldpass_health_reused
        HealthEntry.Issues.OLD -> R.string.weldpass_health_old
    },
)

/** A login with its issues as badges (weak in red, reused in amber, old neutral) and its site. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun HealthRow(entry: HealthEntry, onClick: () -> Unit) {
    Column {
        Row(
            Modifier
                .fillMaxWidth()
                .clickable(onClick = onClick)
                .padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.m)
                .tagged("health-${entry.title}"),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m),
        ) {
            TypeIcon(Item.Type.LOGIN)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.xs)) {
                Text(entry.title, style = rowTitleStyle(), maxLines = 1, overflow = TextOverflow.Ellipsis)
                entry.host?.takeIf { it.isNotBlank() }?.let { host ->
                    Text(host, style = secondaryTextStyle(), color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.xs)) {
                    PassLogic.issueOrder.filter { it in entry.issues }.forEach { issue ->
                        when (issue) {
                            HealthEntry.Issues.WEAK -> StatusBadge(stringResource(R.string.weldpass_health_weak), Tokens.Status.danger.current())
                            HealthEntry.Issues.REUSED -> StatusBadge(
                                pluralStringResource(R.plurals.weldpass_health_reused_on, entry.reuseCount, entry.reuseCount),
                                Tokens.Status.warning.current(),
                            )
                            HealthEntry.Issues.OLD -> NeutralBadge(stringResource(R.string.weldpass_health_old))
                        }
                    }
                }
            }
        }
        RowDivider()
    }
}
