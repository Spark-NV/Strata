#!/bin/sh
# 9950X3D worker layouts (cores 0-7 = V-Cache chiplet, 8-15 = second chiplet, 16-31 = SMT siblings). Host thread on core 0.
P=/home/spark/Apps/Strata/.venv/bin/python
E=exe=/home/spark/Apps/Strata/engine/strata-zen5-test
while pgrep -f "quant_quality[.]py" >/dev/null; do sleep 15; done
$P ab.py z-def1 mixed=1 $E
$P ab.py z-c0 mixed=1 $E STRATA_POOL_CORES=1-7
$P ab.py z-c01 mixed=1 $E STRATA_POOL_CORES=1-15
$P ab.py z-smt mixed=1 $E STRATA_POOL_CORES=1-15,17-31
$P ab.py z-def2 mixed=1 $E
$P ab.py z-c1 mixed=1 $E STRATA_POOL_CORES=8-15
$P ab.py z-c0b mixed=1 $E STRATA_POOL_CORES=1-7
$P ab.py z-old1 mixed=1
echo DONE
