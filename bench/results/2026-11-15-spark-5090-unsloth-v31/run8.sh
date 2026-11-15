#!/bin/sh
P=/home/spark/Apps/Strata/.venv/bin/python
T=/home/spark/Apps/Strata/engine/strata-test-thp2
until grep -q DONE t8.out; do sleep 10; done
for i in 1 2; do
  $P ab.py q-base$i mixed=1 exe=$T STRATA_PIN_GUARD=2 STRATA_COMPLEMENT_THP=1
  $P ab.py q-q4$i mixed=1 exe=$T STRATA_PIN_GUARD=2 STRATA_COMPLEMENT_THP=1 "args=--mtp-q4 all"
  $P ab.py q-prio$i mixed=1 exe=$T STRATA_PIN_GUARD=2 STRATA_COMPLEMENT_THP=1 STRATA_GRAPH_PRIO=1
done
echo DONE
