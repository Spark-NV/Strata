// src/kernels/cpu/iq3_vbmi_parity.cpp - the IQ3_XXS VBMI grid decode (iq_avx512.cpp, Fmt<118>) against the scalar-load
// decode it replaces on Zen 4: random IQ3_XXS rows (every grid index, sign index and scale), 1..8 tokens, the fused
// gate/up rows and the plain rows.  Prints one hash of every output's bits; run it twice and compare:
//
//     iq3_vbmi_parity            # the VBMI decode
//     STRATA_NO_IQ3_VBMI=1 iq3_vbmi_parity   # the scalar-load decode: the same hash means the same bits
#include "strata/kernels/cpu/iq_avx512.hpp"

#include <cstdint>

#include <cstdio>
#include <cstring>
#include <random>
#include <vector>

struct block_q8_K { float d; int8_t qs[256]; int16_t bsums[16]; };   // ggml's layout (ggml-common.h)

int main() {
    constexpr int n = 2560, rows = 640, nb = n / 256, rb = nb * 98;
    std::mt19937 rng(20261115);
    std::uniform_int_distribution<int> byte(0, 255);
    std::normal_distribution<float> nd(0.f, 1.f);
    uint64_t h = 1469598103934665603ull;
    auto mix = [&](const float* p, size_t k) {
        for (size_t i = 0; i < k; ++i) { uint32_t u; std::memcpy(&u, &p[i], 4); h = (h ^ u) * 1099511628211ull; }
    };
    for (int trial = 0; trial < 40; ++trial) {
        // gate rows then up rows (up_off), each block: fp16 d, 64 grid bytes, 8 x u32 signs/scales
        std::vector<uint8_t> w((size_t) 2 * rows * rb);
        for (auto& b : w) b = (uint8_t) byte(rng);
        for (size_t r = 0; r < (size_t) 2 * rows; ++r)
            for (int i = 0; i < nb; ++i) {
                const uint16_t d = (uint16_t) (0x2000 + (byte(rng) << 2));   // a modest positive fp16 scale
                std::memcpy(&w[r * rb + (size_t) i * 98], &d, 2);
            }
        std::vector<block_q8_K> y((size_t) 8 * nb);
        for (auto& b : y) {
            b.d = 0.01f + 0.001f * (float) byte(rng);
            for (int i = 0; i < 256; ++i) b.qs[i] = (int8_t) (byte(rng) - 128);
            for (int g = 0; g < 16; ++g) { int s = 0; for (int i = 0; i < 16; ++i) s += b.qs[16 * g + i]; b.bsums[g] = (int16_t) s; }
        }
        for (int nt = 1; nt <= 8; ++nt) {
            const void* act[8];
            for (int t = 0; t < nt; ++t) act[t] = &y[(size_t) t * nb];
            std::vector<float> ff((size_t) nt * rows), dot((size_t) nt * rows);
            float* fp[8]; float* dp[8];
            for (int t = 0; t < nt; ++t) { fp[t] = &ff[(size_t) t * rows]; dp[t] = &dot[(size_t) t * rows]; }
            strata::kernels::cpu::iq512_gu_rows(18, w.data(), rb, (size_t) rows * rb, n, act, nt, fp, 0, rows);
            strata::kernels::cpu::iq512_rows(18, w.data(), rb, n, act, nt, dp, 0, rows);
            mix(ff.data(), ff.size());
            mix(dot.data(), dot.size());
        }
    }
    std::printf("iq3_vbmi_parity: hash %016llx\n", (unsigned long long) h);
    return 0;
}
