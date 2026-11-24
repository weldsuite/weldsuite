package expo.modules.weldpassnative.autofill

import android.app.assist.AssistStructure
import android.text.InputType
import android.view.View
import android.view.autofill.AutofillId

/**
 * The login fields of a screen the system asks to fill, and whose screen it
 * is: a native app (its package name) or a web page in a browser (the
 * domain the browser reports for the node).
 */
data class FormFields(
  val username: AutofillId?,
  val password: AutofillId?,
  /** The page's domain, when the fields are in a browser's web view. */
  val webDomain: String?,
  val packageName: String,
) {
  val isEmpty: Boolean get() = username == null && password == null

  /** What a save request reports back: the ids to read the typed values from. */
  val ids: Array<AutofillId> get() = listOfNotNull(username, password).toTypedArray()

  companion object {
    fun from(structure: AssistStructure): FormFields {
      var username: AutofillId? = null
      var password: AutofillId? = null
      var webDomain: String? = null

      fun visit(node: AssistStructure.ViewNode) {
        node.webDomain?.takeIf { it.isNotBlank() }?.let { if (webDomain == null) webDomain = it.lowercase() }
        val id = node.autofillId
        if (id != null && node.autofillType == View.AUTOFILL_TYPE_TEXT) {
          when (kindOf(node)) {
            Kind.PASSWORD -> if (password == null) password = id
            Kind.USERNAME -> if (username == null) username = id
            Kind.OTHER -> {}
          }
        }
        for (i in 0 until node.childCount) visit(node.getChildAt(i))
      }

      for (i in 0 until structure.windowNodeCount) visit(structure.getWindowNodeAt(i).rootViewNode)
      return FormFields(username, password, webDomain, structure.activityComponent.packageName)
    }

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
      if (isText &&
        (variation == InputType.TYPE_TEXT_VARIATION_PASSWORD ||
          variation == InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD ||
          variation == InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD)) {
        return Kind.PASSWORD
      }
      if (isText &&
        (variation == InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS ||
          variation == InputType.TYPE_TEXT_VARIATION_WEB_EMAIL_ADDRESS)) {
        return Kind.USERNAME
      }

      val words = listOfNotNull(node.idEntry, node.hint, node.text?.toString()).joinToString(" ").lowercase()
      if (words.contains("password") || words.contains("wachtwoord")) return Kind.PASSWORD
      if (listOf("user", "email", "e-mail", "login", "gebruiker").any { words.contains(it) }) return Kind.USERNAME
      return Kind.OTHER
    }
  }
}
