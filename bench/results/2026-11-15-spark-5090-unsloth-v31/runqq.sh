#!/bin/sh
cd /home/spark/Apps/Strata
P=.venv/bin/python
R=bench/results/2026-11-15-spark-5090-unsloth-v31
until grep -q DONE $R/t10.out; do sleep 10; done
$P tools/quant_quality.py run --config $R/qq-cfg-old.json --out $R/qq-l1-old.tsv
$P tools/quant_quality.py run --config $R/qq-cfg-new.json --out $R/qq-l1-new.tsv
$P tools/quant_quality.py compare $R/qq-old.tsv $R/qq-new.tsv $R/qq-l1-old.tsv $R/qq-l1-new.tsv
cmp $R/qq-l1-old.tsv $R/qq-l1-new.tsv && echo "IDENTICAL old/new engine on level 1"
echo DONE
