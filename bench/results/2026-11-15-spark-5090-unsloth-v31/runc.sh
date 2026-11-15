#!/bin/sh
# Huge-page coverage A/B after a one-time "drop caches + compact memory" (run by Spark as root first).
# full = the profile's STRATA_COMPLEMENT_THP=2 on compacted RAM; off = STRATA_COMPLEMENT_THP=0 (4 KB pages).
P=/home/spark/Apps/Strata/.venv/bin/python
grep -E "MemFree|AnonHuge" /proc/meminfo; cat /proc/buddyinfo
$P ab.py c-full1 mixed=1
$P ab.py c-off1 mixed=1 STRATA_COMPLEMENT_THP=0
$P ab.py c-full2 mixed=1
$P ab.py c-off2 mixed=1 STRATA_COMPLEMENT_THP=0
$P ab.py c-full3 mixed=1
echo DONE
