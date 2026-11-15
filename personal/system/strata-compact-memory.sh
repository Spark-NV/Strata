#!/bin/sh
# Frees the page cache and compacts RAM so Strata's 48.7 GiB of experts in RAM all get 2 MiB pages.
# Run as root by strata-compact-memory.service, which qwen-orca-iq4xs.service starts before the engine.
# Measured 2026-11-15 (bench/results/2026-11-15-spark-5090-unsloth-v31, runc.sh): 48-50 GiB of huge pages
# instead of about 30; decode 140.3 vs 140.2 tok/s, start time unchanged (46-52 s).
sync
echo 3 > /proc/sys/vm/drop_caches
echo 1 > /proc/sys/vm/compact_memory
