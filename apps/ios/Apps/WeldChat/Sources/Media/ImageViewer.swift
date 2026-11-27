import SwiftUI
import WeldCore
import WeldUI

/// A photo of the conversation, for the viewer.
struct ViewerImage: Identifiable, Equatable {
    let url: String
    let authorName: String
    let createdAt: String

    var id: String { url }
}

/// What the viewer opens on: every photo of the conversation, at one of them.
struct ImageViewerState: Identifiable {
    let images: [ViewerImage]
    let start: String

    var id: String { start }
}

/// The conversation's photos full screen: swipe between them, pinch or
/// double-tap to zoom, the sender and the time below.
struct ImageViewer: View {
    let state: ImageViewerState
    @State private var selection: String
    @Environment(\.dismiss) private var dismiss

    init(state: ImageViewerState) {
        self.state = state
        _selection = State(initialValue: state.start)
    }

    var body: some View {
        ZStack(alignment: .top) {
            Color.black.ignoresSafeArea()
            TabView(selection: $selection) {
                ForEach(state.images) { image in
                    ZoomableImage(url: URL(string: image.url))
                        .tag(image.url)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: state.images.count > 1 ? .automatic : .never))

            HStack {
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundStyle(.white)
                        .padding(10)
                        .background(Color.black.opacity(0.4), in: Circle())
                }
                .accessibilityLabel(CoreStrings.commonClose)
                Spacer()
                if let url = URL(string: selection) {
                    ShareLink(item: url) {
                        Image(systemName: "square.and.arrow.up")
                            .font(.system(size: 18, weight: .semibold))
                            .foregroundStyle(.white)
                            .padding(10)
                            .background(Color.black.opacity(0.4), in: Circle())
                    }
                }
            }
            .padding()

            if let current = state.images.first(where: { $0.url == selection }) {
                VStack(spacing: 2) {
                    Spacer()
                    Text(current.authorName).font(.subheadline.weight(.semibold))
                    if let date = WeldDate.parse(current.createdAt) {
                        Text(WeldDate.relative(date)).font(.caption)
                    }
                }
                .foregroundStyle(.white)
                .padding(.bottom, 40)
                .allowsHitTesting(false)
            }
        }
    }
}

private struct ZoomableImage: View {
    let url: URL?
    @State private var scale: CGFloat = 1
    @State private var lastScale: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var lastOffset: CGSize = .zero

    var body: some View {
        AsyncImage(url: url) { phase in
            if let image = phase.image {
                image.resizable().scaledToFit()
            } else if phase.error != nil {
                Image(systemName: "photo").foregroundStyle(Color.white.opacity(0.6))
            } else {
                ProgressView().tint(.white)
            }
        }
        .scaleEffect(scale)
        .offset(offset)
        .gesture(
            MagnifyGesture()
                .onChanged { value in scale = max(1, min(5, lastScale * value.magnification)) }
                .onEnded { _ in
                    lastScale = scale
                    if scale <= 1 { reset() }
                }
        )
        .simultaneousGesture(
            DragGesture()
                .onChanged { value in
                    guard scale > 1 else { return }
                    offset = CGSize(width: lastOffset.width + value.translation.width, height: lastOffset.height + value.translation.height)
                }
                .onEnded { _ in lastOffset = offset }
        )
        .onTapGesture(count: 2) {
            withAnimation {
                if scale > 1 {
                    reset()
                } else {
                    scale = 2.5
                    lastScale = 2.5
                }
            }
        }
    }

    private func reset() {
        scale = 1
        lastScale = 1
        offset = .zero
        lastOffset = .zero
    }
}
