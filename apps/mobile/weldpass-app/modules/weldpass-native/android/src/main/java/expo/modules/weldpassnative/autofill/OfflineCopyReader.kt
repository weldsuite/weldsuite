package expo.modules.weldpassnative.autofill

import android.content.Context
import java.io.File
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import org.json.JSONArray
import org.json.JSONObject

/**
 * The app's offline copy (ADR PASS-010), read by the autofill service.
 * Layout, as `lib/offline/envelope.ts` writes it: `WPO1` ‖ nonce (12) ‖
 * ciphertext ‖ tag (16), AES-256-GCM, additional data
 * `weldpass-offline:v1:<deviceId>:<workspaceId>`. The files and `index.json`
 * are in `<filesDir>/weldpass-offline` (expo-file-system's `Paths.document`).
 */
object OfflineCopyReader {
  data class Login(
    val workspaceId: String,
    val vaultId: String,
    val itemId: String,
    val title: String,
    val host: String?,
    val username: String,
    val password: String,
    val apps: List<String>,
  )

  private val MAGIC = byteArrayOf(0x57, 0x50, 0x4F, 0x31)

  private fun folder(context: Context) = File(context.filesDir, "weldpass-offline")

  /** Every login in every copy the app keeps, opened with `key`. */
  fun logins(context: Context, key: ByteArray): List<Login> {
    val index = File(folder(context), "index.json").takeIf { it.exists() } ?: return emptyList()
    val entries = runCatching { JSONArray(index.readText()) }.getOrNull() ?: return emptyList()
    val logins = mutableListOf<Login>()
    for (i in 0 until entries.length()) {
      val entry = entries.optJSONObject(i) ?: continue
      val workspaceId = entry.optString("workspaceId")
      val deviceId = entry.optString("deviceId")
      val file = File(folder(context), entry.optString("file"))
      if (!file.exists()) continue
      val copy = runCatching { open(file.readBytes(), key, deviceId, workspaceId) }.getOrNull() ?: continue
      logins += loginsOf(copy, workspaceId)
    }
    return logins.sortedBy { it.title.lowercase() }
  }

  private fun open(file: ByteArray, key: ByteArray, deviceId: String, workspaceId: String): JSONObject {
    require(file.size > MAGIC.size + 28 && file.copyOfRange(0, MAGIC.size).contentEquals(MAGIC))
    val sealed = file.copyOfRange(MAGIC.size, file.size)
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, sealed, 0, 12))
    cipher.updateAAD("weldpass-offline:v1:$deviceId:$workspaceId".toByteArray(Charsets.UTF_8))
    val plaintext = cipher.doFinal(sealed, 12, sealed.size - 12)
    return JSONObject(String(plaintext, Charsets.UTF_8))
  }

  private fun loginsOf(copy: JSONObject, workspaceId: String): List<Login> {
    val out = mutableListOf<Login>()
    val vaults = copy.optJSONObject("vaults") ?: return out
    for (vaultId in vaults.keys()) {
      val items = vaults.optJSONObject(vaultId)?.optJSONObject("items") ?: continue
      for (itemId in items.keys()) {
        val item = items.optJSONObject(itemId) ?: continue
        if (item.optString("type") != "login") continue
        val fields = item.optJSONObject("fields") ?: continue
        val apps = fields.optJSONArray("apps")?.let { array -> (0 until array.length()).map { array.optString(it) } }
        out +=
          Login(
            workspaceId = workspaceId,
            vaultId = vaultId,
            itemId = itemId,
            title = item.optString("title"),
            host = item.optString("host").takeIf { it.isNotEmpty() && it != "null" },
            username = fields.optString("username"),
            password = fields.optString("password"),
            apps = apps.orEmpty(),
          )
      }
    }
    return out
  }

  /**
   * The logins for this screen: an app's own logins by package name (stored
   * in the sealed item, never sent anywhere), a page's by domain, with
   * `hostsMatch`'s rule from `@weldsuite/app-api-client` (phase 1.6 moves it
   * to the public-suffix list; follow it here).
   */
  fun matching(logins: List<Login>, fields: FormFields): List<Login> {
    val domain = fields.webDomain?.removePrefix("www.")
    return logins.filter { login ->
      if (domain != null) login.host?.let { hostsMatch(it, domain) } ?: false
      else fields.packageName in login.apps
    }
  }

  fun hostsMatch(itemHost: String, pageHost: String): Boolean {
    if (itemHost == pageHost) return true
    val (short, long) = if (itemHost.length < pageHost.length) itemHost to pageHost else pageHost to itemHost
    return short.split('.').size >= 2 && long.endsWith(".$short")
  }

  /** A fill, for the vault's trail; the app uploads it at its next sync. */
  fun recordFill(context: Context, login: Login) {
    val file = File(folder(context), "fills.json")
    val fills = runCatching { JSONArray(file.readText()) }.getOrDefault(JSONArray())
    fills.put(
      JSONObject()
        .put("workspaceId", login.workspaceId)
        .put("vaultId", login.vaultId)
        .put("itemId", login.itemId)
        .put("at", java.time.Instant.now().toString()))
    while (fills.length() > 500) fills.remove(0)
    file.writeText(fills.toString())
  }
}
