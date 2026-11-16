#!/bin/sh
# Does 7 workers (the 7800X3D's count) give the 7800X3D's exact quality output on the 9950X3D?
cd /home/spark/Apps/Strata
R=bench/results/2026-11-15-spark-5090-unsloth-v31
until grep -q DONE $R/t12.out; do sleep 15; done
.venv/bin/python tools/quant_quality.py run --config $R/qq-cfg-zen5-w7.json --out $R/qq-l1-zen5-w7.tsv
cmp -s $R/qq-l1-zen5-w7.tsv $R/qq-l1-new.tsv && echo "7 workers on 9950X3D == 7800X3D output" || echo "7 workers on 9950X3D != 7800X3D output"
.venv/bin/python tools/quant_quality.py compare $R/qq-l1-new.tsv $R/qq-l1-zen5-w7.tsv $R/qq-l1-zen5.tsv 2>&1 | tail -5
echo DONE
