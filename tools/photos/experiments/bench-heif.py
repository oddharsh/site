"""python3 bench-heif.py BASELINE_ZENC HEIF_EXAMPLE SOURCE_DIR [PAIRS=5].

macOS workstation experiment: run outside an App Sandbox. Uses only temporary
outputs. Both sides encode the same four production tiers; baseline timing
includes sips TIFF creation, reading and cleanup. No concurrent benchmarks.
"""
import json
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path

baseline, candidate, sources = map(lambda p: Path(p).resolve(), sys.argv[1:4])
pairs = int(sys.argv[4]) if len(sys.argv) > 4 else 5
assert pairs >= 3
inputs = [("XT500010.HIF", "8"), ("XT509986.HIF", "1")]
files = ["600.jpg", "600.avif", "400.avif", "200.avif"]


def run(command):
    return subprocess.check_output(list(map(str, command)), stderr=subprocess.PIPE)


with tempfile.TemporaryDirectory(prefix="site-heif-") as scratch:
    root = Path(scratch)

    def tiers(kind, name, orient):
        out = root / kind / name
        out.mkdir(parents=True, exist_ok=True)
        source = sources / name
        if kind == "candidate":
            run([candidate, "tiers", source, out, orient])
        else:
            tiff = out / "lossless.tif"
            run(["sips", "-s", "format", "tiff", source, "--out", tiff])
            # sips may exit zero yet emit an empty TIFF in an App Sandbox.
            # The real decode below must succeed; an invalid result cannot win.
            command = [baseline, "square", tiff, "--orient", orient, "--filter", "box"]
            for size in (600, 400, 200):
                command += ["--size", size, "--avif-out", out / f"{size}.avif"]
                if size == 600:
                    command += ["--jpeg-out", out / "600.jpg", "--jpeg-quality", "84"]
            run(command)
            tiff.unlink()

    decoded = []
    for name, orient in inputs:
        tiff = root / f"{name}.tif"
        run(["sips", "-s", "format", "tiff", sources / name, "--out", tiff])
        decoded.append({"input": name, "tiffBytes": tiff.stat().st_size,
                        **json.loads(run([candidate, "compare", sources / name, tiff]))})
        tiff.unlink()
        for kind in ("baseline", "candidate"):
            tiers(kind, name, orient)
        for file in files:
            assert (root / "baseline" / name / file).read_bytes() == (root / "candidate" / name / file).read_bytes(), (name, file)

    samples = {"baseline": [], "candidate": []}
    for pair in range(pairs):
        for kind in (["candidate", "baseline"] if pair % 2 else ["baseline", "candidate"]):
            start = time.perf_counter()
            for name, orient in inputs:
                tiers(kind, name, orient)
            samples[kind].append((time.perf_counter() - start) * 1000)
        print(f"HEIF pair {pair + 1}/{pairs}: {samples['baseline'][-1]:.1f} / {samples['candidate'][-1]:.1f} ms", file=sys.stderr)
        for name, _ in inputs:
            for file in files:
                assert (root / "baseline" / name / file).read_bytes() == (root / "candidate" / name / file).read_bytes(), (pair, name, file)
    medians = {k: statistics.median(v) for k, v in samples.items()}
    print(json.dumps({"pairs": pairs, "decoded": decoded, "orientations": dict(inputs),
                      "tierFilesEqual": len(inputs) * len(files), "samplesMs": samples,
                      "medianMs": medians, "improvementPercent": 100 * (1 - medians["candidate"] / medians["baseline"])}, indent=2))
