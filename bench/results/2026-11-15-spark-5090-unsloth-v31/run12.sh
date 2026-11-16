#!/bin/sh
# Short prompts (chat follow-ups): the CPU pool computes the experts few tokens route to (STRATA_PREFILL_CPU_SHARE=auto) vs GPU only.
P=/home/spark/Apps/Strata/.venv/bin/python
E=exe=/home/spark/Apps/Strata/engine/strata-zen5-test
until grep -q DONE tqq4.out 2>/dev/null; do sleep 15; done
$P ab.py s-base1 short=1 ponly=1 $E
$P ab.py s-cpu1 short=1 ponly=1 $E STRATA_PREFILL_CPU_SHARE=auto
$P ab.py s-base2 short=1 ponly=1 $E
$P ab.py s-cpu2 short=1 ponly=1 $E STRATA_PREFILL_CPU_SHARE=auto
echo DONE
