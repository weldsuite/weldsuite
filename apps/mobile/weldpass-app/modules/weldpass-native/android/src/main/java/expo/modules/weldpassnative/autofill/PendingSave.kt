package expo.modules.weldpassnative.autofill

import android.app.assist.AssistStructure
import android.view.autofill.AutofillId

/**
 * A login typed into another app or page that the person asked WeldPass to
 * save. Held in memory only, for a minute, until the app's "New login" form
 * takes it (`takePendingSave`); never in a file, a URL or a log.
 */
object PendingSave {
  data class Values(val username: String, val password: String, val webDomain: String?, val packageName: String)

  private const val TTL_MS = 60_000L

  @Volatile private var values: Values? = null
  @Volatile private var capturedAt = 0L

  fun capture(structure: AssistStructure, fields: FormFields) {
    var username = ""
    var password = ""

    fun visit(node: AssistStructure.ViewNode) {
      val id: AutofillId? = node.autofillId
      val text = node.autofillValue?.takeIf { it.isText }?.textValue?.toString()
      if (id != null && text != null) {
        if (id == fields.username) username = text
        if (id == fields.password) password = text
      }
      for (i in 0 until node.childCount) visit(node.getChildAt(i))
    }

    for (i in 0 until structure.windowNodeCount) visit(structure.getWindowNodeAt(i).rootViewNode)
    if (password.isEmpty()) return
    values = Values(username, password, fields.webDomain, fields.packageName)
    capturedAt = System.currentTimeMillis()
  }

  /** The pending save, once: taking it clears it. */
  fun take(): Values? {
    val taken = values?.takeIf { System.currentTimeMillis() - capturedAt <= TTL_MS }
    clear()
    return taken
  }

  fun clear() {
    values = null
    capturedAt = 0L
  }
}
