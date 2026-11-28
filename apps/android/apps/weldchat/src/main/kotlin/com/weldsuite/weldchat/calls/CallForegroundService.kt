package com.weldsuite.weldchat.calls

import android.Manifest
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * Keeps a joined call going while the app is in the background: the
 * microphone (and the camera of a video call) stay in use, under the call's
 * ongoing notification with its hang-up button.
 */
class CallForegroundService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val video = intent?.getBooleanExtra(EXTRA_VIDEO, false) == true
        val notification = CallRinging.ongoingNotification(this, intent?.getStringExtra(EXTRA_TITLE), video)
        try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, types(video))
        } catch (_: RuntimeException) {
            // Not allowed now (a type without its permission, or from the background): no service then.
            stopSelf()
        }
        return START_NOT_STICKY
    }

    private fun types(video: Boolean): Int {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return 0
        var types = ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL
        if (granted(Manifest.permission.RECORD_AUDIO)) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        if (video && granted(Manifest.permission.CAMERA)) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
        return types
    }

    private fun granted(permission: String) =
        ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

    companion object {
        private const val NOTIFICATION_ID = 7_301
        private const val EXTRA_TITLE = "title"
        private const val EXTRA_VIDEO = "video"

        /** Start (or update) the service for the joined call. */
        fun start(context: Context, title: String?, video: Boolean) {
            val intent = Intent(context, CallForegroundService::class.java)
                .putExtra(EXTRA_TITLE, title)
                .putExtra(EXTRA_VIDEO, video)
            try {
                ContextCompat.startForegroundService(context, intent)
            } catch (_: RuntimeException) {
                // The app isn't allowed to start one now; the call still runs while on screen.
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, CallForegroundService::class.java))
        }
    }
}
