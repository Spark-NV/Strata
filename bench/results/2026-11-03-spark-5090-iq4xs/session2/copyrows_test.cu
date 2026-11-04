#include "strata/kernels/elementwise.hpp"
#include <cuda_runtime.h>
#include <cstdio>
#include <cstring>
#include <random>
#include <vector>
int main() {
    std::mt19937 g(5); int bad = 0;
    for (int width : {2560, 640, 1284, 4, 8192}) for (int rows : {1, 7, 40, 120}) for (int trial = 0; trial < 3; ++trial) {
        float* h; cudaHostAlloc((void**)&h, (size_t)rows*width*4, cudaHostAllocMapped);
        for (size_t i = 0; i < (size_t)rows*width; ++i) h[i] = (float)(g() % 100000) - 5e4f;
        float* hd; cudaHostGetDevicePointer((void**)&hd, h, 0);
        std::vector<int> hit; for (int r = 0; r < rows; ++r) if (g() % 3) hit.push_back(r);
        int cnt = (int)hit.size(); int32_t *dh, *dc; cudaMalloc(&dh, (hit.size()+1)*4); cudaMalloc(&dc, 4);
        cudaMemcpy(dh, hit.data(), hit.size()*4, cudaMemcpyHostToDevice); cudaMemcpy(dc, &cnt, 4, cudaMemcpyHostToDevice);
        float* d; cudaMalloc(&d, (size_t)rows*width*4); cudaMemset(d, 0x7f, (size_t)rows*width*4);
        strata::kernels::copy_rows_from_mapped(d, hd, rows, width, dh, dc, nullptr == nullptr ? (void*)cudaStreamPerThread : nullptr);
        std::vector<float> out((size_t)rows*width); cudaMemcpy(out.data(), d, out.size()*4, cudaMemcpyDeviceToHost);
        for (int r = 0; r < rows; ++r) { bool ih = false; for (int x : hit) ih |= x == r;
            for (int c = 0; c < width; ++c) { float want = ih ? 0.0f : h[(size_t)r*width+c]; if (std::memcmp(&want, &out[(size_t)r*width+c], 4)) { ++bad; break; } } }
        cudaFreeHost(h); cudaFree(dh); cudaFree(dc); cudaFree(d);
    }
    printf("copy_rows_from_mapped: %s (%d bad rows)\n", bad ? "FAIL" : "ok", bad); return bad != 0;
}
