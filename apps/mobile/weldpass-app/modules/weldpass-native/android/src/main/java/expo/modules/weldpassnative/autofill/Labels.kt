package expo.modules.weldpassnative.autofill

import android.content.Context

/** The autofill service's few strings, in the app's languages (English, Dutch). */
internal object Labels {
  private fun dutch(context: Context): Boolean {
    val locales = context.resources.configuration.locales
    return locales.size() > 0 && locales[0].language == "nl"
  }

  fun fillWithWeldPass(context: Context) = if (dutch(context)) "Invullen met WeldPass" else "Fill with WeldPass"

  fun unlockTitle(context: Context) = if (dutch(context)) "WeldPass ontgrendelen" else "Unlock WeldPass"

  fun cancel(context: Context) = if (dutch(context)) "Annuleren" else "Cancel"
}
