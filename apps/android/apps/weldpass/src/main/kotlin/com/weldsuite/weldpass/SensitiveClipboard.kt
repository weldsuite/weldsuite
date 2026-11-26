package com.weldsuite.weldpass

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PersistableBundle
import java.util.UUID

/**
 * The clipboard for WeldPass. A copied secret is marked sensitive (Android
 * 13+ hides it from the copy preview and keyboard suggestions) and cleared
 * after [SECRET_TTL_MS] by a timer on the main looper, which also fires with
 * the app in the background. A username or a website is copied plainly.
 */
object SensitiveClipboard {
    const val SECRET_TTL_MS = 30_000L

    // ClipDescription.EXTRA_IS_SENSITIVE (API 33); older releases that honour it use the same key.
    private const val EXTRA_IS_SENSITIVE = "android.content.extra.IS_SENSITIVE"
    private const val EXTRA_TOKEN = "com.weldsuite.weldpass.CLIP_TOKEN"

    private val handler = Handler(Looper.getMainLooper())

    @Volatile
    private var lastToken: String? = null

    fun copySecret(context: Context, text: String) {
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
        handler.postDelayed({ clearIfUnchanged(appContext, token) }, SECRET_TTL_MS)
    }

    fun copyPlain(context: Context, text: String) {
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("WeldPass", text))
        lastToken = null
    }

    /**
     * Clears only our own copy. In the background, Android 10+ hides the clip
     * from us (a null description); then the newest copy we made is taken to
     * still be there.
     */
    private fun clearIfUnchanged(context: Context, token: String) {
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val description = clipboard.primaryClipDescription
        val ours = if (description == null) lastToken == token else description.extras?.getString(EXTRA_TOKEN) == token
        if (!ours) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            clipboard.clearPrimaryClip()
        } else {
            clipboard.setPrimaryClip(ClipData.newPlainText("", ""))
        }
        if (lastToken == token) lastToken = null
    }
}
