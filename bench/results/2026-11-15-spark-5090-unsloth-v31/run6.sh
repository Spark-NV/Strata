#!/bin/sh
P=/home/spark/Apps/Strata/.venv/bin/python
T=/home/spark/Apps/Strata/engine/strata-test-thp
until grep -q DONE t6.out; do sleep 10; done
for i in 1 2; do
  $P ab.py y-pA$i ponly=1 exe=$T
  $P ab.py y-pS$i ponly=1 exe=$T STRATA_DEQUANT_SIDE=1
  $P ab.py y-pN$i ponly=1 exe=$T STRATA_PF_FUSED_NT=256 STRATA_PF_BATCH=256
done
echo DONE
