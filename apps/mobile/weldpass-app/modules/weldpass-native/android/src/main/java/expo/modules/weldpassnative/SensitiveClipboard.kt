package expo.modules.weldpassnative

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PersistableBundle
import java.util.UUID

/**
 * A copied secret: marked sensitive (the system's copy preview and keyboard
 * suggestions hide it on Android 13+) and cleared after its expiry, by a
 * timer on the main looper that runs while the process lives, so it fires
 * with the app in the background too (JS timers don't).
 */
internal object SensitiveClipboard {
  // ClipDescription.EXTRA_IS_SENSITIVE (API 33); the same key works on the
  // older releases that honour it.
  private const val EXTRA_IS_SENSITIVE = "android.content.extra.IS_SENSITIVE"
  private const val EXTRA_TOKEN = "com.weldsuite.weldpass.CLIP_TOKEN"

  private val handler = Handler(Looper.getMainLooper())

  @Volatile private var lastToken: String? = null

  fun set(context: Context, text: String, clearAfterMs: Long): String {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    val token = UUID.randomUUID().toString()
    val clip = ClipData.newPlainText("WeldPass", text)
    clip.description.extras = PersistableBundle().apply {
      putBoolean(EXTRA_IS_SENSITIVE, true)
      putString(EXTRA_TOKEN, token)
    }
    clipboard.setPrimaryClip(clip)
    lastToken = token
    val appContext = context.applicationContext
    handler.postDelayed({ clearIfUnchanged(appContext, token) }, clearAfterMs.coerceAtLeast(1_000))
    return token
  }

  /**
   * Clears only our own copy. In the background, Android 10+ hides the clip
   * from us (a null description); then the newest copy we made is taken to
   * still be there, since nothing says otherwise.
   */
  fun clearIfUnchanged(context: Context, token: String): Boolean {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    val description = clipboard.primaryClipDescription
    val ours =
      if (description == null) {
        lastToken == token
      } else {
        description.extras?.getString(EXTRA_TOKEN) == token
      }
    if (!ours) return false
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      clipboard.clearPrimaryClip()
    } else {
      clipboard.setPrimaryClip(ClipData.newPlainText("", ""))
    }
    if (lastToken == token) lastToken = null
    return true
  }
}
