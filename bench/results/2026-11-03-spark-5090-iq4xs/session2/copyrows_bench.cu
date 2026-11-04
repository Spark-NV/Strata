#include <cuda_runtime.h>
#include <cstdio>
#include <vector>
__device__ __forceinline__ void prologue(int row, const int32_t* hit_rows, const int32_t* count, int& hit) {}
__global__ void old_k(float4* __restrict__ dst, const volatile float4* src, int64_t row4, const int32_t* __restrict__ hit_rows, const int32_t* __restrict__ count) {
    const int row = blockIdx.x; __shared__ int hit;
    if (threadIdx.x == 0) { int h = 0; const int c = *count; for (int i = 0; i < c; ++i) h |= hit_rows[i] == row; hit = h; }
    __syncthreads(); float4* d = dst + (int64_t) row * row4;
    if (hit) { for (int64_t i = threadIdx.x; i < row4; i += blockDim.x) d[i] = make_float4(0,0,0,0); }
    else { const volatile float4* sr = src + (int64_t) row * row4; for (int64_t i = threadIdx.x; i < row4; i += blockDim.x) d[i] = const_cast<const float4*>(sr)[i]; }
}
__global__ void new_k(float4* __restrict__ dst, const volatile float4* src, int64_t row4, const int32_t* __restrict__ hit_rows, const int32_t* __restrict__ count) {
    const int row = blockIdx.x; __shared__ int hit;
    if (threadIdx.x == 0) { int h = 0; const int c = *count; for (int i = 0; i < c; ++i) h |= hit_rows[i] == row; hit = h; }
    __syncthreads(); float4* d = dst + (int64_t) row * row4;
    if (hit) { for (int64_t i = threadIdx.x; i < row4; i += blockDim.x) d[i] = make_float4(0,0,0,0); }
    else { const float4* sr = const_cast<const float4*>(src + (int64_t) row * row4); constexpr int U = 8;
        for (int64_t i0 = threadIdx.x; i0 < row4; i0 += (int64_t) blockDim.x * U) { float4 v[U];
#pragma unroll
            for (int u = 0; u < U; ++u) { const int64_t i = i0 + (int64_t) u * blockDim.x; if (i < row4) v[u] = sr[i]; }
#pragma unroll
            for (int u = 0; u < U; ++u) { const int64_t i = i0 + (int64_t) u * blockDim.x; if (i < row4) d[i] = v[u]; } } }
}
int main() {
    const int W = 2560; for (int T : {1, 4, 8}) for (int cpu_rows : {1, 3, 8}) {
        const int rows = T * 10; if (cpu_rows > rows) continue;
        float* h; cudaHostAlloc((void**)&h, (size_t)rows*W*4, cudaHostAllocMapped); float* hd; cudaHostGetDevicePointer((void**)&hd, h, 0);
        std::vector<int> hit; for (int r = cpu_rows; r < rows; ++r) hit.push_back(r); int cnt = hit.size();
        int32_t *dh, *dc; cudaMalloc(&dh, (cnt+1)*4); cudaMalloc(&dc, 4); cudaMemcpy(dh, hit.data(), cnt*4, cudaMemcpyHostToDevice); cudaMemcpy(dc, &cnt, 4, cudaMemcpyHostToDevice);
        float* d; cudaMalloc(&d, (size_t)rows*W*4);
        cudaEvent_t a, b; cudaEventCreate(&a); cudaEventCreate(&b); float t[2];
        for (int k = 0; k < 2; ++k) { for (int w = 0; w < 50; ++w) (k ? new_k : old_k)<<<rows,128>>>((float4*)d,(const volatile float4*)hd,W/4,dh,dc);
            cudaEventRecord(a); for (int it = 0; it < 2000; ++it) (k ? new_k : old_k)<<<rows,128>>>((float4*)d,(const volatile float4*)hd,W/4,dh,dc);
            cudaEventRecord(b); cudaEventSynchronize(b); cudaEventElapsedTime(&t[k], a, b); }
        printf("T=%d cpu rows %d: old %.2f us  new %.2f us per launch\n", T, cpu_rows, t[0]*1000/2000, t[1]*1000/2000);
        cudaFreeHost(h); cudaFree(dh); cudaFree(dc); cudaFree(d);
    }
}
