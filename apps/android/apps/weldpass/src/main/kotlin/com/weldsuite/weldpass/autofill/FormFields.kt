package com.weldsuite.weldpass.autofill

import android.app.assist.AssistStructure
import android.os.Build
import androidx.annotation.RequiresApi
import android.text.InputType
import android.view.View
import android.view.autofill.AutofillId

/**
 * The login fields of a screen the system asks to fill, and whose screen it
 * is: a native app (its package name) or a web page in a browser (the domain
 * reported for the page the fields sit in).
 *
 * [webDomain] is what the screen *says*: any app can set it on its own views.
 * It is believed only through [AutofillLogins.trustedDomain].
 */
@RequiresApi(Build.VERSION_CODES.O)
data class FormFields(
    val username: AutofillId?,
    val password: AutofillId?,
    /** The reported domain of the page the password field (else the username field) is in. */
    val webDomain: String?,
    /** That page's scheme, where Android reports one (Android 9 and later). */
    val webScheme: String?,
    val packageName: String,
) {
    val isEmpty: Boolean get() = username == null && password == null

    /** What a save request reports back: the ids to read the typed values from. */
    val ids: Array<AutofillId> get() = listOfNotNull(username, password).toTypedArray()

    companion object {
        fun from(structure: AssistStructure): FormFields {
            var username: Found? = null
            var password: Found? = null

            // A node's page is the nearest one reported on it or above it, so a
            // field in a frame of another site carries that site, not the top page's.
            fun visit(node: AssistStructure.ViewNode, page: Page?) {
                val here = node.webDomain?.takeIf { it.isNotBlank() }?.let { Page(it.lowercase(), schemeOf(node)) } ?: page
                val id = node.autofillId
                if (id != null && node.autofillType == View.AUTOFILL_TYPE_TEXT) {
                    when (kindOf(node)) {
                        Kind.PASSWORD -> if (password == null) password = Found(id, here)
                        Kind.USERNAME -> if (username == null) username = Found(id, here)
                        Kind.OTHER -> Unit
                    }
                }
                for (index in 0 until node.childCount) visit(node.getChildAt(index), here)
            }

            for (index in 0 until structure.windowNodeCount) visit(structure.getWindowNodeAt(index).rootViewNode, null)
            // The page is the password field's (else the username's); a username
            // field in another page is left alone.
            val page = (password ?: username)?.page
            val user = username?.takeIf { it.page == page }
            return FormFields(user?.id, password?.id, page?.domain, page?.scheme, structure.activityComponent.packageName)
        }

        private data class Page(val domain: String, val scheme: String?)

        private class Found(val id: AutofillId, val page: Page?)

        private fun schemeOf(node: AssistStructure.ViewNode): String? =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) node.webScheme?.lowercase() else null

        private enum class Kind { USERNAME, PASSWORD, OTHER }

        private fun kindOf(node: AssistStructure.ViewNode): Kind {
            val hints = node.autofillHints?.map { it.lowercase() }.orEmpty()
            if (hints.any { it.contains("password") }) return Kind.PASSWORD
            if (hints.any { it.contains("username") || it.contains("email") }) return Kind.USERNAME

            val html = node.htmlInfo
            if (html != null && html.tag.equals("input", ignoreCase = true)) {
                val attributes = html.attributes.orEmpty().associate { it.first.lowercase() to it.second.lowercase() }
                val type = attributes["type"]
                val autocomplete = attributes["autocomplete"].orEmpty()
                if (type == "password" || autocomplete.contains("password")) return Kind.PASSWORD
                if (type == "email" || autocomplete.contains("username") || autocomplete.contains("email")) return Kind.USERNAME
            }

            val variation = node.inputType and InputType.TYPE_MASK_VARIATION
            val isText = node.inputType and InputType.TYPE_MASK_CLASS == InputType.TYPE_CLASS_TEXT
            if (isText && variation in PASSWORD_VARIATIONS) return Kind.PASSWORD
            if (isText && variation in EMAIL_VARIATIONS) return Kind.USERNAME

            val words = listOfNotNull(node.idEntry, node.hint, node.text?.toString()).joinToString(" ").lowercase()
            if (words.contains("password") || words.contains("wachtwoord")) return Kind.PASSWORD
            if (USERNAME_WORDS.any { words.contains(it) }) return Kind.USERNAME
            return Kind.OTHER
        }

        private val PASSWORD_VARIATIONS = setOf(
            InputType.TYPE_TEXT_VARIATION_PASSWORD,
            InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD,
            InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD,
        )
        private val EMAIL_VARIATIONS = setOf(
            InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS,
            InputType.TYPE_TEXT_VARIATION_WEB_EMAIL_ADDRESS,
        )
        private val USERNAME_WORDS = listOf("user", "email", "e-mail", "login", "gebruiker")
    }
}
