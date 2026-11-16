#!/bin/sh
# Zen 5 picks other CPU kernels (cpu_gather_fast: 512-bit single-token I-quants, IQ4_NL 512-bit down). Are they faster than the Zen 4 picks here?
P=/home/spark/Apps/Strata/.venv/bin/python
E=exe=/home/spark/Apps/Strata/engine/strata-zen5-test
until grep -q DONE t13.out 2>/dev/null; do sleep 15; done
$P ab.py x-z5a mixed=1 $E
$P ab.py x-z4a mixed=1 $E STRATA_AVX512_1T=0 STRATA_IQ4NL512=0
$P ab.py x-z5b mixed=1 $E
$P ab.py x-z4b mixed=1 $E STRATA_AVX512_1T=0 STRATA_IQ4NL512=0
echo DONE
