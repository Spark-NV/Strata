#!/bin/sh
P=/home/spark/Apps/Strata/.venv/bin/python
T=/home/spark/Apps/Strata/engine/strata-test-vbmi
for i in 1 2; do
  $P ab.py w-nov$i mixed=1 exe=$T STRATA_NO_IQ3_VBMI=1
  $P ab.py w-v$i mixed=1 exe=$T
done
echo DONE
