package com.weldsuite.weldhr

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.os.CancellationSignal
import androidx.core.content.ContextCompat
import androidx.core.location.LocationManagerCompat
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.resume
import kotlin.math.roundToLong

/**
 * Where the phone is, for clocking in or out where the workspace requires
 * being at a work location: one fix at the moment of the tap, never tracking.
 * The platform's `LocationManager`, not Google Play services.
 */
object ClockLocator {
    /** How long to wait for a fresh fix before settling for the last known one. */
    const val FIX_TIMEOUT_MS = 10_000L

    /** A last known fix older than this is no use for "are you at work right now". */
    const val LAST_KNOWN_MAX_AGE_MS = 2 * 60_000L

    sealed interface Result {
        data class Found(val fix: GeoFix) : Result
        /** Permission refused: the person has to allow it in Settings. */
        data object Denied : Result
        /** Permission is fine but there is no position (location off, no signal). */
        data object Unavailable : Result
    }

    val PERMISSIONS = arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)

    fun hasPermission(context: Context): Boolean = PERMISSIONS.any {
        ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED
    }

    /** A fix for the clock call; ask for the permission first ([hasPermission]). */
    @SuppressLint("MissingPermission") // checked by hasPermission just before
    suspend fun locate(context: Context, now: Long = System.currentTimeMillis()): Result {
        if (!hasPermission(context)) return Result.Denied
        val manager = context.getSystemService(LocationManager::class.java) ?: return Result.Unavailable
        val providers = listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
            .filter { runCatching { manager.isProviderEnabled(it) }.getOrDefault(false) }
        val fresh = providers.firstOrNull()?.let { provider ->
            withTimeoutOrNull(FIX_TIMEOUT_MS) { current(manager, provider) }
        }
        val fix = fresh ?: providers
            .mapNotNull { runCatching { manager.getLastKnownLocation(it) }.getOrNull() }
            .filter { now - it.time <= LAST_KNOWN_MAX_AGE_MS }
            .maxByOrNull { it.time }
        return fix?.let { toFix(it.latitude, it.longitude, if (it.hasAccuracy()) it.accuracy.toDouble() else null) }
            ?.let { Result.Found(it) }
            ?: Result.Unavailable
    }

    /** What the clock call sends: the accuracy rounded to whole metres, left out when unknown. */
    fun toFix(latitude: Double, longitude: Double, accuracy: Double?): GeoFix? {
        if (!latitude.isFinite() || !longitude.isFinite()) return null
        val metres = accuracy?.takeIf { it.isFinite() && it >= 0 }?.roundToLong()?.toDouble()
        return GeoFix(latitude, longitude, metres)
    }

    @SuppressLint("MissingPermission")
    private suspend fun current(manager: LocationManager, provider: String): Location? = suspendCancellableCoroutine { continuation ->
        val signal = CancellationSignal()
        continuation.invokeOnCancellation { signal.cancel() }
        LocationManagerCompat.getCurrentLocation(manager, provider, signal, Runnable::run) { location ->
            if (continuation.isActive) continuation.resume(location)
        }
    }
}
