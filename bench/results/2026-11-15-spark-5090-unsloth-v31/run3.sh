#!/bin/sh
# seeded exactness + speed, then alternating mixed runs: A = installed engine, B = VBMI IQ3_XXS, C = B + STRATA_HC_Q8=1
P=/home/spark/Apps/Strata/.venv/bin/python
T=/home/spark/Apps/Strata/engine/strata-test-vbmi
F="--adapt-every 100000"
$P ab.py v-sA seeded=1 "set=$F"
$P ab.py v-sB seeded=1 "set=$F" exe=$T
$P ab.py v-sC seeded=1 "set=$F" exe=$T STRATA_HC_Q8=1
for i in 1 2 3; do
  $P ab.py v-mA$i mixed=1
  $P ab.py v-mB$i mixed=1 exe=$T
  $P ab.py v-mC$i mixed=1 exe=$T STRATA_HC_Q8=1
done
echo DONE
