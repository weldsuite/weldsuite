package com.weldsuite.weldchat.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Tag
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import com.weldsuite.weldchat.ChannelNames
import com.weldsuite.weldchat.ChatStore
import com.weldsuite.weldchat.R
import com.weldsuite.weldchat.text
import com.weldsuite.weldchat.ui.BackButton
import com.weldsuite.weldchat.ui.ChatNavigator
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.weldsuite.core.SessionState
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged
import org.weldsuite.core.R as CoreR

/**
 * A new channel, one thing per step as Slack does it on mobile: the name,
 * then public or private (and its category on Home), then, for a private
 * channel, who is in it. A public channel already includes everyone. A
 * taken name (409) goes back to the name.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NewChannelScreen(store: ChatStore, session: SessionState.Ready, sectionId: String?, nav: ChatNavigator) {
    val scope = rememberCoroutineScope()
    var step by rememberSaveable { mutableIntStateOf(0) }
    var name by rememberSaveable { mutableStateOf("") }
    var isPrivate by rememberSaveable { mutableStateOf(false) }
    var chosenSection by rememberSaveable { mutableStateOf(sectionId) }
    var query by rememberSaveable { mutableStateOf("") }
    var selected by rememberSaveable { mutableStateOf(listOf<String>()) }
    var creating by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<Int?>(null) }
    val selfId = session.person.id

    LaunchedEffect(Unit) {
        if (store.sections.isEmpty()) store.loadHome()
        store.loadRosterIfNeeded()
    }

    fun go(next: Int) {
        error = null
        step = maxOf(0, next)
    }

    fun create() {
        val finalName = NewChannelRules.finalName(name)
        if (finalName.isEmpty() || creating) return
        creating = true
        error = null
        scope.launch {
            try {
                val id = store.repository.createChannel(finalName, isPrivate, chosenSection, if (isPrivate) selected else emptyList())
                store.loadHome()
                val type = if (isPrivate) "private" else "public"
                nav.finishSheet { openConversation(id, finalName, type) }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                creating = false
                if (NewChannelRules.isNameTaken(failure)) {
                    // The name is what has to change: back to it.
                    step = 0
                    error = R.string.weldchat_new_channel_name_taken
                } else {
                    error = R.string.weldchat_new_channel_create_failed
                }
            }
        }
    }

    fun primary() {
        if (!NewChannelRules.canContinue(step, name, creating)) return
        if (step < NewChannelRules.lastStep(isPrivate)) go(step + 1) else create()
    }

    BackHandler(enabled = step > 0 || creating) { if (!creating) go(step - 1) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(NewChannelRules.title(step))) },
                navigationIcon = {
                    if (step == 0) {
                        IconButton(onClick = { nav.back() }, enabled = !creating, modifier = Modifier.tagged("new-channel-cancel")) {
                            Icon(Icons.Filled.Close, contentDescription = stringResource(CoreR.string.core_common_cancel))
                        }
                    } else {
                        BackButton(onClick = { if (!creating) go(step - 1) }, tag = "new-channel-back")
                    }
                },
                actions = {
                    if (creating) {
                        CircularProgressIndicator(Modifier.padding(end = Tokens.Spacing.l).size(24.dp), strokeWidth = 2.dp)
                    } else {
                        TextButton(
                            onClick = { primary() },
                            enabled = NewChannelRules.canContinue(step, name, creating),
                            modifier = Modifier.tagged("new-channel-next"),
                        ) {
                            Text(NewChannelRules.primaryLabel(step, isPrivate, selected.size).text(), fontWeight = FontWeight.SemiBold)
                        }
                    }
                },
            )
        },
    ) { padding ->
        Box(Modifier.padding(padding).fillMaxSize().imePadding()) {
            when (step) {
                0 -> NameStep(name, isPrivate, error, onName = {
                    name = ChannelNames.normalize(it)
                    error = null
                }, onSubmit = { primary() })
                1 -> VisibilityStep(
                    store = store,
                    workspaceName = session.workspace.name.ifEmpty { stringResource(R.string.weldchat_home_workspace_fallback) },
                    isPrivate = isPrivate,
                    sectionId = chosenSection,
                    error = error,
                    onPrivate = { isPrivate = it },
                    onSection = { chosenSection = it },
                )
                else -> PeopleStep(
                    store = store,
                    selfId = selfId,
                    name = NewChannelRules.finalName(name),
                    query = query,
                    onQuery = { query = it },
                    selected = selected,
                    error = error,
                    onToggle = { userId -> if (!creating) selected = NewDmRules.toggled(selected, userId) },
                )
            }
        }
    }
}

@Composable
private fun NameStep(name: String, isPrivate: Boolean, error: Int?, onName: (String) -> Unit, onSubmit: () -> Unit) {
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(Tokens.Spacing.l), verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
        Text(stringResource(R.string.weldchat_new_channel_name_label), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
        val remaining = ChannelNames.MAX_LENGTH - name.length
        OutlinedTextField(
            value = name,
            onValueChange = onName,
            placeholder = { Text(stringResource(R.string.weldchat_new_channel_name_placeholder)) },
            leadingIcon = { Icon(if (isPrivate) Icons.Filled.Lock else Icons.Filled.Tag, contentDescription = null) },
            trailingIcon = {
                Text(
                    remaining.toString(),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(end = Tokens.Spacing.s),
                )
            },
            supportingText = null,
            singleLine = true,
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, imeAction = ImeAction.Next),
            keyboardActions = KeyboardActions(onNext = { onSubmit() }),
            modifier = Modifier.fillMaxWidth().focusRequester(focus).tagged("new-channel-name"),
        )
        if (error != null) {
            InlineError(stringResource(error))
        } else {
            Text(stringResource(R.string.weldchat_new_channel_name_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun VisibilityStep(
    store: ChatStore,
    workspaceName: String,
    isPrivate: Boolean,
    sectionId: String?,
    error: Int?,
    onPrivate: (Boolean) -> Unit,
    onSection: (String?) -> Unit,
) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(vertical = Tokens.Spacing.l), verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.s)) {
        Text(
            stringResource(R.string.weldchat_new_channel_visibility_label),
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = Tokens.Spacing.l),
        )
        VisibilityOption(
            Icons.Filled.Tag,
            stringResource(R.string.weldchat_new_channel_public_title),
            stringResource(R.string.weldchat_new_channel_public_hint, workspaceName),
            selected = !isPrivate,
            tag = "new-channel-public",
        ) { onPrivate(false) }
        VisibilityOption(
            Icons.Filled.Lock,
            stringResource(R.string.weldchat_new_channel_private_title),
            stringResource(R.string.weldchat_new_channel_private_hint),
            selected = isPrivate,
            tag = "new-channel-private",
        ) { onPrivate(true) }
        if (error != null) InlineError(stringResource(error), Modifier.padding(horizontal = Tokens.Spacing.l))

        val sections = store.sections
        if (sections.isNotEmpty()) {
            Text(
                stringResource(R.string.weldchat_new_channel_category_label),
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(start = Tokens.Spacing.l, end = Tokens.Spacing.l, top = Tokens.Spacing.l),
            )
            FlowRow(
                Modifier.padding(horizontal = Tokens.Spacing.l),
                horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
            ) {
                FilterChip(
                    selected = sectionId == null,
                    onClick = { onSection(null) },
                    label = { Text(stringResource(R.string.weldchat_new_channel_no_category)) },
                    modifier = Modifier.tagged("new-channel-category-none"),
                )
                sections.forEach { section ->
                    FilterChip(
                        selected = sectionId == section.id,
                        onClick = { onSection(section.id) },
                        label = { Text(section.name) },
                        modifier = Modifier.tagged("new-channel-category-${section.id}"),
                    )
                }
            }
            Text(
                stringResource(R.string.weldchat_new_channel_category_hint),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = Tokens.Spacing.l),
            )
        }
    }
}

@Composable
private fun VisibilityOption(icon: ImageVector, title: String, hint: String, selected: Boolean, tag: String, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .tagged(tag)
            .padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.m),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m),
    ) {
        Icon(icon, contentDescription = null)
        Column(Modifier.weight(1f)) {
            Text(title, fontWeight = FontWeight.SemiBold)
            Text(hint, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        SelectionMark(selected)
    }
}

@Composable
private fun PeopleStep(
    store: ChatStore,
    selfId: String,
    name: String,
    query: String,
    onQuery: (String) -> Unit,
    selected: List<String>,
    error: Int?,
    onToggle: (String) -> Unit,
) {
    val people = NewChannelRules.people(store.roster, selfId, query)
    LazyColumn(Modifier.fillMaxSize().tagged("new-channel-people")) {
        item("search") {
            ChatSearchField(
                placeholder = stringResource(R.string.weldchat_new_channel_people_search),
                text = query,
                onTextChange = onQuery,
                tag = "new-channel-people-search",
                modifier = Modifier.padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.s),
            )
        }
        item("hint") {
            Text(
                stringResource(R.string.weldchat_new_channel_people_hint, name.ifEmpty { stringResource(R.string.weldchat_new_channel_name_placeholder) }),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = Tokens.Spacing.l),
            )
        }
        if (error != null) {
            item("error") { InlineError(stringResource(error), Modifier.padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.xs)) }
        }
        when {
            store.roster.isEmpty() -> item("loading") {
                Box(Modifier.fillMaxWidth().padding(Tokens.Spacing.xl), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            }
            people.isEmpty() -> item("none") { QuietLine(stringResource(R.string.weldchat_new_channel_no_people)) }
            else -> items(people, key = { it.userId }) { member ->
                PickPersonRow(
                    name = member.displayName,
                    email = if (member.name != null) member.email else null,
                    picture = member.picture,
                    selected = member.userId in selected,
                    modifier = Modifier.clickable { onToggle(member.userId) }.tagged("person-row-${member.userId}"),
                )
            }
        }
    }
}
