package com.weldsuite.weldchat

import android.content.Context
import androidx.annotation.PluralsRes
import androidx.annotation.StringRes
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext

/**
 * Text the pure rules (ChatLogic.kt, ChannelRules.kt) decide on without a
 * `Context`: a string resource with its arguments, a plural, or text as is.
 * The screens turn it into a string; the unit tests compare it as data.
 * An argument may itself be a [UiText].
 */
sealed interface UiText {
    data class Res(@param:StringRes val id: Int, val args: List<Any> = emptyList()) : UiText

    data class Plural(@param:PluralsRes val id: Int, val count: Int, val args: List<Any> = listOf(count)) : UiText

    data class Raw(val text: String) : UiText

    fun resolve(context: Context): String = when (this) {
        is Raw -> text
        is Res -> if (args.isEmpty()) context.getString(id) else context.getString(id, *resolveArgs(context, args))
        is Plural -> context.resources.getQuantityString(id, count, *resolveArgs(context, args))
    }

    companion object {
        fun res(@StringRes id: Int, vararg args: Any): UiText = Res(id, args.toList())

        private fun resolveArgs(context: Context, args: List<Any>): Array<Any> =
            args.map { if (it is UiText) it.resolve(context) else it }.toTypedArray()
    }
}

/** The text, in the screen's language. */
@Composable
fun UiText.text(): String = resolve(LocalContext.current)
