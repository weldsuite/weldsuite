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
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.Alignment
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.weldsuite.weldpass.PassLogic
import com.weldsuite.weldpass.PassRepository
import com.weldsuite.weldpass.R
import kotlinx.coroutines.launch
import org.weldsuite.api.weldpass.models.Item
import org.weldsuite.ui.CenteredProgress
import org.weldsuite.ui.EmptyState
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged

/** Every item the person can open, across vaults. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ItemsScreen(repository: PassRepository, onOpen: (vaultId: String, itemId: String) -> Unit, onAdd: () -> Unit) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.weldpass_items_title)) },
                actions = { AddButton(onAdd, "add-item") },
            )
        },
    ) { padding ->
        val offline by repository.offline.snapshot.collectAsStateWithLifecycle()
        val copy = offline.readable
        ItemList(
            repository = repository,
            vaultId = null,
            emptyTitle = stringResource(R.string.weldpass_items_empty),
            emptyDescription = stringResource(R.string.weldpass_items_empty_description),
            onOpen = onOpen,
            modifier = Modifier.padding(padding),
            header = if (offline.offline && copy != null) {
                {
                    Row(
                        Modifier.fillMaxWidth().padding(vertical = Tokens.Spacing.xs).tagged("offline-banner"),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
                    ) {
                        Icon(Icons.Outlined.CloudOff, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(
                            stringResource(R.string.weldpass_items_offline_banner, formatWhen(copy.syncedAt)),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            } else {
                null
            },
        )
    }
}

/**
 * A searchable list of items: all of them, or one vault's. Search and the
 * type filter run on the phone over what a list carries (titles, usernames,
 * sites), never a secret, so a keystroke costs no request.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ItemList(
    repository: PassRepository,
    vaultId: String?,
    emptyTitle: String,
    emptyDescription: String,
    onOpen: (vaultId: String, itemId: String) -> Unit,
    modifier: Modifier = Modifier,
    header: (@Composable () -> Unit)? = null,
) {
    val state by repository.items.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var query by rememberSaveable { mutableStateOf("") }
    var type by rememberSaveable { mutableStateOf<String?>(null) }
    val selectedType = type?.let { name -> Item.Type.entries.firstOrNull { it.name == name } }
    val visible = remember(state.data, query, selectedType, vaultId) {
        PassLogic.filterItems(state.data.orEmpty(), query, selectedType, vaultId)
    }
    val filtering = query.isNotBlank() || selectedType != null

    PullToRefreshBox(
        isRefreshing = state.loading && state.data != null,
        onRefresh = { scope.launch { repository.refresh() } },
        modifier = modifier.fillMaxSize(),
    ) {
        LazyColumn(Modifier.fillMaxSize()) {
            item {
                Column(
                    Modifier.padding(horizontal = Tokens.Spacing.l).padding(bottom = Tokens.Spacing.s),
                    verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
                ) {
                    header?.invoke()
                    OutlinedTextField(
                        value = query,
                        onValueChange = { query = it },
                        placeholder = { Text(stringResource(R.string.weldpass_items_search)) },
                        leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth().tagged("search"),
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
                        TypeChip(R.string.weldpass_items_all, selected = selectedType == null) { type = null }
                        TypeChip(R.string.weldpass_types_login_plural, selected = selectedType == Item.Type.LOGIN) { type = Item.Type.LOGIN.name }
                        TypeChip(R.string.weldpass_types_note_plural, selected = selectedType == Item.Type.NOTE) { type = Item.Type.NOTE.name }
                        TypeChip(R.string.weldpass_types_card_plural, selected = selectedType == Item.Type.CARD) { type = Item.Type.CARD.name }
                    }
                }
            }
            when {
                state.data == null && state.error == null -> item { CenteredProgress(Modifier.padding(top = 48.dp)) }
                state.data == null -> item { EmptyState(stringResource(passErrorMessage(state.error))) }
                visible.isEmpty() && filtering -> item {
                    EmptyState(
                        stringResource(R.string.weldpass_items_no_matches),
                        stringResource(R.string.weldpass_items_no_matches_description),
                    )
                }
                visible.isEmpty() -> item { EmptyState(emptyTitle, emptyDescription) }
                else -> items(visible, key = { it.id }) { item -> ItemRow(item) { onOpen(item.vaultId, item.id) } }
            }
        }
    }
}

@Composable
private fun TypeChip(label: Int, selected: Boolean, onClick: () -> Unit) {
    FilterChip(selected = selected, onClick = onClick, label = { Text(stringResource(label)) })
}

@Composable
private fun ItemRow(item: Item, onClick: () -> Unit) {
    val supporting = listOfNotNull(item.subtitle, item.host).joinToString(" · ")
    ListItem(
        headlineContent = { Text(item.title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        supportingContent = if (supporting.isNotEmpty()) {
            { Text(supporting, maxLines = 1, overflow = TextOverflow.Ellipsis) }
        } else {
            null
        },
        leadingContent = { ItemIcon(item.type) },
        modifier = Modifier.clickable(onClick = onClick).tagged("item-${item.title}"),
    )
}
