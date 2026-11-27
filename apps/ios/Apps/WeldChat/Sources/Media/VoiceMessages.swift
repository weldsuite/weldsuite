import AVFoundation
import Foundation
import Observation
import SwiftUI
import WeldUI

/// Records a voice message: AAC in an MPEG-4 container (`.m4a`, playable
/// in every browser), with the level for the recording bar.
@MainActor
@Observable
final class VoiceRecorder {
    enum StartResult { case started, denied, failed }

    private(set) var isRecording = false
    private(set) var duration: TimeInterval = 0
    /// 0…1, from the recorder's meter.
    private(set) var level: Double = 0

    @ObservationIgnored private var recorder: AVAudioRecorder?
    @ObservationIgnored private var ticker: Task<Void, Never>?
    @ObservationIgnored private var fileURL: URL?

    func start() async -> StartResult {
        guard await AVAudioApplication.requestRecordPermission() else { return .denied }
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("voice_\(Int(Date().timeIntervalSince1970 * 1000)).m4a")
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: 44100,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
        ]
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetooth])
            try session.setActive(true)
            let recorder = try AVAudioRecorder(url: url, settings: settings)
            recorder.isMeteringEnabled = true
            guard recorder.record() else { return .failed }
            self.recorder = recorder
            fileURL = url
            isRecording = true
            duration = 0
            ticker = Task { [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(for: .milliseconds(80))
                    self?.tick()
                }
            }
            return .started
        } catch {
            return .failed
        }
    }

    /// Stop and hand over the file to send.
    func stop() -> PendingFile? {
        guard let recorder, let fileURL else { return nil }
        duration = recorder.currentTime
        recorder.stop()
        finish()
        return PendingFile(name: fileURL.lastPathComponent, url: fileURL, mimeType: "audio/mp4")
    }

    /// Throw the recording away.
    func cancel() {
        recorder?.stop()
        recorder?.deleteRecording()
        finish()
    }

    private func finish() {
        ticker?.cancel()
        ticker = nil
        recorder = nil
        isRecording = false
        level = 0
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func tick() {
        guard let recorder, recorder.isRecording else { return }
        recorder.updateMeters()
        duration = recorder.currentTime
        let decibels = Double(recorder.averagePower(forChannel: 0))
        level = max(0, min(1, (decibels + 60) / 60))
    }
}

/// One voice message (or other audio) playing. Only one plays at a time.
@MainActor
@Observable
final class AudioPlayback {
    private static weak var current: AudioPlayback?

    private(set) var isPlaying = false
    private(set) var position: TimeInterval = 0
    private(set) var duration: TimeInterval = 0
    private(set) var speed: Float = 1

    @ObservationIgnored private let url: URL
    @ObservationIgnored private var player: AVPlayer?
    @ObservationIgnored private var ticker: Task<Void, Never>?

    init(url: URL) {
        self.url = url
    }

    func toggle() {
        isPlaying ? pause() : play()
    }

    func play() {
        if Self.current !== self { Self.current?.pause() }
        Self.current = self
        let session = AVAudioSession.sharedInstance()
        if session.category != .playAndRecord { try? session.setCategory(.playback) }
        try? session.setActive(true)
        let player = player ?? AVPlayer(url: url)
        self.player = player
        if duration > 0, position >= duration - 0.05 { player.seek(to: .zero) }
        player.playImmediately(atRate: speed)
        isPlaying = true
        if duration == 0 { Task { await loadDuration() } }
        ticker?.cancel()
        ticker = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(100))
                self?.tick()
            }
        }
    }

    func pause() {
        player?.pause()
        isPlaying = false
        ticker?.cancel()
        ticker = nil
    }

    /// 1× → 1.5× → 2× → 1×.
    func cycleSpeed() {
        speed = speed >= 2 ? 1 : (speed >= 1.5 ? 2 : 1.5)
        if isPlaying { player?.rate = speed }
    }

    /// Jump to a fraction (0…1) of the message.
    func seek(to fraction: Double) {
        guard duration > 0 else { return }
        let target = duration * max(0, min(1, fraction))
        position = target
        let player = player ?? AVPlayer(url: url)
        self.player = player
        player.seek(to: CMTime(seconds: target, preferredTimescale: 600))
    }

    func stop() {
        pause()
        player = nil
    }

    private func loadDuration() async {
        guard let item = player?.currentItem, let length = try? await item.asset.load(.duration) else { return }
        let seconds = length.seconds
        if seconds.isFinite, seconds > 0 { duration = seconds }
    }

    private func tick() {
        guard let player else { return }
        let seconds = player.currentTime().seconds
        if seconds.isFinite { position = seconds }
        if duration > 0, position >= duration - 0.05, player.rate == 0 {
            isPlaying = false
            position = 0
            player.seek(to: .zero)
            ticker?.cancel()
            ticker = nil
        }
    }
}

/// A voice message in the conversation: play/pause, a waveform that seeks,
/// the time and the speed.
struct AudioPlayerView: View {
    let url: URL
    @State private var playback: AudioPlayback
    private let bars: [Double]

    init(url: URL) {
        self.url = url
        _playback = State(initialValue: AudioPlayback(url: url))
        bars = Waveform.bars(seed: Waveform.hash(url.absoluteString))
    }

    var body: some View {
        HStack(spacing: Tokens.Spacing.s) {
            Button {
                playback.toggle()
            } label: {
                Image(systemName: playback.isPlaying ? "pause.fill" : "play.fill")
                    .font(.system(size: 16))
                    .frame(width: 34, height: 34)
                    .foregroundStyle(.white)
                    .background(Tokens.Brand.weldchat, in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(playback.isPlaying ? ChatStrings.composerPause : ChatStrings.composerPlay)

            GeometryReader { geometry in
                let progress = playback.duration > 0 ? playback.position / playback.duration : 0
                HStack(alignment: .center, spacing: 2) {
                    ForEach(Array(bars.enumerated()), id: \.offset) { index, height in
                        Capsule()
                            .fill(Double(index) / Double(bars.count) <= progress ? Tokens.Brand.weldchat : Color.secondary.opacity(0.4))
                            .frame(width: 3, height: max(4, geometry.size.height * height))
                    }
                }
                .frame(maxHeight: .infinity)
                .contentShape(Rectangle())
                .gesture(DragGesture(minimumDistance: 0).onEnded { value in
                    playback.seek(to: value.location.x / max(1, geometry.size.width))
                })
            }
            .frame(height: 28)

            Text(ChatLogic.clock(playback.isPlaying || playback.position > 0 ? playback.position : playback.duration))
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)

            Button {
                playback.cycleSpeed()
            } label: {
                Text(ChatStrings.composerPlaybackSpeed(speed: speedText))
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(.quaternary, in: Capsule())
            }
            .buttonStyle(.plain)
        }
        .padding(Tokens.Spacing.s)
        .frame(maxWidth: 300)
        .background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: Tokens.Radius.medium))
        .onDisappear { playback.stop() }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(ChatStrings.composerVoiceMessage)
    }

    private var speedText: String {
        playback.speed == 1 ? "1" : (playback.speed == 2 ? "2" : "1.5")
    }
}

/// The recording bar: cancel, the time and level, send.
struct RecordingBar: View {
    let recorder: VoiceRecorder
    let sending: Bool
    let frozenDuration: TimeInterval?
    let onCancel: () -> Void
    let onSend: () -> Void

    var body: some View {
        HStack(spacing: Tokens.Spacing.m) {
            Button(action: onCancel) {
                Image(systemName: "trash").font(.system(size: 18))
            }
            .disabled(sending)
            .accessibilityLabel(ChatStrings.composerDeleteRecording)
            .accessibilityIdentifier("recording-cancel")

            Circle().fill(Tokens.Status.danger).frame(width: 8, height: 8)
            Text(ChatLogic.clock(frozenDuration ?? recorder.duration))
                .font(.body.monospacedDigit())
            GeometryReader { geometry in
                Capsule()
                    .fill(Tokens.Brand.weldchat.opacity(0.5))
                    .frame(width: max(6, geometry.size.width * recorder.level), height: 6)
                    .frame(maxHeight: .infinity, alignment: .center)
            }
            .frame(height: 20)

            Button(action: onSend) {
                Group {
                    if sending {
                        ProgressView().tint(.white)
                    } else {
                        Image(systemName: "arrow.up").font(.system(size: 16, weight: .bold))
                    }
                }
                .frame(width: 34, height: 34)
                .foregroundStyle(.white)
                .background(Tokens.Brand.weldchat, in: Circle())
            }
            .disabled(sending)
            .accessibilityLabel(ChatStrings.composerSend)
            .accessibilityIdentifier("recording-send")
        }
        .padding(.horizontal, Tokens.Spacing.m)
        .padding(.vertical, Tokens.Spacing.s)
        .background(.bar, in: Capsule())
    }
}
