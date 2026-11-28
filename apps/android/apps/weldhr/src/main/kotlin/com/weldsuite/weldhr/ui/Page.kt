package com.weldsuite.weldhr.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PersonOff
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.weldsuite.weldhr.R
import com.weldsuite.weldhr.SelfState
import org.weldsuite.core.LoadState
import org.weldsuite.ui.EmptyState
import org.weldsuite.ui.LoadErrorState
import org.weldsuite.ui.Tokens

/**
 * A screen of the app: its bar (a tab's title, or a pushed page's with the
 * way back), what sits under it (views, a period), and a list that pulls to
 * refresh.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun Page(
    title: String,
    refreshing: Boolean,
    onRefresh: () -> Unit,
    onBack: (() -> Unit)? = null,
    actions: @Composable () -> Unit = {},
    header: @Composable ColumnScope.() -> Unit = {},
    content: LazyListScope.() -> Unit,
) {
    Column(Modifier.fillMaxSize()) {
        if (onBack != null) {
            BackBar(title, onBack, actions)
        } else {
            TopAppBar(title = { Text(title) }, actions = { actions() })
        }
        header()
        PullToRefreshBox(isRefreshing = refreshing, onRefresh = onRefresh, modifier = Modifier.fillMaxSize()) {
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 96.dp)) { content() }
        }
    }
}

/** A spinner as a list item. */
fun LazyListScope.loading(key: String = "loading") {
    item(key) {
        Box(Modifier.fillMaxWidth().padding(Tokens.Spacing.xl), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
    }
}

/** A list item that says there is nothing. */
fun LazyListScope.empty(title: String, description: String? = null, key: String = "empty") {
    item(key) { EmptyState(title, description) }
}

/** A list item that says loading failed, with "Try again". */
fun LazyListScope.failed(error: Throwable?, onRetry: () -> Unit, key: String = "failed") {
    item(key) { Box(Modifier.fillMaxWidth().padding(vertical = 48.dp)) { LoadErrorState(error, onRetry) } }
}

/**
 * The first load of [state] as list items: a spinner, the error, or
 * [content] with the data. A failed reload keeps the data on screen.
 */
fun <T> LazyListScope.query(state: LoadState<T>, onRetry: () -> Unit, content: LazyListScope.(T) -> Unit) {
    val data = state.data
    when {
        data != null -> content(data)
        state.error != null -> failed(state.error, onRetry)
        else -> loading()
    }
}

/**
 * My HR's gate: without `employees:self` or a linked employee record there
 * is nothing to show, so say why. True when [content] may follow.
 */
fun LazyListScope.gate(self: SelfState, onRetry: () -> Unit): Boolean {
    when (self) {
        SelfState.Loading -> loading("gate")
        SelfState.NoAccess -> item("gate") { Unlinked(stringResource(R.string.weldhr_not_linked_no_access_title), stringResource(R.string.weldhr_not_linked_no_access_description)) }
        SelfState.NotLinked -> item("gate") { Unlinked(stringResource(R.string.weldhr_not_linked_title), stringResource(R.string.weldhr_not_linked_description)) }
        is SelfState.Failed -> failed(self.error, onRetry, "gate")
        is SelfState.Ready -> return true
    }
    return false
}

@Composable
private fun Unlinked(title: String, description: String) {
    EmptyState(title, description) {
        Icon(Icons.Filled.PersonOff, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
