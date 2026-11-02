// y4m.swift: PNG frames to a 4:2:0 8-bit Y4M on stdout, BT.709 limited range,
// so aomenc gets the same frames the VideoToolbox encodes do.
//
//   swift y4m.swift <frames-dir> <fps> > clip.y4m
import CoreGraphics
import Foundation
import ImageIO

let args = CommandLine.arguments
let dir = URL(fileURLWithPath: args[1])
let fps = args[2]
let frames = try FileManager.default.contentsOfDirectory(atPath: dir.path)
  .filter { $0.hasSuffix(".png") }.sorted().map { dir.appendingPathComponent($0) }
let out = FileHandle.standardOutput
var header = false
let space = CGColorSpace(name: CGColorSpace.sRGB)!

for url in frames {
  let src = CGImageSourceCreateWithURL(url as CFURL, nil)!
  let img = CGImageSourceCreateImageAtIndex(src, 0, nil)!
  let w = img.width, h = img.height
  if !header {
    out.write("YUV4MPEG2 W\(w) H\(h) F\(fps):1 Ip A1:1 C420jpeg XCOLORRANGE=LIMITED\n".data(using: .utf8)!)
    header = true
  }
  var rgba = [UInt8](repeating: 0, count: w * h * 4)
  let ctx = CGContext(
    data: &rgba, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: space,
    bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
  ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
  var y = [UInt8](repeating: 0, count: w * h)
  var u = [UInt8](repeating: 0, count: (w / 2) * (h / 2))
  var v = u
  func clamp(_ x: Double) -> UInt8 { UInt8(max(0, min(255, x.rounded()))) }
  for j in 0..<h {
    for i in 0..<w {
      let o = (j * w + i) * 4
      let r = Double(rgba[o]), g = Double(rgba[o + 1]), b = Double(rgba[o + 2])
      y[j * w + i] = clamp(16 + (0.2126 * r + 0.7152 * g + 0.0722 * b) * 219 / 255)
    }
  }
  // Chroma from the 2x2 average (center-sited, which is what C420jpeg declares).
  for j in 0..<(h / 2) {
    for i in 0..<(w / 2) {
      var r = 0.0, g = 0.0, b = 0.0
      for (dx, dy) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
        let o = ((j * 2 + dy) * w + i * 2 + dx) * 4
        r += Double(rgba[o]); g += Double(rgba[o + 1]); b += Double(rgba[o + 2])
      }
      r /= 4; g /= 4; b /= 4
      u[j * (w / 2) + i] = clamp(128 + (-0.1146 * r - 0.3854 * g + 0.5 * b) * 224 / 255)
      v[j * (w / 2) + i] = clamp(128 + (0.5 * r - 0.4542 * g - 0.0458 * b) * 224 / 255)
    }
  }
  out.write("FRAME\n".data(using: .utf8)!)
  out.write(Data(y)); out.write(Data(u)); out.write(Data(v))
}
