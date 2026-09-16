// Local benchmark helper, not the production compressor. Static-link libzstd.
// stdin: u32 dictionary count, u32 job count; length-prefixed dictionaries;
// then (u32 dictionary index, length-prefixed source) per job, little endian.
// stdout: length-prefixed frames in input order. No partial output on failure.
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <zstd.h>

typedef struct { uint8_t *bytes; uint32_t size; ZSTD_CDict *prepared; } Dictionary;
typedef struct { uint8_t *bytes, *frame; uint32_t size, dictionary; size_t frame_size; } Job;
typedef struct { Dictionary *dicts; Job *jobs; uint32_t count, worker, workers; int prepared, failed; } Work;
static void fail(const char *message) { fprintf(stderr, "%s\n", message); exit(1); }
static uint32_t read_u32(void) {
    uint8_t b[4]; if (fread(b, 1, 4, stdin) != 4) fail("truncated input");
    return (uint32_t)b[0] | (uint32_t)b[1]<<8 | (uint32_t)b[2]<<16 | (uint32_t)b[3]<<24;
}
static uint8_t *read_bytes(uint32_t *size) {
    *size = read_u32();
    if (*size > 64U * 1024U * 1024U) fail("input exceeds 64 MiB per buffer");
    uint8_t *bytes = malloc(*size ? *size : 1);
    if (!bytes || fread(bytes, 1, *size, stdin) != *size) fail("allocation or input failure");
    return bytes;
}
static void write_u32(uint32_t n) {
    const uint8_t b[4] = { n & 255, (n>>8)&255, (n>>16)&255, (n>>24)&255 };
    if (fwrite(b, 1, 4, stdout) != 4) fail("output failure");
}
static int check(size_t result) {
    if (!ZSTD_isError(result)) return 0;
    fprintf(stderr, "zstd: %s\n", ZSTD_getErrorName(result)); return 1;
}
static void *compress_jobs(void *arg) {
    Work *work = arg;
    ZSTD_CCtx *ctx = ZSTD_createCCtx();
    if (!ctx) { work->failed = 1; return NULL; }
    uint32_t previous = UINT32_MAX;
    if (check(ZSTD_CCtx_setParameter(ctx, ZSTD_c_compressionLevel, 19))) work->failed = 1;
    for (uint32_t i = work->worker; i < work->count && !work->failed; i += work->workers) {
        Job *job = &work->jobs[i];
        Dictionary *dict = &work->dicts[job->dictionary];
        if (previous != job->dictionary) {
            size_t result = work->prepared ? ZSTD_CCtx_refCDict(ctx, dict->prepared)
                                          : ZSTD_CCtx_loadDictionary(ctx, dict->bytes, dict->size);
            if (check(result)) { work->failed = 1; break; }
            previous = job->dictionary;
        }
        size_t cap = ZSTD_compressBound(job->size);
        job->frame = malloc(cap);
        if (!job->frame) { work->failed = 1; break; }
        job->frame_size = ZSTD_compress2(ctx, job->frame, cap, job->bytes, job->size);
        if (check(job->frame_size)) work->failed = 1;
    }
    ZSTD_freeCCtx(ctx); return NULL;
}
int main(int argc, char **argv) {
    if (argc == 2 && !strcmp(argv[1], "--version")) { puts(ZSTD_versionString()); return 0; }
    if (argc != 3 || (strcmp(argv[1], "reuse") && strcmp(argv[1], "prepared"))) fail("usage: batch reuse|prepared WORKERS");
    char *end; long requested = strtol(argv[2], &end, 10);
    if (*end || requested < 1 || requested > 8) fail("workers must be 1..8");
    uint32_t workers = (uint32_t)requested;
    uint32_t dict_count = read_u32(), count = read_u32();
    if (!dict_count || dict_count > 1000 || !count || count > 10000) fail("invalid batch size");
    Dictionary *dicts = calloc(dict_count, sizeof(*dicts));
    Job *jobs = calloc(count, sizeof(*jobs));
    if (!dicts || !jobs) fail("allocation failure");
    int prepared = !strcmp(argv[1], "prepared");
    for (uint32_t i = 0; i < dict_count; i++) {
        dicts[i].bytes = read_bytes(&dicts[i].size);
        if (prepared) {
            dicts[i].prepared = ZSTD_createCDict(dicts[i].bytes, dicts[i].size, 19);
            if (!dicts[i].prepared) fail("cannot prepare dictionary");
        }
    }
    for (uint32_t i = 0; i < count; i++) {
        jobs[i].dictionary = read_u32();
        if (jobs[i].dictionary >= dict_count) fail("invalid dictionary index");
        jobs[i].bytes = read_bytes(&jobs[i].size);
    }
    if (fgetc(stdin) != EOF) fail("trailing input");
    pthread_t threads[8]; Work work[8]; uint32_t started = 0;
    for (uint32_t i = 0; i < workers; i++) {
        work[i] = (Work){dicts, jobs, count, i, workers, prepared, 0};
        if (pthread_create(&threads[i], NULL, compress_jobs, &work[i])) break;
        started++;
    }
    int failed = started != workers;
    for (uint32_t i = 0; i < started; i++) {
        if (pthread_join(threads[i], NULL) || work[i].failed) failed = 1;
    }
    if (!failed) for (uint32_t i = 0; i < count; i++) {
        if (jobs[i].frame_size > UINT32_MAX) fail("frame too large");
        write_u32((uint32_t)jobs[i].frame_size);
        if (fwrite(jobs[i].frame, 1, jobs[i].frame_size, stdout) != jobs[i].frame_size) fail("output failure");
    }
    for (uint32_t i = 0; i < count; i++) { free(jobs[i].bytes); free(jobs[i].frame); }
    for (uint32_t i = 0; i < dict_count; i++) { free(dicts[i].bytes); ZSTD_freeCDict(dicts[i].prepared); }
    free(jobs); free(dicts);
    return failed || fflush(stdout) != 0;
}
