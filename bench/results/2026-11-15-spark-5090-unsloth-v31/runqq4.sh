#!/bin/sh
# Is the difference from the 7800X3D reference the expert profile (which experts sit in VRAM), not the CPU?
cd /home/spark/Apps/Strata
R=bench/results/2026-11-15-spark-5090-unsloth-v31
until grep -q DONE $R/t13.out; do sleep 15; done
for c in 1b814f92 65a0b5b7; do
  .venv/bin/python tools/quant_quality.py run --config $R/qq-cfg-zen5-prof$c.json --out $R/qq-l1-zen5-prof$c.tsv
  cmp -s $R/qq-l1-zen5-prof$c.tsv $R/qq-l1-new.tsv && echo "profile $c on 9950X3D == 7800X3D output" || echo "profile $c on 9950X3D != 7800X3D output"
done
.venv/bin/python tools/quant_quality.py compare $R/qq-l1-new.tsv $R/qq-l1-zen5-prof1b814f92.tsv $R/qq-l1-zen5-prof65a0b5b7.tsv 2>&1 | tail -4
echo DONE
