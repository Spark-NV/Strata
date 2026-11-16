#define _GNU_SOURCE
#include <immintrin.h>
#include <pthread.h>
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <sys/mman.h>
static size_t SZ = 16ull<<30; static char* buf; static int nt; static int cores[64];
static pthread_barrier_t bar; static double tsec[64]; static volatile long long sink;
static double now(){struct timespec t;clock_gettime(CLOCK_MONOTONIC,&t);return t.tv_sec+t.tv_nsec*1e-9;}
static void* run(void* a){ int i=(int)(long)a; cpu_set_t s; CPU_ZERO(&s); CPU_SET(cores[i],&s); pthread_setaffinity_np(pthread_self(),sizeof s,&s);
  size_t per=SZ/nt; char* p=buf+per*i; __m512i acc=_mm512_setzero_si512();
  for(size_t o=0;o<per;o+=4096) p[o]=1;   /* fault in */
  pthread_barrier_wait(&bar); double t0=now();
  for(int r=0;r<3;r++) for(size_t o=0;o<per;o+=256){ acc=_mm512_add_epi64(acc,_mm512_load_si512(p+o)); acc=_mm512_add_epi64(acc,_mm512_load_si512(p+o+64)); acc=_mm512_add_epi64(acc,_mm512_load_si512(p+o+128)); acc=_mm512_add_epi64(acc,_mm512_load_si512(p+o+192)); }
  tsec[i]=now()-t0; sink+=_mm512_reduce_add_epi64(acc); return 0; }
int main(int c,char**v){ nt=0; char* l=strdup(v[1]); for(char* t=strtok(l,",");t;t=strtok(0,",")){int a,b; if(sscanf(t,"%d-%d",&a,&b)==2) for(int k=a;k<=b;k++) cores[nt++]=k; else cores[nt++]=atoi(t);}
  buf=mmap(0,SZ,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0); madvise(buf,SZ,MADV_HUGEPAGE);
  pthread_barrier_init(&bar,0,nt); pthread_t th[64]; for(int i=0;i<nt;i++) pthread_create(&th[i],0,run,(void*)(long)i); double mx=0; for(int i=0;i<nt;i++){pthread_join(th[i],0); if(tsec[i]>mx) mx=tsec[i];}
  printf("%-14s %2d threads: %6.1f GB/s read\n", v[1], nt, 3.0*SZ/mx/1e9); return 0; }
