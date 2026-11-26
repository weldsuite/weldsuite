package com.weldsuite.weldpass.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Group
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
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
import org.weldsuite.ui.EmptyState
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
                    state.data == null -> item { EmptyState(stringResource(passErrorMessage(state.error))) }
                    sorted.isEmpty() -> item {
                        EmptyState(
                            stringResource(R.string.weldpass_vaults_empty),
                            stringResource(R.string.weldpass_vaults_empty_description),
                        )
                    }
                    else -> items(sorted, key = { it.id }) { vault -> VaultRow(vault) { onOpen(vault.id) } }
                }
            }
        }
    }
}

@Composable
private fun VaultRow(vault: Vault, onClick: () -> Unit) {
    val personal = vault.kind == Vault.Kind.PERSONAL
    ListItem(
        headlineContent = { Text(vaultLabel(vault), maxLines = 1, overflow = TextOverflow.Ellipsis) },
        supportingContent = {
            Text(
                if (personal) stringResource(R.string.weldpass_vaults_personal_description) else vaultSummary(vault),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        },
        leadingContent = {
            Box(
                Modifier.size(40.dp).background(MaterialTheme.colorScheme.primaryContainer, RoundedCornerShape(Tokens.Radius.medium)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    if (personal) Icons.Outlined.Lock else Icons.Outlined.Group,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary,
                )
            }
        },
        modifier = Modifier.clickable(onClick = onClick).tagged("vault-${if (personal) "personal" else vault.name}"),
    )
}

/** "12 items · 4 members · Can edit" for a shared vault. */
@Composable
private fun vaultSummary(vault: Vault): String {
    val parts = mutableListOf<String>()
    vault.itemCount?.let { parts += pluralStringResource(R.plurals.weldpass_items_count, it, it) }
    vault.memberCount?.let { parts += pluralStringResource(R.plurals.weldpass_vaults_members, it, it) }
    when (vault.role) {
        Vault.Role.VIEWER -> parts += stringResource(R.string.weldpass_vaults_roles_viewer)
        Vault.Role.EDITOR -> parts += stringResource(R.string.weldpass_vaults_roles_editor)
        Vault.Role.MANAGER -> parts += stringResource(R.string.weldpass_vaults_roles_manager)
        else -> Unit
    }
    return parts.joinToString(" · ")
}

/** One vault's items. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VaultScreen(
    repository: PassRepository,
    vaultId: String,
    onBack: () -> Unit,
    onOpen: (vaultId: String, itemId: String) -> Unit,
) {
    val vaults by repository.vaults.collectAsStateWithLifecycle()
    val vault = vaults.data?.firstOrNull { it.id == vaultId }
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(vault?.let { vaultLabel(it) }.orEmpty(), maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigationIcon = { BackButton(onBack) },
            )
        },
    ) { padding ->
        if (PassLogic.isNonMemberView(vault)) {
            EmptyState(stringResource(R.string.weldpass_vaults_not_member), modifier = Modifier.padding(padding))
            return@Scaffold
        }
        val note = when {
            vault?.kind == Vault.Kind.PERSONAL -> stringResource(R.string.weldpass_vaults_personal_description)
            vault != null && !PassLogic.canEditVault(vault) -> stringResource(R.string.weldpass_vaults_read_only)
            else -> null
        }
        ItemList(
            repository = repository,
            vaultId = vaultId,
            emptyTitle = stringResource(R.string.weldpass_vaults_no_items),
            emptyDescription = stringResource(R.string.weldpass_vaults_no_items_description),
            onOpen = onOpen,
            modifier = Modifier.padding(padding),
            header = note?.let {
                {
                    Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            },
        )
    }
}
