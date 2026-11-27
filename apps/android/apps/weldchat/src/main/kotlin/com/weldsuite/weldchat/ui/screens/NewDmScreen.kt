package com.weldsuite.weldchat.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
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
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.weldsuite.weldchat.ChatStore
import com.weldsuite.weldchat.R
import com.weldsuite.weldchat.text
import com.weldsuite.weldchat.ui.ChatNavigator
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.weldsuite.core.apiErrorMessage
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged
import org.weldsuite.core.R as CoreR

/**
 * A new direct message: pick one person (or, for a group, at least two)
 * and start. The server reuses a conversation with the same people.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NewDmScreen(store: ChatStore, userId: String, isGroup: Boolean, nav: ChatNavigator) {
    val scope = rememberCoroutineScope()
    var search by rememberSaveable { mutableStateOf("") }
    var selected by rememberSaveable { mutableStateOf(listOf<String>()) }
    var creating by remember { mutableStateOf(false) }
    var loaded by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<Int?>(null) }
    val people = NewDmRules.people(store.roster, userId, search)
    val minimum = NewDmRules.minimum(isGroup)

    LaunchedEffect(Unit) {
        store.loadRosterIfNeeded()
        loaded = true
    }

    fun start() {
        if (creating || selected.size < minimum) return
        creating = true
        error = null
        scope.launch {
            try {
                val dm = store.repository.createDm(selected, store.currentUserId)
                store.loadDmList()
                nav.finishSheet { openConversation(dm.id, dm.name, "dm") }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                error = apiErrorMessage(failure)
                creating = false
            }
        }
    }

    BackHandler(enabled = creating) {}

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(if (isGroup) R.string.weldchat_dms_new_group else R.string.weldchat_new_message_title)) },
                navigationIcon = {
                    IconButton(onClick = { nav.back() }, enabled = !creating, modifier = Modifier.tagged("new-dm-cancel")) {
                        Icon(Icons.Filled.Close, contentDescription = stringResource(CoreR.string.core_common_cancel))
                    }
                },
                actions = {
                    if (creating) {
                        CircularProgressIndicator(Modifier.padding(end = Tokens.Spacing.l).size(24.dp), strokeWidth = 2.dp)
                    } else {
                        TextButton(onClick = { start() }, enabled = selected.size >= minimum, modifier = Modifier.tagged("new-dm-start")) {
                            Text(NewDmRules.startLabel(selected.size).text(), fontWeight = FontWeight.SemiBold)
                        }
                    }
                },
            )
        },
    ) { padding ->
        LazyColumn(Modifier.padding(padding).fillMaxSize().tagged("new-dm-list")) {
            item("search") {
                ChatSearchField(
                    placeholder = stringResource(R.string.weldchat_invite_people_search),
                    text = search,
                    onTextChange = { search = it },
                    tag = "new-dm-search",
                    modifier = Modifier.padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.s),
                )
            }
            error?.let { message ->
                item("error") { InlineError(stringResource(message), Modifier.padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.xs)) }
            }
            when {
                !loaded && store.roster.isEmpty() -> item("loading") {
                    Box(Modifier.fillMaxWidth().padding(Tokens.Spacing.xl), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                }
                people.isEmpty() -> item("none") {
                    QuietLine(
                        stringResource(if (search.isBlank()) R.string.weldchat_dms_no_other_members else R.string.weldchat_invite_people_no_match),
                    )
                }
                else -> items(people, key = { it.userId }) { member ->
                    PickPersonRow(
                        name = member.displayName,
                        email = null,
                        picture = member.picture,
                        selected = member.userId in selected,
                        modifier = Modifier
                            .clickable { if (!creating) selected = NewDmRules.toggled(selected, member.userId) }
                            .tagged("person-row-${member.userId}"),
                    )
                }
            }
        }
    }
}
