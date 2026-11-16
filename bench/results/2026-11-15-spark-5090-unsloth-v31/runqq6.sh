#!/bin/sh
# Do the Zen 4 kernel picks on the 9950X3D bring the output back near the 7800X3D reference?
cd /home/spark/Apps/Strata
R=bench/results/2026-11-15-spark-5090-unsloth-v31
until grep -q DONE $R/tqq5.out; do sleep 15; done
.venv/bin/python tools/quant_quality.py run --config $R/qq-cfg-zen5-z4picks.json --out $R/qq-l1-zen5-z4picks.tsv
.venv/bin/python tools/quant_quality.py compare $R/qq-l1-new.tsv $R/qq-l1-zen5-z4picks.tsv $R/qq-l1-zen5.tsv 2>&1 | tail -4
echo DONE
