// Borrow the exact 8-bit tier zenc would write as PNG. Match avifenc 1.4.2:
// -q 63 -d 10 --yuv 444 --ignore-icc --ignore-exif --ignore-xmp --speed 2 --jobs 4.
// The normal grid encoder. RGB input also supports the libavif 1.0 API.
//
// COLOUR IS 4:4:4, since 2026-09-26, and the camera's own 4:2:2 is not an
// argument against it. 4:2:2 describes the 7728x5152 frame; a 600px tier is
// that frame's square reduced ~8.6x, so every tier pixel averages ~4 chroma
// samples across and ~9 down and the tier carries full chroma at its own
// size. 4:2:0 then halves real information both ways: with no compression at
// all, the subsample-and-restore round trip scores 93.1-93.5 ssimulacra2 on
// the three tiers against 96.3 on a native-resolution crop. At the SAME bytes
// (each arm bracketed between adjacent -q steps), 4:4:4 beat the shipped
// 4:2:0 by +0.45 / +0.52 / +0.59 s2 on the 600 / 400 / 200 tiers over 24
// photos, butteraugli agreeing (-0.03 to -0.08), and 4:2:0 needed a median
// 2.2% more bytes to match it (0 on 6 photos, 35% on a red-lit night frame,
// XT508316). 4:2:2 moved nothing. tools/photos/avif-chroma-probe.ts is the
// measurement and re-runs it.
//
// Quality stays 63 by owner call, which is NOT byte-neutral at 4:4:4: the
// library's colour tiers grew +5.6% / +6.5% / +7.0% for +1.3 to +1.7 s2. The
// byte-flat choice would be 62 (+0.4% to +1.7%, +0.5 to +1.0 s2).
#include <avif/avif.h>
#include <stdint.h>
#include <stdio.h>

int site_avif_encode(const uint8_t *pixels, uint32_t width, uint32_t height, int gray, const char *path) {
    if (!pixels || !width || !height || width > UINT32_MAX / 3 || !path) return 1;
    avifImage *image = avifImageCreate(width, height, 10, gray ? AVIF_PIXEL_FORMAT_YUV400 : AVIF_PIXEL_FORMAT_YUV444);
    avifEncoder *encoder = avifEncoderCreate();
    avifRWData encoded = AVIF_DATA_EMPTY;
    if (!image || !encoder) {
        if (image) avifImageDestroy(image);
        if (encoder) avifEncoderDestroy(encoder);
        return 1;
    }
    // sRGB shares BT.709 primaries; this name also exists in libavif 1.0.
    image->colorPrimaries = AVIF_COLOR_PRIMARIES_BT709;
    image->transferCharacteristics = AVIF_TRANSFER_CHARACTERISTICS_SRGB;
    image->matrixCoefficients = AVIF_MATRIX_COEFFICIENTS_BT601;
    image->yuvRange = AVIF_RANGE_FULL;
    avifRGBImage rgb;
    avifRGBImageSetDefaults(&rgb, image);
    rgb.depth = 8;
    rgb.format = AVIF_RGB_FORMAT_RGB;
    rgb.pixels = (uint8_t *)pixels;
    rgb.rowBytes = width * 3;
    encoder->quality = 63;
    encoder->qualityAlpha = 63;
    encoder->speed = 2;
    encoder->maxThreads = 4;
    encoder->autoTiling = AVIF_TRUE;
    avifResult result = avifImageRGBToYUV(image, &rgb);
    if (result == AVIF_RESULT_OK) result = avifEncoderWrite(encoder, image, &encoded);
    int failed = result != AVIF_RESULT_OK;
    if (failed) fprintf(stderr, "libavif: %s\n", avifResultToString(result));
    if (!failed) {
        FILE *out = fopen(path, "wb");
        if (!out) failed = 1;
        else {
            failed = fwrite(encoded.data, 1, encoded.size, out) != encoded.size;
            if (fclose(out)) failed = 1;
        }
    }
    avifRWDataFree(&encoded);
    avifEncoderDestroy(encoder);
    avifImageDestroy(image);
    return failed;
}

void site_avif_version(char *out, size_t size) {
    char codecs[256];
    avifCodecVersions(codecs);
    snprintf(out, size, "libavif %s (%s)", avifVersion(), codecs);
}
