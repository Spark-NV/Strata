#!/bin/sh
P=/home/spark/Apps/Strata/.venv/bin/python
T=/home/spark/Apps/Strata/engine/strata-test-thp2
$P ab.py z-col1 mixed=1 exe=$T STRATA_PIN_GUARD=2 STRATA_COMPLEMENT_THP=1
$P ab.py z-base1 mixed=1 exe=$T
$P ab.py z-col2 mixed=1 exe=$T STRATA_PIN_GUARD=2 STRATA_COMPLEMENT_THP=1
$P ab.py z-base2 mixed=1 exe=$T
$P ab.py z-col3 mixed=1 exe=$T STRATA_PIN_GUARD=2 STRATA_COMPLEMENT_THP=1
echo DONE
