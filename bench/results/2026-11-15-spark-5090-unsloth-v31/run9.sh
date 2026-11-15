#!/bin/sh
P=/home/spark/Apps/Strata/.venv/bin/python
T=/home/spark/Apps/Strata/engine/strata-test-all
$P ab.py k-t2a mixed=1 exe=$T STRATA_PIN_GUARD=2 STRATA_COMPLEMENT_THP=2
$P ab.py k-base1 mixed=1 exe=$T
$P ab.py k-t2b mixed=1 exe=$T STRATA_PIN_GUARD=2 STRATA_COMPLEMENT_THP=2
$P ab.py k-base2 mixed=1 exe=$T
$P ab.py k-t2c mixed=1 exe=$T STRATA_PIN_GUARD=2 STRATA_COMPLEMENT_THP=2
echo DONE
