package com.weldsuite.welddesk.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.PersonRemove
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.weldsuite.welddesk.DeskLogic
import com.weldsuite.welddesk.R
import org.weldsuite.ui.Avatar
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged

/**
 * Who to assign the conversation to: "Unassign" on top when it is assigned,
 * then the team, searchable. The roster loads the first time it opens.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AssigneeSheet(
    state: ConversationUiState,
    currentAssigneeId: String?,
    userId: String?,
    onLoad: (force: Boolean) -> Unit,
    onDismiss: () -> Unit,
    /** Null unassigns. */
    onSelect: (String?) -> Unit,
) {
    var search by rememberSaveable { mutableStateOf("") }
    LaunchedEffect(Unit) {
        if (state.members == null && !state.membersLoading) onLoad(false)
    }
    val members = state.members
    val visible = remember(members, search) { members?.let { DeskLogic.filterMembers(it, search) } }
    val brand = Tokens.Palette.primary.current()
    ModalBottomSheet(onDismissRequest = onDismiss, modifier = Modifier.tagged("assignee-sheet")) {
        Column(Modifier.fillMaxWidth().heightIn(max = 560.dp), verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
            Text(
                stringResource(R.string.welddesk_conversation_assign_title),
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.padding(horizontal = Tokens.Spacing.l),
            )
            if (!currentAssigneeId.isNullOrEmpty()) {
                ListItem(
                    headlineContent = { Text(stringResource(R.string.welddesk_conversation_unassign)) },
                    leadingContent = { Icon(Icons.Outlined.PersonRemove, contentDescription = null) },
                    modifier = Modifier.clickable { onSelect(null) }.tagged("assignee-unassign"),
                )
            }
            OutlinedTextField(
                value = search,
                onValueChange = { search = it },
                placeholder = { Text(stringResource(R.string.welddesk_conversation_search_members)) },
                leadingIcon = { Icon(Icons.Outlined.Search, contentDescription = null) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l).tagged("assignee-search"),
            )
            when {
                members == null && state.membersError -> Column(
                    Modifier.fillMaxWidth().padding(Tokens.Spacing.xl),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text(
                        stringResource(R.string.welddesk_conversation_members_error),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = TextAlign.Center,
                    )
                    TextButton(onClick = { onLoad(true) }, modifier = Modifier.tagged("retry")) {
                        Text(stringResource(org.weldsuite.core.R.string.core_common_try_again))
                    }
                }
                visible == null -> Box(Modifier.fillMaxWidth().padding(Tokens.Spacing.xl), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator()
                }
                visible.isEmpty() -> Text(
                    stringResource(R.string.welddesk_conversation_no_members),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth().padding(Tokens.Spacing.xl),
                )
                else -> LazyColumn(Modifier.fillMaxWidth()) {
                    items(visible, key = { it.userId }) { member ->
                        val me = member.userId == userId
                        val name = if (me) "${member.name} (${stringResource(R.string.welddesk_conversation_assigned_to_you)})" else member.name
                        ListItem(
                            headlineContent = { Text(name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                            supportingContent = if (member.email.isNotEmpty() && member.email != member.name) {
                                { Text(member.email, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                            } else {
                                null
                            },
                            leadingContent = { Avatar(member.name, member.picture, size = 32.dp) },
                            trailingContent = if (member.userId == currentAssigneeId) {
                                { Icon(Icons.Outlined.Check, contentDescription = null, tint = brand) }
                            } else {
                                null
                            },
                            modifier = Modifier.clickable { onSelect(member.userId) }.tagged("assignee-${member.userId}"),
                        )
                    }
                }
            }
        }
    }
}
