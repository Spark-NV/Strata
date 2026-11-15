#!/bin/sh
P=/home/spark/Apps/Strata/.venv/bin/python
T=/home/spark/Apps/Strata/engine/strata-test-thp
until grep -q "pool:" t5.out; do sleep 5; done
$P ab.py x-base1 mixed=1 exe=$T
$P ab.py x-thp2 mixed=1 exe=$T STRATA_PIN_GUARD=2 STRATA_COMPLEMENT_THP=1
$P ab.py x-base2 mixed=1 exe=$T
$P ab.py x-thp3 mixed=1 exe=$T STRATA_PIN_GUARD=2 STRATA_COMPLEMENT_THP=1
echo DONE
