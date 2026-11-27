import Foundation
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers
import WeldCore

/// A file picked to send with a message, copied into the app's temporary folder.
struct PendingFile: Identifiable, Equatable {
    let id = UUID()
    var name: String
    var url: URL
    var mimeType: String

    var isImage: Bool { mimeType.hasPrefix("image/") }
}

/// The upload the contract can't describe (multipart): `POST
/// /api/chat-messages/upload` with `file` and `channelId`, answering 201
/// `{ data: { id, fileName, fileSize, mimeType, url } }`. Sent with the
/// headers every API call carries (`WeldHeadersMiddleware`).
@MainActor
enum ChatUpload {
    private struct Answer: Decodable {
        struct File: Decodable {
            let id: String?
            let fileName: String?
            let fileSize: Double?
            let mimeType: String?
            let url: String
        }

        let data: File
    }

    static func upload(_ file: PendingFile, channelID: String, env: AppEnvironment) async throws -> ChatAttachment {
        guard let session = env.session, let workspace = session.activeWorkspaceID else {
            throw APIError(status: nil, code: nil)
        }
        let bytes: Data
        do {
            bytes = try Data(contentsOf: file.url)
        } catch {
            throw APIError(status: 0, code: nil)
        }
        let boundary = "weldchat-\(UUID().uuidString)"
        var body = Data()
        func append(_ text: String) { body.append(Data(text.utf8)) }
        append("--\(boundary)\r\nContent-Disposition: form-data; name=\"channelId\"\r\n\r\n\(channelID)\r\n")
        let safeName = file.name.replacingOccurrences(of: "\"", with: "")
        append("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(safeName)\"\r\n")
        append("Content-Type: \(file.mimeType)\r\n\r\n")
        body.append(bytes)
        append("\r\n--\(boundary)--\r\n")

        var request = URLRequest(url: env.serverURL.appendingPathComponent("api/chat-messages/upload"))
        request.httpMethod = "POST"
        request.timeoutInterval = 120
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(env.app.code, forHTTPHeaderField: "X-Weld-App")
        request.setValue(workspace, forHTTPHeaderField: "X-Weld-Workspace")

        var token = await session.token()
        for attempt in 0..<2 {
            if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
            let result: (Data, URLResponse)
            do {
                result = try await URLSession.shared.upload(for: request, from: body)
            } catch {
                throw APIError(status: nil, code: nil)
            }
            let (data, response) = result
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            if status == 401, attempt == 0, let fresh = await session.refreshedToken() {
                token = fresh
                continue
            }
            guard (200..<300).contains(status), let answer = try? JSONDecoder().decode(Answer.self, from: data) else {
                throw APIError(status: status, code: nil)
            }
            return ChatAttachment(
                id: answer.data.id ?? UUID().uuidString,
                fileName: answer.data.fileName ?? file.name,
                fileSize: answer.data.fileSize ?? Double(bytes.count),
                mimeType: answer.data.mimeType ?? file.mimeType,
                url: answer.data.url
            )
        }
        throw APIError(status: 401, code: nil)
    }
}

enum PickedFiles {
    /// A copy of a file the person picked, in the temporary folder.
    static func copy(_ url: URL) -> PendingFile? {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let target = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
            let destination = target.appendingPathComponent(url.lastPathComponent)
            try FileManager.default.copyItem(at: url, to: destination)
            return PendingFile(name: url.lastPathComponent, url: destination, mimeType: mimeType(forExtension: url.pathExtension))
        } catch {
            return nil
        }
    }

    /// Photo library data written to a file.
    static func write(_ data: Data, type: UTType?) -> PendingFile? {
        let ext = type?.preferredFilenameExtension ?? "jpg"
        let name = "photo_\(Int(Date().timeIntervalSince1970 * 1000)).\(ext)"
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(name)
        do {
            try data.write(to: url)
        } catch {
            return nil
        }
        return PendingFile(name: name, url: url, mimeType: type?.preferredMIMEType ?? "image/jpeg")
    }

    static func mimeType(forExtension ext: String) -> String {
        UTType(filenameExtension: ext)?.preferredMIMEType ?? "application/octet-stream"
    }
}

/// The composer's "+": photos from the library, or any file.
struct AttachmentPicker: ViewModifier {
    @Binding var isPresented: Bool
    let onPicked: ([PendingFile]) -> Void

    @State private var showPhotos = false
    @State private var showFiles = false
    @State private var photoItems: [PhotosPickerItem] = []

    func body(content: Content) -> some View {
        content
            .confirmationDialog(ChatStrings.composerAttachTitle, isPresented: $isPresented, titleVisibility: .visible) {
                Button(ChatStrings.composerPhotoLibrary) { showPhotos = true }
                Button(ChatStrings.composerFile) { showFiles = true }
                Button(CoreStrings.commonCancel, role: .cancel) {}
            }
            .photosPicker(isPresented: $showPhotos, selection: $photoItems, maxSelectionCount: 10, matching: .images)
            .fileImporter(isPresented: $showFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
                guard case let .success(urls) = result else { return }
                let files = urls.compactMap(PickedFiles.copy)
                if !files.isEmpty { onPicked(files) }
            }
            .onChange(of: photoItems) { _, items in
                guard !items.isEmpty else { return }
                photoItems = []
                Task {
                    var files: [PendingFile] = []
                    for item in items {
                        guard let data = try? await item.loadTransferable(type: Data.self) else { continue }
                        if let file = PickedFiles.write(data, type: item.supportedContentTypes.first) { files.append(file) }
                    }
                    if !files.isEmpty { onPicked(files) }
                }
            }
    }
}

extension View {
    func attachmentPicker(isPresented: Binding<Bool>, onPicked: @escaping ([PendingFile]) -> Void) -> some View {
        modifier(AttachmentPicker(isPresented: isPresented, onPicked: onPicked))
    }
}

/// The files picked so far, above the composer, each with a remove button.
struct PendingFilesBar: View {
    let files: [PendingFile]
    let onRemove: (PendingFile) -> Void

    var body: some View {
        if !files.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Tokens.Spacing.s) {
                    ForEach(files) { file in
                        HStack(spacing: Tokens.Spacing.xs) {
                            Image(systemName: file.isImage ? "photo" : "doc")
                                .foregroundStyle(.secondary)
                            Text(file.name).font(.caption).lineLimit(1).frame(maxWidth: 140)
                            Button {
                                onRemove(file)
                            } label: {
                                Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                            }
                            .accessibilityLabel(ChatStrings.composerRemoveAttachment)
                        }
                        .padding(.horizontal, Tokens.Spacing.s)
                        .padding(.vertical, Tokens.Spacing.xs)
                        .background(.quaternary, in: Capsule())
                    }
                }
                .padding(.horizontal, Tokens.Spacing.m)
            }
        }
    }
}
