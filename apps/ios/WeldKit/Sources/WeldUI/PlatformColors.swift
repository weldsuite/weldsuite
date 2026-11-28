import SwiftUI

/// The colours the web platform derives from a name: a person's avatar, a
/// label without a colour of its own. Same palettes and same hash
/// (`hashString` in the platform's conversation-list utils), so a name looks
/// the same here as there.
public enum PlatformColors {
    static let avatars: [UInt32] = [
        0x4F46E5, 0x7C3AED, 0xEC4899, 0xEF4444, 0xF97316,
        0xEAB308, 0x22C55E, 0x14B8A6, 0x06B6D4, 0x3B82F6,
    ]

    static let labels: [UInt32] = [
        0xEF4444, 0xF97316, 0xF59E0B, 0xEAB308, 0x84CC16,
        0x22C55E, 0x10B981, 0x14B8A6, 0x06B6D4, 0x0EA5E9,
        0x3B82F6, 0x6366F1, 0x8B5CF6, 0xA855F7, 0xD946EF,
        0xEC4899, 0xF43F5E,
    ]

    /// The colour of a person's avatar.
    public static func avatar(_ name: String) -> Color {
        color(avatars[Int(hash(name) % UInt64(avatars.count))])
    }

    /// The colour of a label or tag without one of its own.
    public static func label(_ name: String) -> Color {
        color(labels[Int(hash(name) % UInt64(labels.count))])
    }

    /// The platform's string hash with JavaScript's number semantics: `<<`
    /// works on the value truncated to 32 bits, the rest on doubles, and the
    /// string is walked by UTF-16 index with `codePointAt`.
    static func hash(_ text: String) -> UInt64 {
        let units = Array(text.utf16)
        var hash = 0.0
        for index in units.indices {
            let shifted = Int32(truncatingIfNeeded: Int64(hash)) << 5
            hash = Double(codePoint(units, at: index)) + (Double(shifted) - hash)
        }
        return UInt64(abs(hash))
    }

    private static func codePoint(_ units: [UInt16], at index: Int) -> UInt32 {
        let unit = units[index]
        if UTF16.isLeadSurrogate(unit), index + 1 < units.count, UTF16.isTrailSurrogate(units[index + 1]) {
            return 0x10000 + ((UInt32(unit) - 0xD800) << 10) + (UInt32(units[index + 1]) - 0xDC00)
        }
        return UInt32(unit)
    }

    private static func color(_ rgb: UInt32) -> Color {
        Color(
            red: Double((rgb >> 16) & 0xFF) / 255,
            green: Double((rgb >> 8) & 0xFF) / 255,
            blue: Double(rgb & 0xFF) / 255
        )
    }
}
