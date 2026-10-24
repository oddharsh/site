// encode.swift: PNG frames to an MP4 through Apple's own encoders (VideoToolbox),
// the same stack that decodes the clip in an iMessage bubble.
//
//   swift encode.swift <frames-dir> <out.mp4> <h264|hevc> <fps> <quality 0..1>
//
// Frames are read in name order (f0000.png, f0001.png, ...). HEVC is tagged
// hvc1, which is the only HEVC tag AVFoundation will play from an MP4.
import AVFoundation
import CoreGraphics
import Foundation
import ImageIO

let args = CommandLine.arguments
guard args.count == 6, let fps = Int32(args[4]), let quality = Double(args[5]) else {
  FileHandle.standardError.write("usage: encode.swift <frames-dir> <out.mp4> <h264|hevc> <fps> <quality>\n".data(using: .utf8)!)
  exit(2)
}
let dir = URL(fileURLWithPath: args[1])
let out = URL(fileURLWithPath: args[2])
let codec: AVVideoCodecType = args[3] == "hevc" ? .hevc : .h264

let frames = try FileManager.default.contentsOfDirectory(atPath: dir.path)
  .filter { $0.hasSuffix(".png") }.sorted()
  .map { dir.appendingPathComponent($0) }
guard let first = frames.first,
  let src0 = CGImageSourceCreateWithURL(first as CFURL, nil),
  let img0 = CGImageSourceCreateImageAtIndex(src0, 0, nil)
else { fatalError("no frames in \(dir.path)") }
let w = img0.width, h = img0.height

try? FileManager.default.removeItem(at: out)
let writer = try AVAssetWriter(outputURL: out, fileType: .mp4)
// moov before mdat, so a fetcher can start decoding before the last byte lands
writer.shouldOptimizeForNetworkUse = true
var compression: [String: Any] = [
  AVVideoQualityKey: quality,
  AVVideoExpectedSourceFrameRateKey: fps,
  AVVideoMaxKeyFrameIntervalKey: Int(fps) * 10,
  AVVideoAllowFrameReorderingKey: true,
]
if codec == .h264 { compression[AVVideoProfileLevelKey] = AVVideoProfileLevelH264HighAutoLevel }
let input = AVAssetWriterInput(
  mediaType: .video,
  outputSettings: [
    AVVideoCodecKey: codec,
    AVVideoWidthKey: w,
    AVVideoHeightKey: h,
    AVVideoCompressionPropertiesKey: compression,
    AVVideoColorPropertiesKey: [
      AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
      AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
      AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
    ],
  ])
input.expectsMediaDataInRealTime = false
// The adaptor takes 4:2:0 planes this file converts itself, with the same
// BT.709 limited-range math as y4m.swift. Handing VideoToolbox BGRA let it
// pick its own conversion, and that capped every H.264 and HEVC score at
// the same 77.5 on the masonry clip whatever the bitrate (measured): the
// ceiling was the conversion, not the codec, and AV1 never paid it.
let adaptor = AVAssetWriterInputPixelBufferAdaptor(
  assetWriterInput: input,
  sourcePixelBufferAttributes: [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
    kCVPixelBufferWidthKey as String: w,
    kCVPixelBufferHeightKey as String: h,
  ])
writer.add(input)
writer.startWriting()
writer.startSession(atSourceTime: .zero)

let space = CGColorSpace(name: CGColorSpace.sRGB)!
func clamp(_ x: Double) -> UInt8 { UInt8(max(0, min(255, x.rounded()))) }
for (i, url) in frames.enumerated() {
  guard let s = CGImageSourceCreateWithURL(url as CFURL, nil),
    let img = CGImageSourceCreateImageAtIndex(s, 0, nil)
  else { fatalError("unreadable frame \(url.lastPathComponent)") }
  var rgba = [UInt8](repeating: 0, count: w * h * 4)
  let ctx = CGContext(
    data: &rgba, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: space,
    bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
  ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
  while !input.isReadyForMoreMediaData { usleep(2000) }
  var pb: CVPixelBuffer?
  CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &pb)
  guard let buf = pb else { fatalError("no pixel buffer") }
  CVPixelBufferLockBaseAddress(buf, [])
  let yp = CVPixelBufferGetBaseAddressOfPlane(buf, 0)!.assumingMemoryBound(to: UInt8.self)
  let cp = CVPixelBufferGetBaseAddressOfPlane(buf, 1)!.assumingMemoryBound(to: UInt8.self)
  let ys = CVPixelBufferGetBytesPerRowOfPlane(buf, 0), cs = CVPixelBufferGetBytesPerRowOfPlane(buf, 1)
  for j in 0..<h {
    for x in 0..<w {
      let o = (j * w + x) * 4
      let r = Double(rgba[o]), g = Double(rgba[o + 1]), b = Double(rgba[o + 2])
      yp[j * ys + x] = clamp(16 + (0.2126 * r + 0.7152 * g + 0.0722 * b) * 219 / 255)
    }
  }
  for j in 0..<(h / 2) {
    for x in 0..<(w / 2) {
      var r = 0.0, g = 0.0, b = 0.0
      for (dx, dy) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
        let o = ((j * 2 + dy) * w + x * 2 + dx) * 4
        r += Double(rgba[o]); g += Double(rgba[o + 1]); b += Double(rgba[o + 2])
      }
      r /= 4; g /= 4; b /= 4
      cp[j * cs + x * 2] = clamp(128 + (-0.1146 * r - 0.3854 * g + 0.5 * b) * 224 / 255)
      cp[j * cs + x * 2 + 1] = clamp(128 + (0.5 * r - 0.4542 * g - 0.0458 * b) * 224 / 255)
    }
  }
  CVPixelBufferUnlockBaseAddress(buf, [])
  adaptor.append(buf, withPresentationTime: CMTime(value: CMTimeValue(i), timescale: fps))
}
input.markAsFinished()
let done = DispatchSemaphore(value: 0)
writer.finishWriting { done.signal() }
done.wait()
if writer.status != .completed { fatalError("writer failed: \(String(describing: writer.error))") }
let bytes = (try FileManager.default.attributesOfItem(atPath: out.path)[.size] as? Int) ?? 0
print("\(out.lastPathComponent)  \(frames.count) frames  \(w)x\(h)  \(bytes) B")
