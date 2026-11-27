package com.weldsuite.weldchat.ui.channel

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.RadioButtonUnchecked
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.weldsuite.weldchat.ChannelRules
import com.weldsuite.weldchat.ChatStore
import com.weldsuite.weldchat.R
import com.weldsuite.weldchat.ui.ChatAvatar
import com.weldsuite.weldchat.ui.ChatNavigator
import com.weldsuite.weldchat.ui.LocalNotify
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged
import org.weldsuite.core.R as CoreR

/**
 * Invite people to a channel (from its long-press menu, the iOS
 * `InvitePeopleView`): the workspace's people who aren't in it yet, pick
 * one or more, Add. [name] is the channel's, for the screen's context.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InvitePeopleScreen(
    store: ChatStore,
    channelId: String,
    name: String,
    nav: ChatNavigator,
) {
    val context = LocalContext.current
    val notify = LocalNotify.current
    val scope = rememberCoroutineScope()
    var memberIds by remember { mutableStateOf<Set<String>>(emptySet()) }
    var loading by remember { mutableStateOf(true) }
    var search by remember { mutableStateOf("") }
    var selected by remember { mutableStateOf<List<String>>(emptyList()) }
    var adding by remember { mutableStateOf(false) }
    val failed = stringResource(R.string.weldchat_invite_people_failed)
    val people = ChannelRules.invitable(store.roster, memberIds, search)

    /** Everyone in the workspace, minus who is already in the channel. */
    LaunchedEffect(channelId) {
        store.loadRosterIfNeeded()
        try {
            memberIds = store.repository.channelMembers(channelId).map { it.userId }.toSet()
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            // Everyone is offered; the server ignores who is already in.
        }
        loading = false
    }

    fun toggle(userId: String) {
        if (adding) return
        selected = if (userId in selected) selected - userId else selected + userId
    }

    fun add() {
        if (adding || selected.isEmpty()) return
        adding = true
        val chosen = selected
        scope.launch {
            try {
                store.repository.addMembers(channelId, chosen)
                notify(context.resources.getQuantityString(R.plurals.weldchat_invite_people_added, chosen.size, chosen.size))
                nav.finishSheet()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                notify(failed)
                adding = false
            }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(stringResource(R.string.weldchat_invite_people_title))
                        if (name.isNotEmpty()) {
                            Text("#$name", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                        }
                    }
                },
                navigationIcon = {
                    IconButton(onClick = { nav.finishSheet() }, modifier = Modifier.tagged("invite-cancel")) {
                        Icon(Icons.Filled.Close, contentDescription = stringResource(CoreR.string.core_common_cancel))
                    }
                },
                actions = {
                    if (adding) {
                        CircularProgressIndicator(Modifier.padding(end = Tokens.Spacing.l).size(24.dp))
                    } else {
                        TextButton(onClick = ::add, enabled = selected.isNotEmpty(), modifier = Modifier.tagged("invite-add")) {
                            Text(
                                if (selected.size > 1) {
                                    stringResource(R.string.weldchat_invite_people_add_with_count, selected.size)
                                } else {
                                    stringResource(R.string.weldchat_invite_people_add)
                                },
                            )
                        }
                    }
                },
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            OutlinedTextField(
                value = search,
                onValueChange = { search = it },
                singleLine = true,
                placeholder = { Text(stringResource(R.string.weldchat_invite_people_search)) },
                leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
                modifier = Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.s).tagged("invite-search"),
            )
            when {
                loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                people.isEmpty() -> Text(
                    stringResource(if (search.isBlank()) R.string.weldchat_invite_people_everyone_in else R.string.weldchat_invite_people_no_match),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth().padding(Tokens.Spacing.xl).tagged("invite-empty"),
                )
                else -> LazyColumn(Modifier.fillMaxSize().tagged("invite-list")) {
                    items(people, key = { it.userId }) { member ->
                        val isSelected = member.userId in selected
                        ListItem(
                            headlineContent = { Text(member.displayName, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                            leadingContent = { ChatAvatar(member.displayName, member.picture, 36.dp) },
                            trailingContent = {
                                Icon(
                                    if (isSelected) Icons.Filled.CheckCircle else Icons.Filled.RadioButtonUnchecked,
                                    contentDescription = null,
                                    tint = if (isSelected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            },
                            modifier = Modifier
                                .clickable { toggle(member.userId) }
                                .semantics { this.selected = isSelected }
                                .tagged("person-row-${member.userId}"),
                        )
                    }
                }
            }
        }
    }
}
