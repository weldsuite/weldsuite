package org.weldsuite.core.lock

import android.app.KeyguardManager
import android.content.Context
import android.os.Build
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

/**
 * The app lock: the phone's biometrics or its passcode.
 *
 * In `required` mode (WeldPass) the app starts locked and locks again after
 * [graceMs] in the background. [confirm] asks before a secret is shown or
 * copied; one confirmation covers the next [confirmWindowMs].
 */
class AppLock(
    context: Context,
    private val required: Boolean,
    private val graceMs: Long = 60_000,
    private val confirmWindowMs: Long = 10_000,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val appContext = context.applicationContext
    private val lockedState = MutableStateFlow(required)
    private var backgroundedAt: Long? = null
    private var confirmedAt = 0L

    /** Whether the app's content is hidden behind the lock screen. */
    val locked: StateFlow<Boolean> = lockedState.asStateFlow()

    /** Whether the phone has a screen lock at all. Without one, WeldPass can't be used. */
    fun hasScreenLock(): Boolean {
        val keyguard = appContext.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
        return keyguard.isDeviceSecure ||
            BiometricManager.from(appContext).canAuthenticate(authenticators()) == BiometricManager.BIOMETRIC_SUCCESS
    }

    suspend fun unlock(activity: FragmentActivity, title: String): Boolean {
        if (!lockedState.value) return true
        val ok = authenticate(activity, title)
        if (ok) {
            lockedState.value = false
            confirmedAt = now()
        }
        return ok
    }

    /** Ask before a secret is shown or copied, unless the last confirmation was moments ago. */
    suspend fun confirm(activity: FragmentActivity, title: String): Boolean {
        if (now() - confirmedAt < confirmWindowMs) return true
        val ok = authenticate(activity, title)
        if (ok) confirmedAt = now()
        return ok
    }

    fun onBackground() {
        backgroundedAt = now()
    }

    fun onForeground() {
        val since = backgroundedAt ?: return
        backgroundedAt = null
        if (required && now() - since >= graceMs) lockedState.value = true
    }

    fun lockNow() {
        if (required) lockedState.value = true
        confirmedAt = 0
    }

    private suspend fun authenticate(activity: FragmentActivity, title: String): Boolean =
        suspendCancellableCoroutine { continuation ->
            val prompt = BiometricPrompt(
                activity,
                ContextCompat.getMainExecutor(activity),
                object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                        if (continuation.isActive) continuation.resume(true)
                    }

                    override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                        if (continuation.isActive) continuation.resume(false)
                    }
                },
            )
            val info = BiometricPrompt.PromptInfo.Builder()
                .setTitle(title)
                .setAllowedAuthenticators(authenticators())
                .build()
            prompt.authenticate(info)
            continuation.invokeOnCancellation { prompt.cancelAuthentication() }
        }

    /** Biometrics or the screen lock. Before Android 11 only weak biometrics combine with the passcode. */
    private fun authenticators(): Int =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            BIOMETRIC_STRONG or DEVICE_CREDENTIAL
        } else {
            BIOMETRIC_WEAK or DEVICE_CREDENTIAL
        }
}
