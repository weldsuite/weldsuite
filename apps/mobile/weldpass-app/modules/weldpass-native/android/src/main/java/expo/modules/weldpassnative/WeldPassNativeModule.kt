package expo.modules.weldpassnative

import android.content.Context
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
  }
}
