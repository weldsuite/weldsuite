package expo.modules.weldpassnative

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.view.autofill.AutofillManager
import expo.modules.weldpassnative.autofill.AutofillKey
import expo.modules.weldpassnative.autofill.PendingSave
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** WeldPass's native pieces on Android. See `index.ts` for the JS API. */
class WeldPassNativeModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("WeldPassNative")

    AsyncFunction("setSensitiveString") { text: String, expiresInSeconds: Double ->
      SensitiveClipboard.set(context, text, (expiresInSeconds * 1000).toLong())
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("clearIfUnchanged") { token: String ->
      SensitiveClipboard.clearIfUnchanged(context, token)
    }.runOnQueue(Queues.MAIN)

    // The app's `allowBackup` is off, so nothing of it is backed up already.
    Function("excludeFromBackup") { _: String -> true }

    // Native autofill (phase 4C)

    /** The copy's key for the autofill service, wrapped; works within 30 s of an unlock. */
    Function("storeAutofillKey") { keyBase64: String ->
      AutofillKey.store(context, keyBase64)
    }

    Function("clearAutofillKey") {
      AutofillKey.clear(context)
    }

    /** A login the autofill service was asked to save, once, for the "New login" form. */
    Function("takePendingSave") {
      PendingSave.take()?.let {
        mapOf(
          "username" to it.username,
          "password" to it.password,
          "webDomain" to it.webDomain,
          "packageName" to it.packageName,
        )
      }
    }

    AsyncFunction("autofillEnabled") {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return@AsyncFunction false
      context.getSystemService(AutofillManager::class.java)?.hasEnabledAutofillServices() == true
    }

    /** Android's "Autofill service" picker, with WeldPass offered. */
    Function("openAutofillSettings") {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val intent =
          Intent(Settings.ACTION_REQUEST_SET_AUTOFILL_SERVICE)
            .setData(Uri.parse("package:${context.packageName}"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
      }
    }
  }
}
