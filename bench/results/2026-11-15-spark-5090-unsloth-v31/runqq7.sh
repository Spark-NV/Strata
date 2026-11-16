#!/bin/sh
# Prompt chunks of 512 tokens (the share's range): GPU only vs the CPU taking the experts few tokens route to.
cd /home/spark/Apps/Strata
R=bench/results/2026-11-15-spark-5090-unsloth-v31
until grep -q DONE $R/tqq6.out; do sleep 15; done
for n in p512 p512-share; do .venv/bin/python tools/quant_quality.py run --config $R/qq-cfg-zen5-$n.json --out $R/qq-l1-zen5-$n.tsv; done
.venv/bin/python tools/quant_quality.py compare $R/qq-l1-zen5-p512.tsv $R/qq-l1-zen5-p512-share.tsv $R/qq-l1-zen5.tsv 2>&1 | tail -4
grep -ih "cpu share\|share:" $R/qq-l1-zen5-p512-share.tsv.stderr.txt | grep -iv pcie | head -3
echo DONE
