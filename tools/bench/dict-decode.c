// Decode timing for dcb (brotli + raw dictionary) against dcz (zstd + raw
// dictionary), called straight through libbrotlidec and libzstd.
//
// Timing through node:zlib read 1.3x on 2026-11-26 where this reads 2.0x: the
// binding's buffer handling costs more than the decode it wraps (a 1-byte frame
// with the same dictionary costs 9.6 us for brotli and 29.3 us for zstd there),
// so decode has to be timed below the binding.
//
// Each call creates a fresh decoder, attaches the dictionary and rebuilds the
// file into a preallocated buffer, the way a browser handles one response.
// tools/measure-dict-encodings.ts compiles and runs it.
//
// usage: dict-decode <dir> <id>...  reads <dir>/<id>.{raw,dict,dcb,dcz}
// prints: id \t raw bytes \t dcb us \t dcz us

#include <brotli/decode.h>
#include <zstd.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

typedef struct {
  unsigned char *bytes;
  size_t size;
} Buffer;

static Buffer read_file(const char *dir, const char *id, const char *extension) {
  char path[4096];
  snprintf(path, sizeof path, "%s/%s.%s", dir, id, extension);
  FILE *file = fopen(path, "rb");
  if (!file) {
    perror(path);
    exit(1);
  }
  fseek(file, 0, SEEK_END);
  Buffer buffer = {0, (size_t)ftell(file)};
  fseek(file, 0, SEEK_SET);
  buffer.bytes = malloc(buffer.size ? buffer.size : 1);
  if (fread(buffer.bytes, 1, buffer.size, file) != buffer.size) {
    perror(path);
    exit(1);
  }
  fclose(file);
  return buffer;
}

static double now_us(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec * 1e6 + t.tv_nsec / 1e3;
}

static size_t decode_dcb(Buffer frame, Buffer dictionary, unsigned char *out, size_t capacity) {
  BrotliDecoderState *state = BrotliDecoderCreateInstance(0, 0, 0);
  if (!BrotliDecoderAttachDictionary(state, BROTLI_SHARED_DICTIONARY_RAW, dictionary.size, dictionary.bytes)) exit(2);
  size_t available_in = frame.size, available_out = capacity;
  const uint8_t *next_in = frame.bytes;
  uint8_t *next_out = out;
  BrotliDecoderResult result = BrotliDecoderDecompressStream(state, &available_in, &next_in, &available_out, &next_out, 0);
  BrotliDecoderDestroyInstance(state);
  if (result != BROTLI_DECODER_RESULT_SUCCESS) exit(3);
  return capacity - available_out;
}

static size_t decode_dcz(Buffer frame, Buffer dictionary, unsigned char *out, size_t capacity) {
  ZSTD_DCtx *context = ZSTD_createDCtx();
  size_t size = ZSTD_decompress_usingDict(context, out, capacity, frame.bytes, frame.size, dictionary.bytes, dictionary.size);
  ZSTD_freeDCtx(context);
  if (ZSTD_isError(size)) exit(4);
  return size;
}

typedef size_t (*Decoder)(Buffer, Buffer, unsigned char *, size_t);

// Median of 9 batches. Each batch repeats until it runs at least 2 ms, so the
// clock's granularity stays under 1% of what it measures.
static double time_us(Decoder decode, Buffer frame, Buffer dictionary, unsigned char *out, size_t capacity) {
  int repeats = 1;
  for (int doublings = 0;; doublings++) {
    if (doublings >= 30) exit(7);
    double start = now_us();
    for (int i = 0; i < repeats; i++) decode(frame, dictionary, out, capacity);
    if (now_us() - start >= 2000) break;
    repeats *= 2;
  }
  double samples[9];
  for (int b = 0; b < 9; b++) {
    double start = now_us();
    for (int i = 0; i < repeats; i++) decode(frame, dictionary, out, capacity);
    samples[b] = (now_us() - start) / repeats;
  }
  for (int i = 1; i < 9; i++) {
    for (int j = i; j > 0 && samples[j] < samples[j - 1]; j--) {
      double swap = samples[j];
      samples[j] = samples[j - 1];
      samples[j - 1] = swap;
    }
  }
  return samples[4];
}

int main(int argc, char **argv) {
  if (argc < 3) {
    fprintf(stderr, "usage: dict-decode <dir> <id>...\n");
    return 1;
  }
  const char *dir = argv[1];
  for (int a = 2; a < argc; a++) {
    const char *id = argv[a];
    Buffer raw = read_file(dir, id, "raw"), dictionary = read_file(dir, id, "dict");
    Buffer dcb = read_file(dir, id, "dcb"), dcz = read_file(dir, id, "dcz");
    size_t capacity = raw.size + 64;
    unsigned char *out = malloc(capacity);
    // Both frames must rebuild the exact bytes before either is timed.
    if (decode_dcb(dcb, dictionary, out, capacity) != raw.size || memcmp(out, raw.bytes, raw.size)) {
      fprintf(stderr, "dict-decode: dcb %s does not rebuild its input\n", id);
      return 5;
    }
    if (decode_dcz(dcz, dictionary, out, capacity) != raw.size || memcmp(out, raw.bytes, raw.size)) {
      fprintf(stderr, "dict-decode: dcz %s does not rebuild its input\n", id);
      return 6;
    }
    printf("%s\t%zu\t%.3f\t%.3f\n", id, raw.size, time_us(decode_dcb, dcb, dictionary, out, capacity),
           time_us(decode_dcz, dcz, dictionary, out, capacity));
    free(out);
    free(raw.bytes);
    free(dictionary.bytes);
    free(dcb.bytes);
    free(dcz.bytes);
  }
  return 0;
}
