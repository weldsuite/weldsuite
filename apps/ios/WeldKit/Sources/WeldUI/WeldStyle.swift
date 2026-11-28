import CoreText
import SwiftUI
import UIKit

// The web platform's look on iOS: Inter, its primary colour as the tint, and
// `rounded-md` buttons. `SessionGate` applies it to every app, so a screen
// only picks fonts with `.inter(...)` and colours from `Tokens.Palette`.

/// Inter, the web platform's typeface, bundled in WeldUI.
public enum WeldFonts {
    /// The four weights the apps use, by PostScript name.
    static let faces: [Font.Weight: String] = [
        .regular: "Inter-Regular",
        .medium: "Inter-Medium",
        .semibold: "Inter-SemiBold",
        .bold: "Inter-Bold",
    ]

    /// Registers the fonts with the process, once.
    public static func register() { _ = registered }

    private static let registered: Void = {
        for name in WeldFonts.faces.values {
            guard let file = WeldFonts.url(name) else { continue }
            CTFontManagerRegisterFontsForURL(file as CFURL, .process, nil)
        }
    }()

    /// Where a face sits in WeldUI's bundle.
    static func url(_ name: String) -> URL? {
        Bundle.module.url(forResource: name, withExtension: "ttf")
    }

    /// The bundled face closest to `weight`.
    static func face(_ weight: Font.Weight) -> String {
        switch weight {
        case .ultraLight, .thin, .light, .regular: faces[.regular]!
        case .medium: faces[.medium]!
        case .semibold: faces[.semibold]!
        default: faces[.bold]!
        }
    }

    /// The point size and weight iOS gives a text style at the default
    /// Dynamic Type size; Inter scales from there with the person's setting.
    static func metrics(_ style: Font.TextStyle) -> (size: CGFloat, weight: Font.Weight) {
        switch style {
        case .largeTitle: (34, .bold)
        case .title: (28, .bold)
        case .title2: (22, .bold)
        case .title3: (20, .semibold)
        case .headline: (17, .semibold)
        case .callout: (16, .regular)
        case .subheadline: (15, .regular)
        case .footnote: (13, .regular)
        case .caption: (12, .regular)
        case .caption2: (11, .regular)
        default: (17, .regular)
        }
    }

    static func uiFont(_ weight: Font.Weight, size: CGFloat, style: UIFont.TextStyle) -> UIFont {
        let font = UIFont(name: face(weight), size: size) ?? .systemFont(ofSize: size)
        return UIFontMetrics(forTextStyle: style).scaledFont(for: font)
    }
}

extension Font {
    /// Inter at the size of a Dynamic Type style, scaling with it. Headlines
    /// and titles keep their weight unless `weight` says otherwise.
    public static func inter(_ style: Font.TextStyle, weight: Font.Weight? = nil) -> Font {
        let metrics = WeldFonts.metrics(style)
        return .custom(WeldFonts.face(weight ?? metrics.weight), size: metrics.size, relativeTo: style)
    }

    /// Inter at a fixed size, for the few places that don't follow a text style.
    public static func inter(size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .custom(WeldFonts.face(weight), size: size)
    }
}

/// Applies the platform's look below a view: Inter, the tint, button shapes,
/// and Inter in the navigation and tab bars UIKit draws.
struct WeldStyle: ViewModifier {
    init() {
        WeldFonts.register()
        WeldStyle.applyBarAppearance()
    }

    func body(content: Content) -> some View {
        content
            .font(.inter(.body))
            .tint(Tokens.Palette.primary)
            .buttonBorderShape(.roundedRectangle(radius: Tokens.Radius.medium))
    }

    private static let barsStyled: Void = {
        let title: [NSAttributedString.Key: Any] = [.font: WeldFonts.uiFont(.semibold, size: 17, style: .headline)]
        let largeTitle: [NSAttributedString.Key: Any] = [.font: WeldFonts.uiFont(.bold, size: 34, style: .largeTitle)]

        let standard = UINavigationBarAppearance()
        standard.configureWithDefaultBackground()
        standard.titleTextAttributes = title
        standard.largeTitleTextAttributes = largeTitle
        let edge = UINavigationBarAppearance()
        edge.configureWithTransparentBackground()
        edge.titleTextAttributes = title
        edge.largeTitleTextAttributes = largeTitle
        let bar = UINavigationBar.appearance()
        bar.standardAppearance = standard
        bar.compactAppearance = standard
        bar.scrollEdgeAppearance = edge

        let barButton: [NSAttributedString.Key: Any] = [.font: WeldFonts.uiFont(.regular, size: 17, style: .body)]
        UIBarButtonItem.appearance().setTitleTextAttributes(barButton, for: .normal)
        UIBarButtonItem.appearance().setTitleTextAttributes(barButton, for: .highlighted)

        let tabLabel: [NSAttributedString.Key: Any] = [.font: WeldFonts.uiFont(.medium, size: 10, style: .caption2)]
        UITabBarItem.appearance().setTitleTextAttributes(tabLabel, for: .normal)
        UITabBarItem.appearance().setTitleTextAttributes(tabLabel, for: .selected)

        let segment: [NSAttributedString.Key: Any] = [.font: WeldFonts.uiFont(.medium, size: 13, style: .footnote)]
        UISegmentedControl.appearance().setTitleTextAttributes(segment, for: .normal)
    }()

    static func applyBarAppearance() { _ = barsStyled }
}

extension View {
    /// The web platform's look: Inter, its primary colour, `rounded-md` buttons.
    public func weldStyle() -> some View {
        modifier(WeldStyle())
    }
}
