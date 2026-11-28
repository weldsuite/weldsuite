package com.weldsuite.weldchat.media

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.InsertDriveFile
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import coil.compose.AsyncImage
import com.weldsuite.weldchat.ChatAttachment
import com.weldsuite.weldchat.ChatLogic
import com.weldsuite.weldchat.R
import com.weldsuite.weldchat.Waveform
import org.weldsuite.core.WeldDate
import org.weldsuite.ui.Tokens
import org.weldsuite.ui.tagged
import org.weldsuite.core.R as CoreR

/** A photo of the conversation, as the viewer pages through them. */
data class ViewerImage(val url: String, val authorName: String, val createdAt: String)

/** The viewer's photos and the one it opens on. */
data class ImageViewerState(val images: List<ViewerImage>, val start: String)

// MARK: Picking files

/** The composer's "+": photos from the library, or any file. */
class AttachmentPicker internal constructor(val pickPhotos: () -> Unit, val pickFiles: () -> Unit)

/** The system pickers, handing what was picked to [onPicked]. */
@Composable
fun rememberAttachmentPicker(onPicked: (List<PendingFile>) -> Unit): AttachmentPicker {
    val context = LocalContext.current
    val photos = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(10)) { uris ->
        if (uris.isNotEmpty()) onPicked(uris.map { PickedFiles.from(context, it) })
    }
    val files = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        if (uris.isNotEmpty()) onPicked(uris.map { PickedFiles.from(context, it) })
    }
    return remember(photos, files) {
        AttachmentPicker(
            pickPhotos = { photos.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
            pickFiles = { files.launch(arrayOf("*/*")) },
        )
    }
}

/** "Attach": photo library or a file. */
@Composable
fun AttachmentSourceDialog(picker: AttachmentPicker, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.weldchat_composer_attach_title)) },
        text = {
            Column {
                TextButton(
                    onClick = {
                        onDismiss()
                        picker.pickPhotos()
                    },
                    modifier = Modifier.fillMaxWidth().tagged("attach-photos"),
                ) { Text(stringResource(R.string.weldchat_composer_photo_library)) }
                TextButton(
                    onClick = {
                        onDismiss()
                        picker.pickFiles()
                    },
                    modifier = Modifier.fillMaxWidth().tagged("attach-file"),
                ) { Text(stringResource(R.string.weldchat_composer_file)) }
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(CoreR.string.core_common_cancel)) } },
    )
}

/** The files picked so far, above the composer, each with a remove button. */
@Composable
fun PendingFilesBar(files: List<PendingFile>, onRemove: (PendingFile) -> Unit, modifier: Modifier = Modifier) {
    if (files.isEmpty()) return
    Row(
        modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = Tokens.Spacing.m, vertical = Tokens.Spacing.xs),
        horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
    ) {
        val remove = stringResource(R.string.weldchat_composer_remove_attachment)
        files.forEach { file ->
            Surface(shape = RoundedCornerShape(50), color = MaterialTheme.colorScheme.surfaceVariant) {
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(start = Tokens.Spacing.s)) {
                    Icon(
                        if (file.isImage) Icons.Filled.Image else Icons.AutoMirrored.Filled.InsertDriveFile,
                        contentDescription = null,
                        modifier = Modifier.size(16.dp),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(
                        file.name,
                        style = MaterialTheme.typography.labelMedium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.padding(start = Tokens.Spacing.xs).widthIn(max = 140.dp),
                    )
                    IconButton(onClick = { onRemove(file) }, modifier = Modifier.size(32.dp)) {
                        Icon(Icons.Filled.Close, contentDescription = remove, modifier = Modifier.size(16.dp))
                    }
                }
            }
        }
    }
}

// MARK: Voice messages

/** The recording bar: cancel, the time and level, send. */
@Composable
fun RecordingBar(
    recorder: VoiceRecorder,
    sending: Boolean,
    onCancel: () -> Unit,
    onSend: () -> Unit,
    modifier: Modifier = Modifier,
    frozenDurationMs: Long? = null,
) {
    val brand = MaterialTheme.colorScheme.primary
    Surface(modifier = modifier.fillMaxWidth().padding(Tokens.Spacing.s), shape = RoundedCornerShape(50), tonalElevation = 3.dp) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.m),
            modifier = Modifier.padding(horizontal = Tokens.Spacing.s, vertical = Tokens.Spacing.xs),
        ) {
            IconButton(onClick = onCancel, enabled = !sending, modifier = Modifier.tagged("recording-cancel")) {
                Icon(Icons.Filled.Delete, contentDescription = stringResource(R.string.weldchat_composer_delete_recording))
            }
            Box(Modifier.size(8.dp).clip(CircleShape).background(MaterialTheme.colorScheme.error))
            Text(ChatLogic.clock((frozenDurationMs ?: recorder.durationMs) / 1000), style = MaterialTheme.typography.bodyLarge)
            Box(Modifier.weight(1f).height(20.dp), contentAlignment = Alignment.CenterStart) {
                Box(
                    Modifier
                        .fillMaxWidth(recorder.level.coerceAtLeast(0.03f))
                        .height(6.dp)
                        .clip(RoundedCornerShape(50))
                        .background(brand.copy(alpha = 0.5f)),
                )
            }
            Surface(
                onClick = onSend,
                enabled = !sending,
                shape = CircleShape,
                color = brand,
                modifier = Modifier.size(36.dp).tagged("recording-send"),
            ) {
                Box(contentAlignment = Alignment.Center) {
                    val send = stringResource(R.string.weldchat_composer_send)
                    if (sending) {
                        CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                    } else {
                        Icon(Icons.Filled.ArrowUpward, contentDescription = send, tint = MaterialTheme.colorScheme.onPrimary)
                    }
                }
            }
        }
    }
}

/**
 * A voice message in the conversation: play/pause, a waveform that seeks,
 * the time and the speed.
 */
@Composable
fun AudioPlayerRow(url: String, modifier: Modifier = Modifier) {
    val playback = remember(url) { AudioPlayback(url) }
    val bars = remember(url) { Waveform.bars(Waveform.hash(url)) }
    val scope = rememberCoroutineScope()
    DisposableEffect(playback) { onDispose { playback.release() } }
    val brand = MaterialTheme.colorScheme.primary
    val idle = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.4f)
    val description = stringResource(R.string.weldchat_composer_voice_message)
    Row(
        modifier
            .widthIn(max = 300.dp)
            .clip(RoundedCornerShape(Tokens.Radius.medium))
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f))
            .padding(Tokens.Spacing.s)
            .semantics { contentDescription = description },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Spacing.s),
    ) {
        Surface(onClick = { playback.toggle(scope) }, shape = CircleShape, color = brand, modifier = Modifier.size(34.dp)) {
            Box(contentAlignment = Alignment.Center) {
                Icon(
                    if (playback.isPlaying) Icons.Filled.Pause else Icons.Filled.PlayArrow,
                    contentDescription = stringResource(if (playback.isPlaying) R.string.weldchat_composer_pause else R.string.weldchat_composer_play),
                    tint = MaterialTheme.colorScheme.onPrimary,
                )
            }
        }
        val progress = Waveform.progress(playback.positionMs, playback.durationMs)
        Canvas(
            Modifier
                .weight(1f)
                .height(28.dp)
                .pointerInput(playback) {
                    detectTapGestures { offset -> playback.seek(offset.x / size.width.coerceAtLeast(1)) }
                },
        ) {
            val gap = 2.dp.toPx()
            val barWidth = ((size.width - gap * (bars.size - 1)) / bars.size).coerceAtLeast(1f)
            bars.forEachIndexed { index, height ->
                val barHeight = (size.height * height.toFloat()).coerceAtLeast(4.dp.toPx())
                val x = index * (barWidth + gap)
                drawRoundRect(
                    color = if (index.toFloat() / bars.size <= progress && progress > 0f) brand else idle,
                    topLeft = Offset(x, (size.height - barHeight) / 2),
                    size = Size(barWidth, barHeight),
                    cornerRadius = CornerRadius(barWidth / 2),
                )
            }
        }
        val shown = if (playback.isPlaying || playback.positionMs > 0) playback.positionMs else playback.durationMs
        Text(ChatLogic.clock(shown / 1000), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Surface(onClick = { playback.cycleSpeed() }, shape = RoundedCornerShape(50), color = MaterialTheme.colorScheme.surface) {
            Text(
                stringResource(R.string.weldchat_composer_playback_speed, playback.speedText),
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
            )
        }
    }
}

// MARK: Photos and files

/** The conversation's photos, full screen: swipe between them, pinch to zoom. */
@Composable
fun ImageViewer(state: ImageViewerState, onDismiss: () -> Unit) {
    val startIndex = state.images.indexOfFirst { it.url == state.start }.coerceAtLeast(0)
    val pager = rememberPagerState(initialPage = startIndex) { state.images.size }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Box(Modifier.fillMaxSize().background(Color.Black).tagged("image-viewer")) {
            HorizontalPager(state = pager, modifier = Modifier.fillMaxSize()) { page ->
                ZoomableImage(state.images[page].url)
            }
            val current = state.images.getOrNull(pager.currentPage)
            Row(
                Modifier.fillMaxWidth().statusBarsPadding().padding(Tokens.Spacing.s),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(onClick = onDismiss, modifier = Modifier.tagged("image-viewer-close")) {
                    Icon(Icons.Filled.Close, contentDescription = stringResource(CoreR.string.core_common_close), tint = Color.White)
                }
                if (current != null) {
                    Column(Modifier.weight(1f)) {
                        Text(current.authorName, color = Color.White, style = MaterialTheme.typography.titleSmall, maxLines = 1)
                        WeldDate.parse(current.createdAt)?.let {
                            Text(WeldDate.dateTime(it), color = Color.White.copy(alpha = 0.7f), style = MaterialTheme.typography.labelSmall)
                        }
                    }
                    if (state.images.size > 1) {
                        Text("${pager.currentPage + 1} / ${state.images.size}", color = Color.White, style = MaterialTheme.typography.labelMedium)
                    }
                }
            }
        }
    }
}

@Composable
private fun ZoomableImage(url: String) {
    var scale by remember(url) { mutableFloatStateOf(1f) }
    var offset by remember(url) { mutableStateOf(Offset.Zero) }
    AsyncImage(
        model = url,
        contentDescription = null,
        contentScale = ContentScale.Fit,
        modifier = Modifier
            .fillMaxSize()
            .pointerInput(url) {
                detectTapGestures(onDoubleTap = {
                    scale = if (scale > 1f) 1f else 2.5f
                    offset = Offset.Zero
                })
            }
            .pointerInput(url) {
                detectTransformGestures { _, pan, zoom, _ ->
                    scale = (scale * zoom).coerceIn(1f, 5f)
                    offset = if (scale == 1f) Offset.Zero else offset + pan
                }
            }
            .graphicsLayer(scaleX = scale, scaleY = scale, translationX = offset.x, translationY = offset.y),
    )
}

/** Open an attachment that isn't a photo or a voice message: the phone's viewer, or the browser. */
fun openAttachment(context: Context, attachment: ChatAttachment): Boolean {
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(attachment.url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    return try {
        context.startActivity(intent)
        true
    } catch (_: ActivityNotFoundException) {
        false
    }
}
