package com.weldsuite.welddesk.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.HowToReg
import androidx.compose.material.icons.outlined.PersonRemove
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import org.weldsuite.ui.ModalBottomSheet
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.weldsuite.welddesk.DeskLogic
import com.weldsuite.welddesk.R
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged

/**
 * Who to assign the conversation to, as the platform's assign menu: the
 * search, "Assign to me" first, the team (a check on the assignee), and
 * "Unassign" last, in red. The roster loads the first time it opens.
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
    val colors = MaterialTheme.colorScheme
    ModalBottomSheet(onDismissRequest = onDismiss, modifier = Modifier.tagged("assignee-sheet")) {
        Column(Modifier.fillMaxWidth().heightIn(max = 560.dp)) {
            Text(
                stringResource(R.string.welddesk_conversation_assign_title),
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.padding(horizontal = Tokens.Spacing.l).padding(bottom = Tokens.Spacing.m),
            )
            DeskSearchField(
                value = search,
                onValueChange = { search = it },
                placeholder = stringResource(R.string.welddesk_conversation_search_members),
                clearLabel = stringResource(R.string.welddesk_inbox_search_clear),
                modifier = Modifier.fillMaxWidth().padding(horizontal = Tokens.Spacing.l),
                tag = "assignee-search",
            )
            HorizontalDivider(Modifier.padding(top = Tokens.Spacing.m), color = colors.outlineVariant)
            val mine = !currentAssigneeId.isNullOrEmpty() && currentAssigneeId == userId
            LazyColumn(Modifier.fillMaxWidth().padding(vertical = Tokens.Spacing.xs)) {
                if (userId != null && !mine && search.isBlank()) {
                    item("assign-to-me") {
                        PickerRow(
                            label = stringResource(R.string.welddesk_conversation_assign_to_me),
                            tag = "assign-to-me",
                            leading = { Icon(Icons.Outlined.HowToReg, contentDescription = null, modifier = Modifier.size(16.dp)) },
                        ) { onSelect(userId) }
                    }
                }
                when {
                    members == null && state.membersError -> item("error") {
                        Column(Modifier.fillMaxWidth().padding(Tokens.Spacing.xl), horizontalAlignment = Alignment.CenterHorizontally) {
                            Text(stringResource(R.string.welddesk_conversation_members_error), color = colors.onSurfaceVariant, textAlign = TextAlign.Center)
                            TextButton(onClick = { onLoad(true) }, modifier = Modifier.tagged("retry")) {
                                Text(stringResource(org.weldsuite.core.R.string.core_common_try_again))
                            }
                        }
                    }
                    visible == null -> item("loading") {
                        Box(Modifier.fillMaxWidth().padding(Tokens.Spacing.xl), contentAlignment = Alignment.Center) {
                            CircularProgressIndicator(Modifier.size(20.dp), color = colors.onSurfaceVariant, strokeWidth = 2.dp)
                        }
                    }
                    visible.isEmpty() -> item("empty") {
                        Text(
                            stringResource(R.string.welddesk_conversation_no_members),
                            style = MaterialTheme.typography.bodyMedium,
                            color = colors.onSurfaceVariant,
                            textAlign = TextAlign.Center,
                            modifier = Modifier.fillMaxWidth().padding(Tokens.Spacing.xl),
                        )
                    }
                    else -> items(visible, key = { it.userId }) { member ->
                        val name = if (member.userId == userId) "${member.name} (${stringResource(R.string.welddesk_conversation_assigned_to_you)})" else member.name
                        PickerRow(
                            label = name,
                            tag = "assignee-${member.userId}",
                            leading = { InitialAvatar(member.name, url = member.picture, size = 22.dp) },
                            trailing = if (member.userId == currentAssigneeId) {
                                { Icon(Icons.Outlined.Check, contentDescription = null, tint = colors.primary, modifier = Modifier.size(16.dp)) }
                            } else {
                                null
                            },
                        ) { onSelect(member.userId) }
                    }
                }
                if (!currentAssigneeId.isNullOrEmpty()) {
                    item("unassign") {
                        val danger = colors.error
                        PickerRow(
                            label = stringResource(R.string.welddesk_conversation_unassign),
                            tag = "assignee-unassign",
                            color = danger,
                            leading = { Icon(Icons.Outlined.PersonRemove, contentDescription = null, tint = danger, modifier = Modifier.size(16.dp)) },
                        ) { onSelect(null) }
                    }
                }
            }
        }
    }
}

/** One choice of the assign menu: an icon or avatar, the label, and a check on the current one. */
@Composable
private fun PickerRow(
    label: String,
    tag: String,
    color: Color = MaterialTheme.colorScheme.onSurface,
    leading: @Composable () -> Unit,
    trailing: (@Composable () -> Unit)? = null,
    onClick: () -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .clickable(onClick = onClick)
            .padding(horizontal = Tokens.Spacing.l)
            .tagged(tag),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m),
    ) {
        Box(Modifier.size(22.dp), contentAlignment = Alignment.Center) { leading() }
        Text(label, style = MaterialTheme.typography.bodyMedium, color = color, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        trailing?.invoke()
    }
}
