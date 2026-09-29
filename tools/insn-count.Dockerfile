# The image tools/insn-count.ts records inside: node plus valgrind, nothing else.
# Valgrind has no macOS arm64 port, so on a Mac this runs under apple/container:
#
#   container build -t node-valgrind -f tools/insn-count.Dockerfile tools
#   container run --rm --memory 6g --cpus 6 -v "$PWD":/w -w /w node-valgrind \
#     node tools/insn-count.ts record /w/.perf-measure/insn-head.json
#
# The node major tracks .node-version (26). Counts depend on the exact node build
# and the CPU architecture, so both records of a comparison must come from the
# same image on the same machine; the record stores both and `compare` refuses
# a pair that disagrees. Pass --memory: the default container is about 1 GiB.
FROM node:26-trixie-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends valgrind \
 && rm -rf /var/lib/apt/lists/*
