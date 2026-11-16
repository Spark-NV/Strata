#!/bin/sh
# Quality with the CPU helping on short prompt chunks (STRATA_PREFILL_CPU_SHARE=auto) vs GPU only, same engine and profile.
cd /home/spark/Apps/Strata
R=bench/results/2026-11-15-spark-5090-unsloth-v31
until grep -q DONE $R/t14.out; do sleep 15; done
.venv/bin/python tools/quant_quality.py run --config $R/qq-cfg-zen5-cpushare.json --out $R/qq-l1-zen5-cpushare.tsv
.venv/bin/python tools/quant_quality.py compare $R/qq-l1-zen5.tsv $R/qq-l1-zen5-cpushare.tsv $R/qq-l1-zen5-prof65a0b5b7.tsv 2>&1 | tail -4
grep -ih "cpu share\|prefill.*share" $R/qq-l1-zen5-cpushare.tsv.stderr.txt | head -3
echo DONE
