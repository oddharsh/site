// Experimental macOS decoder. Ownership: open retains image/ICC; close releases
// both. Decode borrows Rust's buffers and never retains them. No EXIF transform:
// production pixels::orient applies the caller's orientation exactly once.
#include <ImageIO/ImageIO.h>
#include <CoreGraphics/CoreGraphics.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

struct site_heif { CGImageRef image; CFDataRef icc; };

void site_heif_close(struct site_heif *h) {
    if (!h) return;
    if (h->icc) CFRelease(h->icc);
    if (h->image) CGImageRelease(h->image);
    free(h);
}

struct site_heif *site_heif_open(const char *path, uint32_t *width, uint32_t *height, size_t *icc_len) {
    CFURLRef url = CFURLCreateFromFileSystemRepresentation(NULL, (const UInt8 *)path, strlen(path), false);
    if (!url) return NULL;
    CGImageSourceRef source = CGImageSourceCreateWithURL(url, NULL);
    CFRelease(url);
    if (!source) return NULL;
    // This experiment is scoped to the camera's HEIF originals. Other formats
    // keep using the existing image crate; this is not a general decoder swap.
    CFStringRef type = CGImageSourceGetType(source);
    if (!type || (!CFEqual(type, CFSTR("public.heic")) && !CFEqual(type, CFSTR("public.heif")))) {
        CFRelease(source); return NULL;
    }
    const void *keys[] = {kCGImageSourceShouldCacheImmediately, kCGImageSourceShouldAllowFloat};
    const void *values[] = {kCFBooleanTrue, kCFBooleanFalse};
    CFDictionaryRef options = CFDictionaryCreate(NULL, keys, values, 2, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    CGImageRef image = CGImageSourceCreateImageAtIndex(source, 0, options);
    CFRelease(options); CFRelease(source);
    if (!image) return NULL;
    size_t w = CGImageGetWidth(image), h = CGImageGetHeight(image);
    CGColorSpaceRef space = CGImageGetColorSpace(image);
    if (!w || !h || w > UINT32_MAX || h > UINT32_MAX || w > SIZE_MAX / 8 / h ||
        !space || CGColorSpaceGetModel(space) != kCGColorSpaceModelRGB ||
        CGImageGetBitsPerComponent(image) > 16 || CGImageGetBitmapInfo(image) & kCGBitmapFloatComponents) {
        CGImageRelease(image); return NULL;
    }
    struct site_heif *result = calloc(1, sizeof(*result));
    if (!result) { CGImageRelease(image); return NULL; }
    result->image = image;
    result->icc = CGColorSpaceCopyICCData(space);
    if (!result->icc) { site_heif_close(result); return NULL; }
    *width = (uint32_t)w; *height = (uint32_t)h;
    *icc_len = (size_t)CFDataGetLength(result->icc);
    return result;
}

int site_heif_decode(struct site_heif *h, uint16_t *rgba, size_t samples, uint8_t *icc, size_t icc_len) {
    size_t w = CGImageGetWidth(h->image), height = CGImageGetHeight(h->image);
    if (samples != w * height * 4 || icc_len != (size_t)CFDataGetLength(h->icc)) return 1;
    // Same color space: expand into 16-bit integers without quantizing to 8-bit
    // or introducing a profile conversion. The parity probe compares with sips.
    CGContextRef context = CGBitmapContextCreate(rgba, w, height, 16, w * 8,
        CGImageGetColorSpace(h->image), kCGImageAlphaPremultipliedLast | kCGImageByteOrder16Little);
    if (!context) return 1;
    CGContextSetBlendMode(context, kCGBlendModeCopy);
    CGContextDrawImage(context, CGRectMake(0, 0, w, height), h->image);
    CGContextRelease(context);
    memcpy(icc, CFDataGetBytePtr(h->icc), icc_len);
    return 0;
}
