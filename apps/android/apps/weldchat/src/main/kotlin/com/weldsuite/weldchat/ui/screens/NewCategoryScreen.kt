package com.weldsuite.weldchat.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import com.weldsuite.weldchat.ChannelNames
import com.weldsuite.weldchat.ChatStore
import com.weldsuite.weldchat.R
import com.weldsuite.weldchat.ui.ChatNavigator
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged
import org.weldsuite.core.R as CoreR

/** A new category (a section of channels on Home): a name, Create, then Home reloads. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NewCategoryScreen(store: ChatStore, nav: ChatNavigator) {
    val scope = rememberCoroutineScope()
    var name by rememberSaveable { mutableStateOf("") }
    var saving by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }
    val focus = remember { FocusRequester() }
    val trimmed = name.trim()

    fun create() {
        if (trimmed.isEmpty() || saving) return
        saving = true
        failed = false
        scope.launch {
            try {
                store.repository.createSection(trimmed)
                store.loadHome()
                nav.finishSheet()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                failed = true
                saving = false
            }
        }
    }

    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    BackHandler(enabled = saving) {}

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.weldchat_new_category_title)) },
                navigationIcon = {
                    IconButton(onClick = { nav.back() }, enabled = !saving, modifier = Modifier.tagged("new-category-cancel")) {
                        Icon(Icons.Filled.Close, contentDescription = stringResource(CoreR.string.core_common_cancel))
                    }
                },
                actions = {
                    if (saving) {
                        CircularProgressIndicator(Modifier.padding(end = Tokens.Spacing.l).size(24.dp), strokeWidth = 2.dp)
                    } else {
                        TextButton(onClick = { create() }, enabled = trimmed.isNotEmpty(), modifier = Modifier.tagged("new-category-create")) {
                            Text(stringResource(R.string.weldchat_new_category_create), fontWeight = FontWeight.SemiBold)
                        }
                    }
                },
            )
        },
    ) { padding ->
        Column(
            Modifier.padding(padding).fillMaxSize().padding(Tokens.Spacing.l),
            verticalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
        ) {
            Text(stringResource(R.string.weldchat_new_category_name_label), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
            OutlinedTextField(
                value = name,
                onValueChange = {
                    name = it.take(ChannelNames.MAX_LENGTH)
                    failed = false
                },
                placeholder = { Text(stringResource(R.string.weldchat_new_category_name_placeholder)) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { create() }),
                modifier = Modifier.fillMaxWidth().focusRequester(focus).tagged("new-category-name"),
            )
            if (failed) {
                InlineError(stringResource(R.string.weldchat_new_category_failed))
            } else {
                Text(stringResource(R.string.weldchat_new_category_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}
