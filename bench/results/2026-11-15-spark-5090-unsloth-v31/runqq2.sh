#!/bin/sh
# Is the quality-run difference the Zen 5 build or the new CPU? Old (Zen 4-built) engine on the 9950X3D, and the Zen 5 build again.
cd /home/spark/Apps/Strata
P=.venv/bin/python
R=bench/results/2026-11-15-spark-5090-unsloth-v31
until grep -q DONE $R/t11.out; do sleep 15; done
$P tools/quant_quality.py run --config $R/qq-cfg-old9950.json --out $R/qq-l1-old9950.tsv
$P tools/quant_quality.py run --config $R/qq-cfg-zen5.json --out $R/qq-l1-zen5b.tsv
cmp -s $R/qq-l1-old9950.tsv $R/qq-l1-zen5.tsv && echo "old engine on 9950X3D == zen5 build" || echo "old engine on 9950X3D != zen5 build"
cmp -s $R/qq-l1-zen5b.tsv $R/qq-l1-zen5.tsv && echo "zen5 build repeat identical" || echo "zen5 build repeat differs"
cmp -s $R/qq-l1-old9950.tsv $R/qq-l1-new.tsv && echo "old engine: 9950X3D == 7800X3D" || echo "old engine: 9950X3D != 7800X3D"
$P tools/quant_quality.py compare $R/qq-l1-new.tsv $R/qq-l1-zen5.tsv $R/qq-l1-new.tsv $R/qq-l1-old9950.tsv 2>&1 | tail -30
echo DONE
