//
//  build-icons.swift
//  Regenerates every icon in the project from scripts/logo-source.png:
//    1. flood-fills the white background away (interior whites — the JSON
//       sheet, the compass ring — are protected by connectivity),
//    2. unmixes the anti-aliased edge pixels against the white backdrop,
//    3. crops to the artwork bounding box,
//    4. renders extension icons (tight) and macOS app icons (7% padding).
//
//  Run: npm run icons   (a plain `swift scripts/build-icons.swift`)
//
import Foundation
import CoreGraphics
import ImageIO

let scriptDir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let projectRoot = scriptDir.deletingLastPathComponent()
let sourcePath = scriptDir.appendingPathComponent("logo-source.png").path
let extIconDir = projectRoot.appendingPathComponent("extension/icons").path
let appIconDir = projectRoot.appendingPathComponent(
  "xcode/JSON Viewer/JSON Viewer/Assets.xcassets/AppIcon.appiconset").path

func fail(_ msg: String) -> Never {
  FileHandle.standardError.write(("ERROR: " + msg + "\n").data(using: .utf8)!)
  exit(1)
}

/* ------------------------------------------------------------------ load */

func loadRGBA(_ path: String) -> (pixels: [UInt8], w: Int, h: Int)? {
  guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
        let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { return nil }
  let w = img.width, h = img.height
  var pixels = [UInt8](repeating: 0, count: w * h * 4)   // transparent: source-over keeps the source intact
  let cs = CGColorSpace(name: CGColorSpace.sRGB)!
  let ok: Bool = pixels.withUnsafeMutableBytes { buf in
    guard let ctx = CGContext(data: buf.baseAddress, width: w, height: h,
                              bitsPerComponent: 8, bytesPerRow: w * 4, space: cs,
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { return false }
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
    return true
  }
  return ok ? (pixels, w, h) : nil
}

/* ---------------------------------------------------------------- cutout */

func cutout(pixels: inout [UInt8], w: Int, h: Int) -> Int {
  let n = w * h
  var isBg = [Bool](repeating: false, count: n)

  func looksLikeBackground(_ i: Int) -> Bool {
    let o = i * 4
    let r = Int(pixels[o]), g = Int(pixels[o + 1]), b = Int(pixels[o + 2])
    let mn = min(r, g, b), mx = max(r, g, b)
    return mn >= 200 && (mx - mn) <= 40   // white / neutral light background
  }

  var stack: [Int] = []
  func seed(_ x: Int, _ y: Int) {
    let i = y * w + x
    if !isBg[i] && looksLikeBackground(i) { isBg[i] = true; stack.append(i) }
  }
  for x in 0..<w { seed(x, 0); seed(x, h - 1) }
  for y in 0..<h { seed(0, y); seed(w - 1, y) }
  while let i = stack.popLast() {
    let x = i % w, y = i / w
    if x > 0 { seed(x - 1, y) }
    if x + 1 < w { seed(x + 1, y) }
    if y > 0 { seed(x, y - 1) }
    if y + 1 < h { seed(x, y + 1) }
  }

  // Anti-aliased edge pixels: unmix against the white backdrop.
  // C = a*F + (1-a)*white  =>  alpha = 255 - min(C), premultiplied = C - min(C)
  var edgeFixed = 0
  for i in 0..<n {
    if isBg[i] {
      // premultiplied invariant: alpha 0 must come with black RGB
      pixels[i * 4] = 0
      pixels[i * 4 + 1] = 0
      pixels[i * 4 + 2] = 0
      pixels[i * 4 + 3] = 0
      continue
    }

    let x = i % w, y = i / w
    var touchesBg = false
    scan: for dy in -1...1 {
      for dx in -1...1 {
        if dx == 0 && dy == 0 { continue }
        let nx = x + dx, ny = y + dy
        if nx >= 0 && nx < w && ny >= 0 && ny < h && isBg[ny * w + nx] {
          touchesBg = true
          break scan
        }
      }
    }
    if !touchesBg { continue }

    let o = i * 4
    let r = Int(pixels[o]), g = Int(pixels[o + 1]), b = Int(pixels[o + 2])
    let mn = min(r, g, b)
    if mn <= 120 { continue }   // saturated edge: keep fully opaque

    pixels[o]     = UInt8(max(0, r - mn))
    pixels[o + 1] = UInt8(max(0, g - mn))
    pixels[o + 2] = UInt8(max(0, b - mn))
    pixels[o + 3] = UInt8(255 - mn)
    edgeFixed += 1
  }
  return edgeFixed
}

func alphaBBox(pixels: [UInt8], w: Int, h: Int) -> (x: Int, y: Int, w: Int, h: Int)? {
  var minX = w, minY = h, maxX = -1, maxY = -1
  for y in 0..<h {
    for x in 0..<w where pixels[(y * w + x) * 4 + 3] > 0 {
      minX = min(minX, x); maxX = max(maxX, x)
      minY = min(minY, y); maxY = max(maxY, y)
    }
  }
  guard maxX >= minX && maxY >= minY else { return nil }
  return (minX, minY, maxX - minX + 1, maxY - minY + 1)
}

func makeImage(pixels: inout [UInt8], w: Int, h: Int) -> CGImage? {
  let cs = CGColorSpace(name: CGColorSpace.sRGB)!
  var out: CGImage?
  pixels.withUnsafeMutableBytes { buf in
    guard let ctx = CGContext(data: buf.baseAddress, width: w, height: h,
                              bitsPerComponent: 8, bytesPerRow: w * 4, space: cs,
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { return }
    out = ctx.makeImage()
  }
  return out
}

/* --------------------------------------------------------------- renders */

func resized(_ img: CGImage, to size: Int, padding: Double) -> CGImage? {
  let cs = CGColorSpace(name: CGColorSpace.sRGB)!
  var out: CGImage?
  var buf = [UInt8](repeating: 0, count: size * size * 4)
  buf.withUnsafeMutableBytes { b in
    guard let ctx = CGContext(data: b.baseAddress, width: size, height: size,
                              bitsPerComponent: 8, bytesPerRow: size * 4, space: cs,
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { return }
    ctx.interpolationQuality = .high
    ctx.clear(CGRect(x: 0, y: 0, width: size, height: size))
    let inset = Double(size) * padding
    let rect = CGRect(x: inset, y: inset,
                      width: Double(size) - inset * 2, height: Double(size) - inset * 2)
    ctx.draw(img, in: rect)
    out = ctx.makeImage()
  }
  return out
}

func alphaStats(_ img: CGImage) -> String {
  let w = img.width, h = img.height
  var p = [UInt8](repeating: 0, count: w * h * 4)
  p.withUnsafeMutableBytes { b in
    guard let ctx = CGContext(data: b.baseAddress, width: w, height: h, bitsPerComponent: 8,
                              bytesPerRow: w * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return }
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
  }
  var zero = 0
  for i in 0..<(w * h) where p[i * 4 + 3] == 0 { zero += 1 }
  let o = ((h - 1) * w) * 4
  return "\(zero)/\(w * h) transparent, BL=(\(p[o]),\(p[o+1]),\(p[o+2]),a=\(p[o+3]))"
}

func writePNG(_ img: CGImage, to path: String) -> Bool {
  let url = URL(fileURLWithPath: path) as CFURL
  guard let dest = CGImageDestinationCreateWithURL(url, "public.png" as CFString, 1, nil)
  else { return false }
  CGImageDestinationAddImage(dest, img, nil)
  return CGImageDestinationFinalize(dest)
}

/* ------------------------------------------------------------------- main */

guard let loaded = loadRGBA(sourcePath) else { fail("cannot load \(sourcePath)") }
var pixels = loaded.pixels
let w = loaded.w, h = loaded.h
let fixed = cutout(pixels: &pixels, w: w, h: h)
guard let box = alphaBBox(pixels: pixels, w: w, h: h) else { fail("image is empty after cutout") }
guard var cropped = makeImage(pixels: &pixels, w: w, h: h)?
  .cropping(to: CGRect(x: box.x, y: box.y, width: box.w, height: box.h))
else { fail("cannot crop") }

print("source \(w)x\(h) -> artwork \(box.w)x\(box.h) at (\(box.x),\(box.y)); \(fixed) edge pixels unmixed")

try? FileManager.default.createDirectory(atPath: extIconDir, withIntermediateDirectories: true)

let extSizes = [16, 32, 48, 64, 128, 256]
for size in extSizes {
  guard let img = resized(cropped, to: size, padding: 0),
        writePNG(img, to: "\(extIconDir)/icon-\(size).png") else { fail("icon-\(size).png") }
  print("  extension/icons/icon-\(size).png")
}

let appTargets: [(String, Int)] = [
  ("mac-icon-16@1x.png", 16),  ("mac-icon-16@2x.png", 32),
  ("mac-icon-32@1x.png", 32),  ("mac-icon-32@2x.png", 64),
  ("mac-icon-128@1x.png", 128), ("mac-icon-128@2x.png", 256),
  ("mac-icon-256@1x.png", 256), ("mac-icon-256@2x.png", 512),
  ("mac-icon-512@1x.png", 512), ("mac-icon-512@2x.png", 1024)
]
for (name, size) in appTargets {
  guard let img = resized(cropped, to: size, padding: 0.07),
        writePNG(img, to: "\(appIconDir)/\(name)") else { fail(name) }
  print("  AppIcon/\(name)")
}

// The containing app's welcome window (Base.lproj/Main.html) shows this one.
let welcomeIcon = projectRoot.appendingPathComponent(
  "xcode/JSON Viewer/JSON Viewer/Resources/Icon.png").path
if let img = resized(cropped, to: 128, padding: 0.07), writePNG(img, to: welcomeIcon) {
  print("  Resources/Icon.png")
} else {
  fail("Resources/Icon.png")
}
// Transparency guard: the rounded corners must stay see-through, otherwise
// every icon would carry a white box on dark backgrounds.
guard let check = loadRGBA("\(extIconDir)/icon-256.png") else { fail("re-read icon-256.png") }
let last = (check.h - 1) * check.w * 4
guard check.pixels[last + 3] == 0 else {
  fail("icon-256.png lost transparency (corner alpha = \(check.pixels[last + 3]))")
}
print("transparency verified (corner alpha = 0)")
print("done")
