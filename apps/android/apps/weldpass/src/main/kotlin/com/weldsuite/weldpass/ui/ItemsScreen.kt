package com.weldsuite.weldpass.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.SearchOff
import androidx.compose.material.icons.outlined.VerifiedUser
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.Alignment
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
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged

/** Every item the person can open, across vaults: the platform's Passwords page. */
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
        val vaults by repository.vaults.collectAsStateWithLifecycle()
        val copy = offline.readable
        val canAdd = vaults.data.orEmpty().any(PassLogic::canEditVault)
        ItemList(
            repository = repository,
            vaultId = null,
            emptyTitle = stringResource(R.string.weldpass_items_empty),
            emptyDescription = stringResource(R.string.weldpass_items_empty_description),
            onOpen = onOpen,
            onAdd = if (canAdd) onAdd else null,
            modifier = Modifier.padding(padding),
            header = if (offline.offline && copy != null) {
                {
                    Row(
                        Modifier.fillMaxWidth().padding(vertical = Tokens.Spacing.xs).tagged("offline-banner"),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
                    ) {
                        Icon(
                            Icons.Outlined.CloudOff,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.size(16.dp),
                        )
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
 * A searchable list of items: all of them grouped by vault, or one vault's.
 * Search and the type filter run on the phone over what a list carries
 * (titles, usernames, sites), never a secret, so a keystroke costs no request.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ItemList(
    repository: PassRepository,
    vaultId: String?,
    emptyTitle: String,
    emptyDescription: String,
    onOpen: (vaultId: String, itemId: String) -> Unit,
    onAdd: (() -> Unit)?,
    modifier: Modifier = Modifier,
    header: (@Composable () -> Unit)? = null,
) {
    val state by repository.items.collectAsStateWithLifecycle()
    val vaults by repository.vaults.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var query by rememberSaveable { mutableStateOf("") }
    var type by rememberSaveable { mutableStateOf<String?>(null) }
    val selectedType = type?.let { name -> Item.Type.entries.firstOrNull { it.name == name } }
    val visible = remember(state.data, query, selectedType, vaultId) {
        PassLogic.filterItems(state.data.orEmpty(), query, selectedType, vaultId)
    }
    // All items are grouped by vault, as on the platform; inside a vault they aren't.
    val groups = remember(visible, vaults.data, vaultId) {
        val known = vaults.data
        if (vaultId != null || known == null) listOf(null to visible) else PassLogic.groupByVault(visible, known)
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
                    Modifier.padding(horizontal = Tokens.Spacing.l).padding(bottom = Tokens.Spacing.m),
                    verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
                ) {
                    header?.invoke()
                    SearchField(query, onChange = { query = it })
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
                state.data == null -> item {
                    EmptyMessage(
                        icon = Icons.Outlined.ErrorOutline,
                        title = stringResource(passErrorMessage(state.error)),
                        action = stringResource(R.string.weldpass_common_try_again) to { scope.launch { repository.refresh() }; Unit },
                        actionTag = "retry",
                    )
                }
                visible.isEmpty() && filtering -> item {
                    EmptyMessage(
                        icon = Icons.Outlined.SearchOff,
                        title = stringResource(R.string.weldpass_items_no_matches),
                        description = stringResource(R.string.weldpass_items_no_matches_description),
                    )
                }
                visible.isEmpty() -> item {
                    EmptyMessage(
                        icon = Icons.Outlined.Lock,
                        title = emptyTitle,
                        description = emptyDescription,
                        action = onAdd?.let { stringResource(R.string.weldpass_items_add) to it },
                        actionTag = "empty-add-item",
                    )
                }
                else -> groupedRows(groups, onOpen)
            }
        }
    }
}

/** The rows, under a header per vault when there is more than the one group of a vault's own list. */
@OptIn(ExperimentalFoundationApi::class)
private fun LazyListScope.groupedRows(
    groups: List<Pair<org.weldsuite.api.weldpass.models.Vault?, List<Item>>>,
    onOpen: (vaultId: String, itemId: String) -> Unit,
) {
    groups.forEach { (vault, rows) ->
        if (vault != null) {
            stickyHeader(key = "group-${vault.id}") { GroupHeader(vaultLabel(vault), rows.size) }
        } else {
            item(key = "group-top") { RowDivider() }
        }
        items(rows, key = { it.id }) { item -> ItemRow(item) { onOpen(item.vaultId, item.id) } }
    }
}

/** The list's search box (`Search passwords`), with a way to clear it. */
@Composable
private fun SearchField(query: String, onChange: (String) -> Unit) {
    PlatformTextField(
        value = query,
        onValueChange = onChange,
        placeholder = stringResource(R.string.weldpass_items_search),
        keyboardOptions = KeyboardOptions(autoCorrectEnabled = false),
        leading = {
            Icon(Icons.Filled.Search, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(18.dp))
        },
        trailing = if (query.isNotEmpty()) {
            { FieldIconButton(Icons.Filled.Close, stringResource(R.string.weldpass_common_close), onClick = { onChange("") }) }
        } else {
            null
        },
        modifier = Modifier.tagged("search"),
    )
}

@Composable
private fun TypeChip(label: Int, selected: Boolean, onClick: () -> Unit) {
    FilterChip(selected = selected, onClick = onClick, label = { Text(stringResource(label)) })
}

/**
 * One item, as the platform's list row: the type's icon, the title with a
 * shield when it has a 2FA code, and the username and site under it.
 */
@Composable
private fun ItemRow(item: Item, onClick: () -> Unit) {
    val supporting = listOfNotNull(item.subtitle, item.host).filter { it.isNotBlank() }.joinToString(" · ")
    Column {
        Row(
            Modifier
                .fillMaxWidth()
                .clickable(onClick = onClick)
                .padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.m)
                .tagged("item-${item.title}"),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m),
        ) {
            TypeIcon(item.type)
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(
                        item.title,
                        style = rowTitleStyle(),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                    if (item.hasTotp) {
                        Icon(
                            Icons.Outlined.VerifiedUser,
                            contentDescription = stringResource(R.string.weldpass_items_has_totp),
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.size(14.dp),
                        )
                    }
                }
                if (supporting.isNotEmpty()) {
                    Text(
                        supporting,
                        style = secondaryTextStyle(),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
        RowDivider()
    }
}
