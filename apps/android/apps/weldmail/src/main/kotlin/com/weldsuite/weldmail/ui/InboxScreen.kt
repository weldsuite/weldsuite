package com.weldsuite.weldmail.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AccessTime
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Archive
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Drafts
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.ExpandLess
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.Inbox
import androidx.compose.material.icons.outlined.Mail
import androidx.compose.material.icons.outlined.Menu
import androidx.compose.material.icons.outlined.PushPin
import androidx.compose.material.icons.outlined.Unsubscribe
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.weldsuite.weldmail.DateGroup
import com.weldsuite.weldmail.InboxFilter
import com.weldsuite.weldmail.MailAccount
import com.weldsuite.weldmail.MailLogic
import com.weldsuite.weldmail.MailMessage
import com.weldsuite.weldmail.MailStore
import com.weldsuite.weldmail.Mailbox
import com.weldsuite.weldmail.R
import com.weldsuite.weldmail.SystemLabel
import kotlinx.coroutines.launch
import org.weldsuite.core.SessionState
import org.weldsuite.core.apiErrorMessage
import org.weldsuite.ui.ExtendedFloatingActionButton
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged
import kotlin.math.roundToInt

/** The inbox: a folder of one mailbox or of all of them, with the mailbox menu in a drawer. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InboxScreen(
    store: MailStore,
    session: SessionState.Ready,
    onOpen: (String) -> Unit,
    onCompose: () -> Unit,
    onSearch: () -> Unit,
    onSubscriptions: () -> Unit,
    onAddAccount: () -> Unit,
    onSwitchWorkspace: (String) -> Unit,
    aiAvailable: Boolean,
) {
    val inbox by store.inbox.collectAsStateWithLifecycle()
    val label by store.label.collectAsStateWithLifecycle()
    val labels by store.labels.collectAsStateWithLifecycle()
    val online by store.connectivity.online.collectAsStateWithLifecycle()
    val accountsLoaded by store.accountsLoaded.collectAsStateWithLifecycle()
    val accounts by store.accounts.collectAsStateWithLifecycle()
    val drawer = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    val notify = LocalNotify.current
    val context = LocalContext.current
    var filter by rememberSaveable { mutableStateOf(InboxFilter.ALL) }
    var snoozing by remember { mutableStateOf<MailMessage?>(null) }

    val visible = remember(inbox.messages, filter) { MailLogic.filter(inbox.messages, filter) }
    val sections = remember(visible) { MailLogic.sections(visible) }
    LaunchedEffect(sections) { store.visibleIds = sections.flatMap { section -> section.messages.map { it.id } } }
    val labelColors = remember(labels.custom) { labels.custom.associate { it.name to it.color } }
    val outgoing = MailLogic.isOutgoingFolder(label)

    val system = SystemLabel.of(label)
    val title = system?.let { stringResource(systemLabelName(it)) } ?: labels.custom.firstOrNull { it.slug == label }?.name ?: label

    ModalNavigationDrawer(
        drawerState = drawer,
        drawerContent = {
            MailboxDrawer(
                store = store,
                session = session,
                onLabel = { slug ->
                    scope.launch { drawer.close() }
                    store.selectLabel(slug)
                },
                onMailbox = { mailbox ->
                    scope.launch { drawer.close() }
                    store.selectMailbox(mailbox)
                },
                onOtherWorkspace = { account ->
                    scope.launch { drawer.close() }
                    account.workspaceId?.let { workspace ->
                        store.preselect(workspace, account.id)
                        onSwitchWorkspace(workspace)
                    }
                },
                onSubscriptions = {
                    scope.launch { drawer.close() }
                    onSubscriptions()
                },
                onAddAccount = {
                    scope.launch { drawer.close() }
                    onAddAccount()
                },
                aiAvailable = aiAvailable,
            )
        },
    ) {
        Scaffold(
            topBar = {
                TopAppBar(
                    title = { Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    navigationIcon = {
                        IconButton(onClick = { scope.launch { drawer.open() } }, modifier = Modifier.tagged("open-mailboxes")) {
                            Icon(Icons.Outlined.Menu, contentDescription = stringResource(R.string.weldmail_inbox_open_mailboxes))
                        }
                    },
                )
            },
            floatingActionButton = {
                ExtendedFloatingActionButton(
                    onClick = onCompose,
                    icon = { Icon(Icons.Outlined.Edit, contentDescription = null) },
                    text = { Text(stringResource(R.string.weldmail_inbox_compose)) },
                    modifier = Modifier.tagged("compose"),
                )
            },
        ) { padding ->
            Column(Modifier.padding(padding).fillMaxSize()) {
                if (!online) OfflineBanner()
                PullToRefreshBox(
                    isRefreshing = inbox.refreshing,
                    onRefresh = { scope.launch { store.refresh(pullToRefresh = true) } },
                    modifier = Modifier.fillMaxSize(),
                ) {
                    val listState = rememberLazyListState()
                    val nearEnd by remember {
                        derivedStateOf {
                            val last = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
                            last >= listState.layoutInfo.totalItemsCount - 10
                        }
                    }
                    LaunchedEffect(nearEnd, inbox.cursor) { if (nearEnd && inbox.cursor != null) store.loadMore() }
                    LazyColumn(state = listState, modifier = Modifier.fillMaxSize().tagged("inbox-list")) {
                        item("controls") {
                            ListControls(filter = filter, onFilter = { filter = it }, onSearch = onSearch)
                        }
                        when {
                            inbox.loading && inbox.messages.isEmpty() -> item("loading") {
                                Box(Modifier.fillMaxWidth().padding(48.dp), contentAlignment = Alignment.Center) {
                                    CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
                                }
                            }
                            accountsLoaded && accounts.none { it.inActiveWorkspace } && inbox.messages.isEmpty() -> item("no-mailbox") {
                                MailEmptyState(
                                    icon = Icons.Outlined.Mail,
                                    title = stringResource(R.string.weldmail_empty_no_mailbox_title),
                                    description = stringResource(R.string.weldmail_empty_no_mailbox_description),
                                )
                            }
                            sections.isEmpty() -> item("empty") {
                                val (emptyTitle, emptyDescription) = emptyText(system)
                                MailEmptyState(
                                    icon = emptyIcon(system),
                                    title = stringResource(emptyTitle),
                                    description = stringResource(emptyDescription),
                                )
                            }
                            else -> sections.forEachIndexed { index, section ->
                                // As on the platform, today's mail at the top of the list has no header.
                                if (index > 0 || section.group.kind != DateGroup.Kind.TODAY) {
                                    item("group-${section.group.kind}-${section.group.day}-${section.group.weeks}") {
                                        GroupHeader(groupTitle(section.group), section.messages.size)
                                    }
                                }
                                items(section.messages, key = { "message-${it.id}" }) { message ->
                                    SwipeableMessageRow(
                                        message = message,
                                        pinned = MailLogic.isPinned(message),
                                        outgoing = outgoing,
                                        labelColors = labelColors,
                                        onOpen = {
                                            if (!message.isRead) scope.launch { store.setRead(message.id, true) }
                                            onOpen(message.id)
                                        },
                                        onToggleRead = { scope.launch { store.setRead(message.id, !message.isRead) } },
                                        onPin = {
                                            scope.launch {
                                                try {
                                                    store.setPinned(message.id, message.labels, !MailLogic.isPinned(message))
                                                } catch (error: Exception) {
                                                    notify.show(context.getString(apiErrorMessage(error)))
                                                }
                                            }
                                        },
                                        onSnooze = { snoozing = message },
                                        onArchive = { scope.launch { store.archive(message.id) } },
                                        onDelete = { scope.launch { store.delete(message.id) } },
                                    )
                                }
                            }
                        }
                        if (inbox.loadingMore) {
                            item("more") {
                                Box(Modifier.fillMaxWidth().padding(Tokens.Spacing.l), contentAlignment = Alignment.Center) {
                                    CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                                }
                            }
                        }
                        item("bottom") { FabClearance() }
                    }
                }
            }
        }
    }

    snoozing?.let { message ->
        SnoozeSheet(
            onDismiss = { snoozing = null },
            onChoose = { at ->
                snoozing = null
                scope.launch {
                    store.snooze(message, org.weldsuite.core.WeldDate.timestampString(at.toInstant()))
                    notify.show(
                        context.getString(R.string.weldmail_inbox_snoozed, momentText(at.toInstant())),
                        context.getString(R.string.weldmail_common_undo),
                    ) { scope.launch { store.unsnooze(message) } }
                }
            },
        )
    }
}

/** Above the list: the search box and the quick filters, as the platform's list header. */
@Composable
private fun ListControls(filter: InboxFilter, onFilter: (InboxFilter) -> Unit, onSearch: () -> Unit) {
    Column {
        SearchEntry(
            placeholder = stringResource(R.string.weldmail_inbox_search_mail),
            onClick = onSearch,
            modifier = Modifier.padding(horizontal = Tokens.Spacing.l, vertical = Tokens.Spacing.s).tagged("search-mail"),
        )
        LazyRow(
            horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
            contentPadding = PaddingValues(horizontal = Tokens.Spacing.l),
            modifier = Modifier.padding(bottom = Tokens.Spacing.s),
        ) {
            items(InboxFilter.entries) { option ->
                FilterPill(
                    text = stringResource(
                        when (option) {
                            InboxFilter.ALL -> R.string.weldmail_inbox_filter_all
                            InboxFilter.UNREAD -> R.string.weldmail_inbox_filter_unread
                            InboxFilter.STARRED -> R.string.weldmail_inbox_filter_starred
                            InboxFilter.ATTACHMENTS -> R.string.weldmail_inbox_filter_attachments
                        },
                    ),
                    selected = filter == option,
                    onClick = { onFilter(option) },
                    modifier = Modifier.tagged("filter-${option.name.lowercase()}"),
                )
            }
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
    }
}

/** An action behind a row, revealed by a swipe. */
private data class SwipeAction(val label: String, val icon: ImageVector, val color: Color, val onClick: () -> Unit)

/**
 * A row whose actions sit behind it: a swipe to the right shows Read and
 * Pin, to the left Snooze, Archive and Delete, as in the Expo app. TalkBack
 * offers the same actions on the row.
 */
@Composable
private fun SwipeRow(leading: List<SwipeAction>, trailing: List<SwipeAction>, content: @Composable () -> Unit) {
    val width = 76.dp
    val density = LocalDensity.current
    val start = with(density) { (width * leading.size).toPx() }
    val end = with(density) { (width * trailing.size).toPx() }
    val offset = remember { Animatable(0f) }
    val scope = rememberCoroutineScope()
    fun close() = scope.launch { offset.animateTo(0f) }
    Box(
        Modifier
            .fillMaxWidth()
            .semantics {
                customActions = (leading + trailing).map { action ->
                    CustomAccessibilityAction(action.label) {
                        action.onClick()
                        true
                    }
                }
            },
    ) {
        Row(Modifier.matchParentSize()) {
            leading.forEach { action -> SwipeButton(action, width) { close(); action.onClick() } }
            Spacer(Modifier.weight(1f))
            trailing.forEach { action -> SwipeButton(action, width) { close(); action.onClick() } }
        }
        Box(
            Modifier
                .offset { IntOffset(offset.value.roundToInt(), 0) }
                .draggable(
                    orientation = Orientation.Horizontal,
                    state = rememberDraggableState { delta ->
                        scope.launch { offset.snapTo((offset.value + delta).coerceIn(-end, start)) }
                    },
                    onDragStopped = {
                        val target = when {
                            offset.value > start / 2 -> start
                            offset.value < -end / 2 -> -end
                            else -> 0f
                        }
                        offset.animateTo(target)
                    },
                )
                .background(MaterialTheme.colorScheme.background),
        ) { content() }
    }
}

@Composable
private fun SwipeButton(action: SwipeAction, width: Dp, onClick: () -> Unit) {
    Column(
        Modifier
            .width(width)
            .fillMaxHeight()
            .background(action.color)
            .clickable(onClick = onClick),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        // Light marks on the action's saturated colour, in both appearances.
        Icon(action.icon, contentDescription = null, tint = Color.White, modifier = Modifier.size(20.dp))
        Text(action.label, color = Color.White, style = MaterialTheme.typography.labelSmall, maxLines = 1)
    }
}

@Composable
private fun SwipeableMessageRow(
    message: MailMessage,
    pinned: Boolean,
    outgoing: Boolean,
    labelColors: Map<String, String?>,
    onOpen: () -> Unit,
    onToggleRead: () -> Unit,
    onPin: () -> Unit,
    onSnooze: () -> Unit,
    onArchive: () -> Unit,
    onDelete: () -> Unit,
) {
    val leading = listOf(
        SwipeAction(
            stringResource(if (message.isRead) R.string.weldmail_swipe_unread else R.string.weldmail_swipe_read),
            Icons.Outlined.Drafts,
            MailColors.neutral,
            onToggleRead,
        ),
        SwipeAction(stringResource(if (pinned) R.string.weldmail_swipe_unpin else R.string.weldmail_swipe_pin), Icons.Outlined.PushPin, MailColors.pin, onPin),
    )
    val trailing = listOf(
        SwipeAction(stringResource(R.string.weldmail_swipe_snooze), Icons.Outlined.AccessTime, MailColors.snooze, onSnooze),
        SwipeAction(stringResource(R.string.weldmail_swipe_archive), Icons.Outlined.Archive, MailColors.neutral, onArchive),
        SwipeAction(stringResource(R.string.weldmail_swipe_delete), Icons.Outlined.Delete, Tokens.Status.danger.current(), onDelete),
    )
    SwipeRow(leading, trailing) {
        MessageRow(
            message = message,
            pinned = pinned,
            outgoing = outgoing,
            labelColors = labelColors,
            modifier = Modifier.clickable(onClick = onOpen).tagged("inbox-email-row"),
        )
    }
    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
}

/**
 * The mailbox menu, as the platform's mail sidebar in a drawer: the
 * mailboxes to switch between (all of them, each account, those in other
 * workspaces), then the "Mailboxes" group (the folders, more behind More) and
 * the "Labels" group with each label's colour and count.
 */
@Composable
private fun MailboxDrawer(
    store: MailStore,
    session: SessionState.Ready,
    onLabel: (String) -> Unit,
    onMailbox: (Mailbox) -> Unit,
    onOtherWorkspace: (MailAccount) -> Unit,
    onSubscriptions: () -> Unit,
    onAddAccount: () -> Unit,
    aiAvailable: Boolean,
) {
    val accounts by store.accounts.collectAsStateWithLifecycle()
    val mailbox by store.mailbox.collectAsStateWithLifecycle()
    val label by store.label.collectAsStateWithLifecycle()
    val labels by store.labels.collectAsStateWithLifecycle()
    var more by rememberSaveable { mutableStateOf(false) }
    var creating by remember { mutableStateOf(false) }
    val own = accounts.filter { it.inActiveWorkspace }
    val others = accounts.filterNot { it.inActiveWorkspace }.groupBy { it.workspaceName.orEmpty() }
    val selected = (mailbox as? Mailbox.Account)?.let { m -> own.firstOrNull { it.id == m.id } }

    ModalDrawerSheet(
        drawerContainerColor = Tokens.Palette.chrome.current(),
        modifier = Modifier.tagged("mailbox-drawer"),
    ) {
        LazyColumn(contentPadding = PaddingValues(horizontal = Tokens.Spacing.s, vertical = Tokens.Spacing.s)) {
            item {
                // The scope on screen, as the platform's account switcher shows it.
                Row(
                    Modifier.padding(horizontal = Tokens.Spacing.s, vertical = Tokens.Spacing.m),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    if (selected != null) {
                        MailAvatar(selected.displayName, size = 32.dp)
                    } else {
                        Box(
                            Modifier.size(32.dp).background(MaterialTheme.colorScheme.surfaceVariant, CircleShape),
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(Icons.Outlined.Inbox, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(16.dp))
                        }
                    }
                    Column(Modifier.padding(start = Tokens.Spacing.m)) {
                        Text(
                            selected?.displayName ?: stringResource(R.string.weldmail_drawer_all_inboxes),
                            style = MaterialTheme.typography.bodyMedium,
                            fontWeight = FontWeight.SemiBold,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(
                            selected?.email ?: pluralStringResource(R.plurals.weldmail_drawer_accounts, own.size, own.size),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(session.workspace.name, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                    }
                }
                DrawerRow(
                    label = stringResource(R.string.weldmail_drawer_all_inboxes),
                    selected = mailbox is Mailbox.Unified,
                    onClick = { onMailbox(Mailbox.Unified) },
                    leading = { DrawerIcon(Icons.Outlined.Inbox) },
                    modifier = Modifier.tagged("mailbox-unified"),
                )
                own.forEach { account ->
                    DrawerRow(
                        label = account.displayName,
                        supporting = account.email.takeIf { it != account.displayName },
                        selected = selected?.id == account.id,
                        onClick = { onMailbox(Mailbox.Account(account.id)) },
                        leading = { MailAvatar(account.displayName, size = 20.dp) },
                        modifier = Modifier.tagged("mailbox-${account.email}"),
                    )
                }
                others.forEach { (workspace, list) ->
                    GroupLabel(stringResource(R.string.weldmail_drawer_in_workspace, workspace))
                    list.forEach { account ->
                        DrawerRow(
                            label = account.displayName,
                            supporting = account.email.takeIf { it != account.displayName },
                            selected = false,
                            onClick = { onOtherWorkspace(account) },
                            leading = { MailAvatar(account.displayName, size = 20.dp) },
                        )
                    }
                }
                DrawerRow(
                    label = stringResource(R.string.weldmail_drawer_add_account),
                    selected = false,
                    onClick = onAddAccount,
                    leading = { DrawerIcon(Icons.Outlined.Add) },
                    muted = true,
                    modifier = Modifier.tagged("add-account"),
                )
                HorizontalDivider(Modifier.padding(vertical = Tokens.Spacing.s), color = MaterialTheme.colorScheme.outlineVariant)
                GroupLabel(stringResource(R.string.weldmail_drawer_title))
            }
            items(SystemLabel.MAIN) { system ->
                FolderItem(system, labels.systemCounts[system.slug], label == system.slug) { onLabel(system.slug) }
            }
            if (more) {
                items(SystemLabel.SECONDARY) { system ->
                    FolderItem(system, labels.systemCounts[system.slug], label == system.slug) { onLabel(system.slug) }
                }
                item {
                    DrawerRow(
                        label = stringResource(R.string.weldmail_drawer_subscriptions),
                        selected = false,
                        onClick = onSubscriptions,
                        leading = { DrawerIcon(Icons.Outlined.Unsubscribe) },
                        modifier = Modifier.tagged("open-subscriptions"),
                    )
                }
            }
            item {
                DrawerRow(
                    label = stringResource(if (more) R.string.weldmail_drawer_less else R.string.weldmail_drawer_more),
                    selected = false,
                    onClick = { more = !more },
                    leading = { DrawerIcon(if (more) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore) },
                    muted = true,
                    modifier = Modifier.tagged("drawer-more"),
                )
                GroupLabel(stringResource(R.string.weldmail_drawer_labels), Modifier.padding(top = Tokens.Spacing.m))
                if (labels.custom.isEmpty()) {
                    Text(
                        stringResource(R.string.weldmail_drawer_no_labels),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(horizontal = Tokens.Spacing.s, vertical = Tokens.Spacing.xs),
                    )
                }
            }
            items(labels.custom, key = { "label-${it.id}" }) { custom ->
                DrawerRow(
                    label = custom.name,
                    selected = label == custom.slug,
                    onClick = { onLabel(custom.slug) },
                    leading = { Box(Modifier.size(10.dp).background(labelTint(custom.name, custom.color), CircleShape)) },
                    count = custom.count,
                )
            }
            if (selected != null) {
                item { AddLabelButton { creating = true } }
            }
        }
    }
    if (creating && selected != null) {
        CreateLabelDialog(aiAvailable = aiAvailable, onDismiss = { creating = false }) { name, color ->
            store.createLabel(selected.id, name, color)
        }
    }
}

/** A group's name in the drawer: small, medium, muted, as the platform sidebar's group labels. */
@Composable
private fun GroupLabel(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = modifier.padding(start = Tokens.Spacing.s, top = Tokens.Spacing.s, bottom = Tokens.Spacing.xs),
    )
}

@Composable
private fun DrawerIcon(icon: ImageVector) {
    Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(18.dp))
}

/** A row of the drawer, as a platform sidebar item: `rounded-md`, the accent fill when it is the one on screen, a count at the end. */
@Composable
private fun DrawerRow(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    leading: @Composable () -> Unit,
    modifier: Modifier = Modifier,
    supporting: String? = null,
    count: Int? = null,
    muted: Boolean = false,
) {
    Row(
        modifier
            .fillMaxWidth()
            .height(if (supporting != null) 48.dp else 40.dp)
            .clip(MaterialTheme.shapes.small)
            .background(if (selected) MaterialTheme.colorScheme.secondaryContainer else Color.Transparent)
            .clickable(onClick = onClick)
            .semantics { this.selected = selected }
            .padding(horizontal = Tokens.Spacing.s),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(20.dp), contentAlignment = Alignment.Center) { leading() }
        Column(Modifier.weight(1f).padding(horizontal = Tokens.Spacing.m)) {
            Text(
                label,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = if (selected) FontWeight.Medium else FontWeight.Normal,
                color = if (muted) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (supporting != null) {
                Text(supporting, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        if (count != null && count > 0) {
            Text(count.toString(), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/** "Add label": the platform's dashed button under the labels. */
@Composable
private fun AddLabelButton(onClick: () -> Unit) {
    val dash = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.3f)
    val density = LocalDensity.current
    val radius = with(density) { Tokens.Radius.medium.toPx() }
    Row(
        Modifier
            .padding(horizontal = Tokens.Spacing.s, vertical = Tokens.Spacing.s)
            .fillMaxWidth()
            .height(36.dp)
            .clip(MaterialTheme.shapes.small)
            .drawBehind {
                drawRoundRect(
                    color = dash,
                    cornerRadius = CornerRadius(radius),
                    style = Stroke(width = 1.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(4.dp.toPx(), 3.dp.toPx()))),
                )
            }
            .clickable(onClick = onClick)
            .tagged("create-label"),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Outlined.Add, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(14.dp))
        Text(
            stringResource(R.string.weldmail_drawer_add_label),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(start = 6.dp),
        )
    }
}

@Composable
private fun FolderItem(system: SystemLabel, count: Int?, selected: Boolean, onClick: () -> Unit) {
    DrawerRow(
        label = stringResource(systemLabelName(system)),
        selected = selected,
        onClick = onClick,
        leading = { DrawerIcon(systemLabelIcon(system)) },
        count = count,
        modifier = Modifier.tagged("folder-${system.slug.lowercase()}"),
    )
}
