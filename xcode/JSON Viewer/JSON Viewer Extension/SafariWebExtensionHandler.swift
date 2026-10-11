//
//  SafariWebExtensionHandler.swift
//  JSON Viewer Extension
//
//  Native side of the extension. The only request it serves today is the font
//  picker: JavaScript asks for every installed monospace font family, which is
//  enumerated here through CoreText — no hardcoded list in the web layer.
//

import SafariServices
import CoreText
import Foundation
import os.log

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem

        let profile: UUID?
        if #available(iOS 17.0, macOS 14.0, *) {
            profile = request?.userInfo?[SFExtensionProfileKey] as? UUID
        } else {
            profile = request?.userInfo?["profile"] as? UUID
        }

        let message: Any?
        if #available(iOS 15.0, macOS 11.0, *) {
            message = request?.userInfo?[SFExtensionMessageKey]
        } else {
            message = request?.userInfo?["message"]
        }

        os_log(.default, "Received message from browser.runtime.sendNativeMessage: %@ (profile: %@)",
               String(describing: message), profile?.uuidString ?? "none")

        var payload: [String: Any] = [:]
        if let body = message as? [String: Any], let action = body["action"] as? String {
            switch action {
            case "listMonospaceFonts":
                payload["fonts"] = SafariWebExtensionHandler.monospaceFontFamilies()
            default:
                payload["error"] = "unknown action: \(action)"
            }
        }

        let response = NSExtensionItem()
        if #available(iOS 15.0, macOS 11.0, *) {
            response.userInfo = [SFExtensionMessageKey: payload]
        } else {
            response.userInfo = ["message": payload]
        }
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }

    // MARK: - Font enumeration

    /// Every installed font family that renders monospaced, discovered through
    /// CoreText — nothing is hardcoded, so new fonts show up automatically.
    static func monospaceFontFamilies() -> [String] {
        guard let families = CTFontManagerCopyAvailableFontFamilyNames() as? [String] else {
            return []
        }

        var entries: [String] = []
        var seen = Set<String>()
        func add(_ name: String) {
            guard !name.isEmpty, !seen.contains(name) else { return }
            seen.insert(name)
            entries.append(name)
        }

        for family in families {
            // The face CSS font-family:"<family>" actually resolves to:
            if isMonospaced(CTFontCreateWithName(family as CFString, 12, nil)) {
                add(family)
                continue
            }
            // Otherwise offer the family's individual monospaced faces by
            // PostScript name (e.g. "Osaka-Mono" inside the "Osaka" family).
            let attributes: [CFString: Any] = [kCTFontFamilyNameAttribute: family]
            let descriptor = CTFontDescriptorCreateWithAttributes(attributes as CFDictionary)
            guard let faces = CTFontDescriptorCreateMatchingFontDescriptors(descriptor, nil) as? [CTFontDescriptor]
            else { continue }

            for face in faces {
                guard let postScript = CTFontDescriptorCopyAttribute(face, kCTFontNameAttribute) as? String
                else { continue }
                if isMonospaced(CTFontCreateWithName(postScript as CFString, 12, nil)) {
                    add(postScript)
                }
            }
        }

        return entries.sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
    }

    /// A face is monospaced when glyphs as different as "i", "m", "W", "A",
    /// "0" and "a" all share the same advance — a check narrow proportionate
    /// fonts (and dingbats like Wingdings 2) cannot slip through.
    private static func isMonospaced(_ font: CTFont) -> Bool {
        let sample = ["i", "m", "W", "A", "0", "a"]
        let widths = sample.map { advance(of: $0, in: font) }
        guard let first = widths.first, first > 0, widths.allSatisfy({ $0 > 0 }) else { return false }
        return widths.allSatisfy { abs($0 - first) < 0.05 }
    }

    private static func advance(of character: String, in font: CTFont) -> CGFloat {
        var utf16 = Array(character.utf16)
        var glyphs = [CGGlyph](repeating: 0, count: utf16.count)
        guard CTFontGetGlyphsForCharacters(font, &utf16, &glyphs, utf16.count) else { return -1 }

        var advances = [CGSize](repeating: .zero, count: glyphs.count)
        _ = CTFontGetAdvancesForGlyphs(font, .horizontal, &glyphs, &advances, glyphs.count)
        return advances.reduce(0) { $0 + $1.width }
    }
}
