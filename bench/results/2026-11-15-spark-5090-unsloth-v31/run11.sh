#!/bin/sh
# 9950X3D: ideas that lost on the 7800X3D because CPU expert work was the bottleneck. Default layout (15 workers, both chiplets).
P=/home/spark/Apps/Strata/.venv/bin/python
E=exe=/home/spark/Apps/Strata/engine/strata-zen5-test
until grep -q DONE tqq2.out 2>/dev/null; do sleep 15; done
$P ab.py y-base1 mixed=1 $E
$P ab.py y-spec5 mixed=1 $E 'set=--spec 5'
$P ab.py y-spec6 mixed=1 $E 'set=--spec 6'
$P ab.py y-tasks96 mixed=1 $E 'args=--pool-tasks 96'
$P ab.py y-base2 mixed=1 $E
$P ab.py y-cum6 mixed=1 $E STRATA_DRAFT_CUM=1 'set=--spec 6'
$P ab.py y-pcie45 mixed=1 $E 'args=--pcie-frac 0.45'
$P ab.py y-pcie65 mixed=1 $E 'args=--pcie-frac 0.65'
$P ab.py y-base3 mixed=1 $E
echo DONE
