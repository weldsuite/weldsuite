package com.weldsuite.weldchat.media

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.net.Uri
import android.os.Build
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import com.weldsuite.weldchat.ChatLogic
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.File
import java.io.IOException

/**
 * Records a voice message: AAC in an MPEG-4 container (`.m4a`, playable in
 * every browser and on iOS), with the level for the recording bar. Its
 * state is Compose state. Ask for `RECORD_AUDIO` before [start].
 */
class VoiceRecorder(context: Context) {
    private val app = context.applicationContext

    enum class StartResult { STARTED, DENIED, FAILED }

    /** A finished recording: the file to send and how long it is. */
    data class Recording(val file: PendingFile, val durationMs: Long) {
        /** Shorter ones are dropped: almost always an accidental tap. */
        val isTooShort: Boolean get() = durationMs < ChatLogic.MIN_VOICE_MESSAGE_MS
    }

    var isRecording by mutableStateOf(false)
        private set
    var durationMs by mutableLongStateOf(0L)
        private set

    /** 0…1, from the recorder's amplitude. */
    var level by mutableFloatStateOf(0f)
        private set

    private var recorder: MediaRecorder? = null
    private var file: File? = null
    private var startedAt = 0L
    private var ticker: Job? = null

    fun hasPermission(): Boolean =
        ContextCompat.checkSelfPermission(app, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    /** Start recording; the level and time tick on [scope]. */
    fun start(scope: CoroutineScope): StartResult {
        if (!hasPermission()) return StartResult.DENIED
        if (isRecording) return StartResult.STARTED
        val target = File(app.cacheDir, "voice_${System.currentTimeMillis()}.m4a")
        val next = newRecorder()
        return try {
            next.setAudioSource(MediaRecorder.AudioSource.MIC)
            next.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            next.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            next.setAudioSamplingRate(44_100)
            next.setAudioEncodingBitRate(96_000)
            next.setAudioChannels(1)
            next.setOutputFile(target.absolutePath)
            next.prepare()
            next.start()
            recorder = next
            file = target
            startedAt = System.currentTimeMillis()
            durationMs = 0
            isRecording = true
            ticker = scope.launch {
                while (isActive && isRecording) {
                    delay(80)
                    tick()
                }
            }
            StartResult.STARTED
        } catch (_: IOException) {
            next.release()
            StartResult.FAILED
        } catch (_: RuntimeException) {
            // MediaRecorder reports a busy or missing microphone as a runtime exception.
            next.release()
            StartResult.FAILED
        }
    }

    /** Stop and hand over the file to send; null when nothing was recorded. */
    fun stop(): Recording? {
        val current = recorder ?: return null
        val target = file ?: return null
        val length = System.currentTimeMillis() - startedAt
        val stopped = runCatching { current.stop() }.isSuccess
        finish()
        if (!stopped) {
            target.delete()
            return null
        }
        durationMs = length
        return Recording(PendingFile(name = target.name, uri = Uri.fromFile(target), mimeType = "audio/mp4"), length)
    }

    /** Throw the recording away. */
    fun cancel() {
        recorder?.let { runCatching { it.stop() } }
        finish()
        file?.delete()
        file = null
    }

    private fun finish() {
        ticker?.cancel()
        ticker = null
        recorder?.release()
        recorder = null
        isRecording = false
        level = 0f
    }

    private fun tick() {
        val current = recorder ?: return
        durationMs = System.currentTimeMillis() - startedAt
        val amplitude = runCatching { current.maxAmplitude }.getOrDefault(0)
        level = (amplitude / 32_767f).coerceIn(0f, 1f)
    }

    private fun newRecorder(): MediaRecorder =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) MediaRecorder(app) else legacyRecorder()

    @Suppress("DEPRECATION")
    private fun legacyRecorder(): MediaRecorder = MediaRecorder()
}

/**
 * One voice message (or other audio) playing, from its address. Only one
 * plays at a time: starting one pauses the other. Its state is Compose state.
 */
class AudioPlayback(private val url: String) {
    var isPlaying by mutableStateOf(false)
        private set
    var positionMs by mutableLongStateOf(0L)
        private set
    var durationMs by mutableLongStateOf(0L)
        private set
    var speed by mutableFloatStateOf(1f)
        private set

    private var player: MediaPlayer? = null
    private var prepared = false
    private var ticker: Job? = null
    private var scope: CoroutineScope? = null

    fun toggle(scope: CoroutineScope) {
        if (isPlaying) pause() else play(scope)
    }

    fun play(scope: CoroutineScope) {
        this.scope = scope
        if (current !== this) current?.pause()
        current = this
        val existing = player
        if (existing != null && prepared) {
            if (durationMs > 0 && positionMs >= durationMs - 50) existing.seekTo(0)
            applySpeed(existing)
            existing.start()
            isPlaying = true
            startTicker(scope)
            return
        }
        if (existing != null) return
        val next = MediaPlayer()
        player = next
        try {
            next.setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            next.setDataSource(url)
            next.setOnPreparedListener { ready ->
                prepared = true
                durationMs = ready.duration.toLong().coerceAtLeast(0)
                if (positionMs > 0) ready.seekTo(positionMs.toInt())
                applySpeed(ready)
                ready.start()
                isPlaying = true
                this.scope?.let { startTicker(it) }
            }
            next.setOnCompletionListener {
                isPlaying = false
                positionMs = 0
                ticker?.cancel()
            }
            next.setOnErrorListener { _, _, _ ->
                release()
                true
            }
            next.prepareAsync()
        } catch (_: IOException) {
            release()
        } catch (_: IllegalStateException) {
            release()
        } catch (_: IllegalArgumentException) {
            release()
        }
    }

    fun pause() {
        player?.takeIf { prepared && it.isPlaying }?.pause()
        isPlaying = false
        ticker?.cancel()
    }

    /** 1× → 1.5× → 2× → 1×. */
    fun cycleSpeed() {
        speed = when {
            speed >= 2f -> 1f
            speed >= 1.5f -> 2f
            else -> 1.5f
        }
        player?.takeIf { prepared && isPlaying }?.let { applySpeed(it) }
    }

    /** Jump to a fraction (0…1) of the message. */
    fun seek(fraction: Float) {
        if (durationMs <= 0) return
        val target = (durationMs * fraction.coerceIn(0f, 1f)).toLong()
        positionMs = target
        player?.takeIf { prepared }?.seekTo(target.toInt())
    }

    /** Stop and let go of the player (the row left the screen). */
    fun release() {
        ticker?.cancel()
        ticker = null
        player?.release()
        player = null
        prepared = false
        isPlaying = false
        if (current === this) current = null
    }

    /** The label of the speed button: "1", "1.5", "2". */
    val speedText: String get() = if (speed == 1f) "1" else if (speed == 2f) "2" else "1.5"

    private fun applySpeed(target: MediaPlayer) {
        runCatching { target.playbackParams = target.playbackParams.setSpeed(speed) }
    }

    private fun startTicker(scope: CoroutineScope) {
        ticker?.cancel()
        ticker = scope.launch {
            while (isActive && isPlaying) {
                player?.takeIf { prepared }?.let { positionMs = it.currentPosition.toLong() }
                delay(100)
            }
        }
    }

    private companion object {
        var current: AudioPlayback? = null
    }
}
