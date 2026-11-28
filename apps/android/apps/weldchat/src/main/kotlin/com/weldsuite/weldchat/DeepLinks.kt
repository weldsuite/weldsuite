package com.weldsuite.weldchat

import android.content.Intent
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * A `weldchat://…` link the activity was opened with, waiting for the app
 * (`DeepLink.parse` reads it). AppAuth's own `weldchat://sso-callback` never
 * gets here.
 */
object DeepLinks {
    private val links = MutableStateFlow<String?>(null)
    val pending: StateFlow<String?> = links.asStateFlow()

    fun offer(intent: Intent?) {
        val data = intent?.data ?: return
        if (intent.action != Intent.ACTION_VIEW || data.scheme != "weldchat" || data.host == "sso-callback") return
        links.value = data.toString()
    }

    /** The waiting link, once. */
    fun take(): String? = links.value.also { links.value = null }
}
