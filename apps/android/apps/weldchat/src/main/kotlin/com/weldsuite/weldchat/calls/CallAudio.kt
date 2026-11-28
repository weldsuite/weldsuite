package com.weldsuite.weldchat.calls

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import io.livekit.android.audio.AudioHandler

/**
 * The phone's call audio while a call is joined, handed to LiveKit as its
 * audio handler. LiveKit's own (Twilio's audioswitch) is published on
 * JitPack only, which this build doesn't use; this one does what a call
 * needs with `AudioManager` alone: communication mode and audio focus for
 * the call, a Bluetooth headset or a wired one when connected, else the
 * speaker for a video call (or when the person turns it on) and the
 * earpiece for a voice call.
 */
class CallAudio(context: Context) : AudioHandler {
    private val audio = context.applicationContext.getSystemService(AudioManager::class.java)
    private val main = Handler(Looper.getMainLooper())
    private var previousMode = AudioManager.MODE_NORMAL
    private var focus: AudioFocusRequest? = null
    private var started = false

    /** The speaker instead of the earpiece (no headset connected). Video calls start on it. */
    var speakerOn: Boolean = false
        set(value) {
            field = value
            if (started) route()
        }

    private val devices = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>?) = route()

        override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>?) = route()
    }

    override fun start() {
        if (started) return
        started = true
        previousMode = audio.mode
        val attributes = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                .setAudioAttributes(attributes)
                .build()
            focus = request
            audio.requestAudioFocus(request)
        } else {
            requestLegacyFocus()
        }
        audio.mode = AudioManager.MODE_IN_COMMUNICATION
        audio.registerAudioDeviceCallback(devices, main)
        route()
    }

    override fun stop() {
        if (!started) return
        started = false
        audio.unregisterAudioDeviceCallback(devices)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            audio.clearCommunicationDevice()
        } else {
            stopLegacyRouting()
        }
        audio.mode = previousMode
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            focus?.let(audio::abandonAudioFocusRequest)
        } else {
            abandonLegacyFocus()
        }
        focus = null
    }

    private fun route() {
        if (!started) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val available = audio.availableCommunicationDevices
            val target = available.firstOrNull { it.type in HEADSETS_BLUETOOTH }
                ?: available.firstOrNull { it.type in HEADSETS_WIRED }
                ?: available.firstOrNull { it.type == if (speakerOn) AudioDeviceInfo.TYPE_BUILTIN_SPEAKER else AudioDeviceInfo.TYPE_BUILTIN_EARPIECE }
                ?: available.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
            if (target != null) audio.setCommunicationDevice(target)
        } else {
            routeLegacy()
        }
    }

    // Before Android 12 there is no communication device to set: Bluetooth
    // SCO and the speakerphone switch are the only way, deprecated since.

    @Suppress("DEPRECATION")
    private fun routeLegacy() {
        val outputs = audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
        val bluetooth = outputs.any { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO }
        val wired = outputs.any { it.type in HEADSETS_WIRED }
        if (bluetooth) {
            audio.isSpeakerphoneOn = false
            audio.startBluetoothSco()
            audio.isBluetoothScoOn = true
        } else {
            if (audio.isBluetoothScoOn) {
                audio.isBluetoothScoOn = false
                audio.stopBluetoothSco()
            }
            audio.isSpeakerphoneOn = speakerOn && !wired
        }
    }

    @Suppress("DEPRECATION")
    private fun stopLegacyRouting() {
        if (audio.isBluetoothScoOn) {
            audio.isBluetoothScoOn = false
            audio.stopBluetoothSco()
        }
        audio.isSpeakerphoneOn = false
    }

    @Suppress("DEPRECATION")
    private fun requestLegacyFocus() {
        audio.requestAudioFocus(null, AudioManager.STREAM_VOICE_CALL, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
    }

    @Suppress("DEPRECATION")
    private fun abandonLegacyFocus() {
        audio.abandonAudioFocus(null)
    }

    private companion object {
        val HEADSETS_BLUETOOTH = setOf(AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET)
        val HEADSETS_WIRED = setOf(
            AudioDeviceInfo.TYPE_WIRED_HEADSET,
            AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
            AudioDeviceInfo.TYPE_USB_HEADSET,
        )
    }
}
