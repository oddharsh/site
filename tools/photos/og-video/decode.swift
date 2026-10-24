// decode.swift: write chosen frames of a clip back out as PNGs, for scoring
// against the source frames with ssimulacra2.
//
//   swift decode.swift mp4 <clip.mp4> <out-dir> <i,j,k,...>    AVFoundation (H.264, HEVC)
//   swift decode.swift y4m <clip.y4m> <out-dir> <i,j,k,...>    aomdec's output (AV1)
//
// Both paths convert with BT.709 limited range, the matrix the encoders tagged.
import AVFoundation
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let args = CommandLine.arguments
let mode = args[1], input = URL(fileURLWithPath: args[2]), outDir = URL(fileURLWithPath: args[3])
let want = Set(args[4].split(separator: ",").compactMap { Int($0) })
try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
let space = CGColorSpace(name: CGColorSpace.sRGB)!

func writePNG(_ rgba: [UInt8], _ w: Int, _ h: Int, _ i: Int) {
  var px = rgba
  let ctx = CGContext(
    data: &px, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: space,
    bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
  let img = ctx.makeImage()!
  let url = outDir.appendingPathComponent(String(format: "f%04d.png", i))
  let dst = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
  CGImageDestinationAddImage(dst, img, nil)
  CGImageDestinationFinalize(dst)
}

func clamp(_ x: Double) -> UInt8 { UInt8(max(0, min(255, x.rounded()))) }
func yuvToRGBA(y: (Int, Int) -> Double, u: (Int, Int) -> Double, v: (Int, Int) -> Double, _ w: Int, _ h: Int) -> [UInt8] {
  var out = [UInt8](repeating: 255, count: w * h * 4)
  for j in 0..<h {
    for i in 0..<w {
      let Y = (y(i, j) - 16) * 255 / 219, U = (u(i / 2, j / 2) - 128) * 255 / 224, V = (v(i / 2, j / 2) - 128) * 255 / 224
      let o = (j * w + i) * 4
      out[o] = clamp(Y + 1.5748 * V)
      out[o + 1] = clamp(Y - 0.1873 * U - 0.4681 * V)
      out[o + 2] = clamp(Y + 1.8556 * U)
    }
  }
  return out
}

if mode == "mp4" {
  let asset = AVURLAsset(url: input)
  let track = asset.tracks(withMediaType: .video)[0]
  let reader = try AVAssetReader(asset: asset)
  // Ask for the decoder's own 4:2:0 planes and convert here, so CoreVideo's
  // RGB conversion (and whatever matrix it assumes) is not part of the score.
  let out = AVAssetReaderTrackOutput(
    track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange])
  reader.add(out)
  reader.startReading()
  var i = 0
  while let sb = out.copyNextSampleBuffer() {
    defer { i += 1 }
    guard want.contains(i), let pb = CMSampleBufferGetImageBuffer(sb) else { continue }
    CVPixelBufferLockBaseAddress(pb, .readOnly)
    let w = CVPixelBufferGetWidth(pb), h = CVPixelBufferGetHeight(pb)
    let yp = CVPixelBufferGetBaseAddressOfPlane(pb, 0)!.assumingMemoryBound(to: UInt8.self)
    let cp = CVPixelBufferGetBaseAddressOfPlane(pb, 1)!.assumingMemoryBound(to: UInt8.self)
    let ys = CVPixelBufferGetBytesPerRowOfPlane(pb, 0), cs = CVPixelBufferGetBytesPerRowOfPlane(pb, 1)
    let rgba = yuvToRGBA(
      y: { Double(yp[$1 * ys + $0]) }, u: { Double(cp[$1 * cs + $0 * 2]) }, v: { Double(cp[$1 * cs + $0 * 2 + 1]) }, w, h)
    CVPixelBufferUnlockBaseAddress(pb, .readOnly)
    writePNG(rgba, w, h, i)
  }
} else {
  let data = try Data(contentsOf: input)
  let bytes = [UInt8](data)
  let nl = bytes.firstIndex(of: 10)!
  let header = String(decoding: bytes[0..<nl], as: UTF8.self)
  var w = 0, h = 0
  for tok in header.split(separator: " ") {
    if tok.hasPrefix("W") { w = Int(tok.dropFirst())! }
    if tok.hasPrefix("H") { h = Int(tok.dropFirst())! }
  }
  let frameLen = w * h * 3 / 2
  var p = nl + 1, i = 0
  while p < bytes.count {
    p = bytes[p...].firstIndex(of: 10)! + 1  // skip "FRAME...\n"
    if want.contains(i) {
      let base = p, cw = w / 2
      let rgba = yuvToRGBA(
        y: { Double(bytes[base + $1 * w + $0]) },
        u: { Double(bytes[base + w * h + $1 * cw + $0]) },
        v: { Double(bytes[base + w * h + (w / 2) * (h / 2) + $1 * cw + $0]) }, w, h)
      writePNG(rgba, w, h, i)
    }
    p += frameLen
    i += 1
  }
}
