// Borrow the exact 8-bit tier zenc would write as PNG. Match avifenc 1.4.2:
// -q 63 -d 10 --ignore-icc --ignore-exif --ignore-xmp --speed 2 --jobs 4.
// The normal grid encoder. RGB input also supports the libavif 1.0 API.
#include <avif/avif.h>
#include <stdint.h>
#include <stdio.h>

int site_avif_encode(const uint8_t *pixels, uint32_t width, uint32_t height, int gray, const char *path) {
    if (!pixels || !width || !height || width > UINT32_MAX / 3 || !path) return 1;
    avifImage *image = avifImageCreate(width, height, 10, gray ? AVIF_PIXEL_FORMAT_YUV400 : AVIF_PIXEL_FORMAT_YUV420);
    avifEncoder *encoder = avifEncoderCreate();
    avifRWData encoded = AVIF_DATA_EMPTY;
    if (!image || !encoder) {
        if (image) avifImageDestroy(image);
        if (encoder) avifEncoderDestroy(encoder);
        return 1;
    }
    image->colorPrimaries = AVIF_COLOR_PRIMARIES_SRGB;
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
