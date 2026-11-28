package com.weldsuite.weldpass.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.weldsuite.weldpass.PassLogic
import com.weldsuite.weldpass.PassRepository
import com.weldsuite.weldpass.R
import kotlinx.coroutines.launch
import org.weldsuite.api.weldpass.models.Vault
import org.weldsuite.ui.CenteredProgress
import org.weldsuite.ui.StatusBadge
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged

/** The vaults the person can see: their personal vault first, then shared ones by name. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VaultsScreen(repository: PassRepository, onOpen: (vaultId: String) -> Unit) {
    val state by repository.vaults.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val sorted = remember(state.data) { PassLogic.sortVaults(state.data.orEmpty()) }

    Scaffold(topBar = { TopAppBar(title = { Text(stringResource(R.string.weldpass_vaults_title)) }) }) { padding ->
        PullToRefreshBox(
            isRefreshing = state.loading && state.data != null,
            onRefresh = { scope.launch { repository.refresh() } },
            modifier = Modifier.padding(padding).fillMaxSize(),
        ) {
            LazyColumn(Modifier.fillMaxSize()) {
                when {
                    state.data == null && state.error == null -> item { CenteredProgress(Modifier.padding(top = 48.dp)) }
                    state.data == null -> item {
                        EmptyMessage(
                            icon = Icons.Outlined.ErrorOutline,
                            title = stringResource(passErrorMessage(state.error)),
                            action = stringResource(R.string.weldpass_common_try_again) to { scope.launch { repository.refresh() }; Unit },
                            actionTag = "retry",
                        )
                    }
                    sorted.isEmpty() -> item {
                        EmptyMessage(
                            icon = Icons.Outlined.Lock,
                            title = stringResource(R.string.weldpass_vaults_empty),
                            description = stringResource(R.string.weldpass_vaults_empty_description),
                        )
                    }
                    else -> {
                        item { RowDivider() }
                        items(sorted, key = { it.id }) { vault -> VaultRow(vault) { onOpen(vault.id) } }
                    }
                }
            }
        }
    }
}

/**
 * One vault, as the platform's vault list shows it: the name with its
 * description under it, your role as a badge, and the item and member counts.
 */
@Composable
private fun VaultRow(vault: Vault, onClick: () -> Unit) {
    val personal = vault.kind == Vault.Kind.PERSONAL
    val description = vault.description?.takeIf { it.isNotBlank() }
        ?: if (personal) stringResource(R.string.weldpass_vaults_personal_description) else null
    val counts = vaultCounts(vault)
    Column {
        Row(
            Modifier
                .fillMaxWidth()
                .clickable(onClick = onClick)
                .padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.m)
                .tagged("vault-${if (personal) "personal" else vault.name}"),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m),
        ) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(vaultLabel(vault), style = rowTitleStyle(), maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (description != null) {
                    Text(
                        description,
                        style = secondaryTextStyle(),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                if (counts.isNotEmpty()) {
                    Text(counts, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            RoleBadge(vault.role)
        }
        RowDivider()
    }
}

/** "Your role": a neutral badge, or an amber "Not a member" for an admin outside the vault. */
@Composable
private fun RoleBadge(role: Vault.Role?) {
    when (role) {
        null -> StatusBadge(stringResource(R.string.weldpass_vaults_roles_none), Tokens.Status.warning.current())
        Vault.Role.VIEWER -> NeutralBadge(stringResource(R.string.weldpass_vaults_roles_viewer))
        Vault.Role.EDITOR -> NeutralBadge(stringResource(R.string.weldpass_vaults_roles_editor))
        Vault.Role.MANAGER -> NeutralBadge(stringResource(R.string.weldpass_vaults_roles_manager))
    }
}

/**
 * "12 items · 4 members": the platform's Items and Members columns. A
 * personal vault has no members to count, and an admin outside a vault sees
 * no items.
 */
@Composable
private fun vaultCounts(vault: Vault): String {
    val parts = mutableListOf<String>()
    if (vault.role != null) {
        val items = vault.itemCount ?: 0
        parts += pluralStringResource(R.plurals.weldpass_items_count, items, items)
    }
    if (vault.kind == Vault.Kind.SHARED) {
        val members = vault.memberCount ?: 0
        parts += pluralStringResource(R.plurals.weldpass_vaults_members, members, members)
    }
    return parts.joinToString(" · ")
}

/** One vault's items: the platform's vault page. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VaultScreen(
    repository: PassRepository,
    vaultId: String,
    onBack: () -> Unit,
    onOpen: (vaultId: String, itemId: String) -> Unit,
    onAdd: (vaultId: String) -> Unit,
) {
    val vaults by repository.vaults.collectAsStateWithLifecycle()
    val vault = vaults.data?.firstOrNull { it.id == vaultId }
    val canAdd = PassLogic.canEditVault(vault)
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(vault?.let { vaultLabel(it) }.orEmpty(), maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigationIcon = { BackButton(onBack) },
                actions = { if (canAdd) AddButton({ onAdd(vaultId) }, "add-item-in-vault") },
            )
        },
    ) { padding ->
        if (PassLogic.isNonMemberView(vault)) {
            EmptyMessage(
                icon = Icons.Outlined.Lock,
                title = stringResource(R.string.weldpass_vaults_not_member_title),
                description = stringResource(R.string.weldpass_vaults_not_member),
                modifier = Modifier.padding(padding),
            )
            return@Scaffold
        }
        val note = when {
            vault?.kind == Vault.Kind.PERSONAL -> stringResource(R.string.weldpass_vaults_personal_description)
            vault != null && !canAdd -> stringResource(R.string.weldpass_vaults_read_only)
            else -> null
        }
        ItemList(
            repository = repository,
            vaultId = vaultId,
            emptyTitle = stringResource(R.string.weldpass_vaults_no_items),
            emptyDescription = stringResource(R.string.weldpass_vaults_no_items_description),
            onOpen = onOpen,
            onAdd = if (canAdd) ({ onAdd(vaultId) }) else null,
            modifier = Modifier.padding(padding),
            header = note?.let {
                {
                    Text(it, style = secondaryTextStyle(), color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            },
        )
    }
}
