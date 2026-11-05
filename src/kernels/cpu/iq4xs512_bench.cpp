// src/kernels/cpu/iq4xs512_bench.cpp - IQ4_XS gate/up and IQ4_NL down rows of a real native expert (the RTX 5090
// IQ4_XS profile's format): every kernel this CPU has against ggml-cpu's vec_dot, bit for bit at 1..6 tokens, and its
// time with the weights in cache (one expert again and again) and from RAM (a different expert every call).
//
//     build/iq4xs512_bench <shard.gguf> <gate_off> <up_off> <down_off> [n_embd 2560] [n_ff 640] [experts 64]
//
// The offsets are a layer's absolute ones in native_experts.txt (gate, up and down tensors of that layer, every expert
// back to back in each).

#include "ggml-cpu.h"
#include "ggml.h"
#include "strata/kernels/cpu/expert_layout.hpp"
#include "strata/kernels/cpu/iq_avx2.hpp"
#include "strata/kernels/cpu/iq_avx512.hpp"

#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <functional>
#include <random>
#include <vector>

namespace cpu = strata::kernels::cpu;

namespace {

using Clock = std::chrono::steady_clock;

bool read_at(const char* path, uint64_t off, size_t n, uint8_t* dst) {
    std::ifstream f(path, std::ios::binary);
    f.seekg((std::streamoff) off);
    f.read((char*) dst, (std::streamsize) n);
    return (size_t) f.gcount() == n;
}

// ms per call: the best of 5 rounds of `iters` calls
double time_ms(int iters, const std::function<void(int)>& fn) {
    double best = 1e30;
    for (int round = 0; round < 5; ++round) {
        const auto t0 = Clock::now();
        for (int i = 0; i < iters; ++i) fn(i);
        best = std::min(best, std::chrono::duration<double, std::milli>(Clock::now() - t0).count() / iters);
    }
    return best;
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 5) {
        std::fprintf(stderr, "usage: %s <shard.gguf> <gate_off> <up_off> <down_off> [n_embd] [n_ff] [experts]\n", argv[0]);
        return 2;
    }
    ggml_cpu_init();
    const char* path = argv[1];
    const uint64_t gate_off = std::strtoull(argv[2], nullptr, 10), up_off = std::strtoull(argv[3], nullptr, 10),
                   down_off = std::strtoull(argv[4], nullptr, 10);
    const int E = argc > 5 ? std::atoi(argv[5]) : 2560, F = argc > 6 ? std::atoi(argv[6]) : 640;
    const int NE = argc > 7 ? std::atoi(argv[7]) : 64;
    const size_t gu_row = ggml_row_size(GGML_TYPE_IQ4_XS, E), d_row = ggml_row_size(GGML_TYPE_IQ4_NL, F);
    const size_t gate_b = (size_t) F * gu_row, down_b = (size_t) E * d_row, blob_b = 2 * gate_b + down_b;
    // blobs laid out as the engine's: gate rows, up rows, down rows
    std::vector<uint8_t> blobs((size_t) NE * blob_b);
    for (int e = 0; e < NE; ++e) {
        uint8_t* b = blobs.data() + (size_t) e * blob_b;
        if (!read_at(path, gate_off + (uint64_t) e * gate_b, gate_b, b) ||
            !read_at(path, up_off + (uint64_t) e * gate_b, gate_b, b + gate_b) ||
            !read_at(path, down_off + (uint64_t) e * down_b, down_b, b + 2 * gate_b)) {
            std::fprintf(stderr, "reading expert %d failed\n", e);
            return 1;
        }
    }
    std::printf("%s: %d experts, n_embd %d, n_ff %d, %.2f MB a blob; AVX-512 %d\n", cpu::cpu_name().c_str(), NE, E, F,
                blob_b / 1e6, (int) cpu::cpu_avx512_ok());
    const ggml_type_traits_cpu* t_xs = ggml_get_type_traits_cpu(GGML_TYPE_IQ4_XS);
    const ggml_type_traits_cpu* t_nl = ggml_get_type_traits_cpu(GGML_TYPE_IQ4_NL);
    const ggml_type_traits_cpu* t_q8k = ggml_get_type_traits_cpu(GGML_TYPE_Q8_K);
    const ggml_type_traits_cpu* t_q80 = ggml_get_type_traits_cpu(GGML_TYPE_Q8_0);

    constexpr int kMaxT = 6;
    std::mt19937 rng(7);
    std::normal_distribution<float> nd(0.f, 1.f);
    std::vector<std::vector<float>> x(kMaxT, std::vector<float>(E)), h(kMaxT, std::vector<float>(F));
    for (auto& v : x) for (auto& a : v) a = nd(rng);
    for (auto& v : h) for (auto& a : v) a = 0.1f * nd(rng);
    std::vector<std::vector<uint8_t>> xq(kMaxT, std::vector<uint8_t>(ggml_row_size(GGML_TYPE_Q8_K, E))),
        hq(kMaxT, std::vector<uint8_t>(ggml_row_size(GGML_TYPE_Q8_0, F)));
    int bad = 0;

    // ---- the Q8_K activation quantizer
    {
        std::vector<uint8_t> a(xq[0].size()), b(xq[0].size()), c(xq[0].size());
        for (int t = 0; t < kMaxT; ++t) {
            t_q8k->from_float(x[t].data(), a.data(), E);
            cpu::q8k_quant_avx2(x[t].data(), b.data(), E);
            if (cpu::cpu_avx512_ok()) cpu::q8k_quant_avx512(x[t].data(), c.data(), E);
            else c = a;
            if (a != b || a != c) { std::printf("Q8_K quant: bytes differ (token %d)\n", t); ++bad; }
            xq[t] = a;
        }
        const int it = 20000;
        const double tg = time_ms(it, [&](int i) { t_q8k->from_float(x[i % kMaxT].data(), a.data(), E); });
        const double t2 = time_ms(it, [&](int i) { cpu::q8k_quant_avx2(x[i % kMaxT].data(), b.data(), E); });
        const double t5 = cpu::cpu_avx512_ok() ? time_ms(it, [&](int i) { cpu::q8k_quant_avx512(x[i % kMaxT].data(), c.data(), E); }) : 0;
        std::printf("Q8_K quant (%d values): ggml %.2f us, avx2 %.2f us, avx512 %.2f us\n", E, tg * 1e3, t2 * 1e3, t5 * 1e3);
        for (int t = 0; t < kMaxT; ++t) t_q80->from_float(h[t].data(), hq[t].data(), F);
    }

    const void* ap[kMaxT];
    const void* hp[kMaxT];
    for (int t = 0; t < kMaxT; ++t) { ap[t] = xq[t].data(); hp[t] = hq[t].data(); }
    std::vector<std::vector<float>> ffa(kMaxT, std::vector<float>(F)), ffb(kMaxT, std::vector<float>(F)),
        oa(kMaxT, std::vector<float>(E)), ob(kMaxT, std::vector<float>(E));
    float* ffap[kMaxT];
    float* ffbp[kMaxT];
    float* oap[kMaxT];
    float* obp[kMaxT];
    for (int t = 0; t < kMaxT; ++t) { ffap[t] = ffa[t].data(); ffbp[t] = ffb[t].data(); oap[t] = oa[t].data(); obp[t] = ob[t].data(); }

    // ggml's rows as native_gu_rows / native_down_rows run them where no Strata kernel takes the format
    auto ggml_gu = [&](const uint8_t* blob, int nt, float* const* ff) {
        for (int r = 0; r < F; ++r)
            for (int t = 0; t < nt; ++t) {
                float g = 0.f, u = 0.f;
                t_xs->vec_dot(E, &g, 0, blob + (size_t) r * gu_row, 0, ap[t], 0, 1);
                t_xs->vec_dot(E, &u, 0, blob + gate_b + (size_t) r * gu_row, 0, ap[t], 0, 1);
                ff[t][r] = (g / (1.f + std::exp(-g))) * u;
            }
    };
    auto ggml_down = [&](const uint8_t* blob, int nt, float* const* out) {
        for (int r = 0; r < E; ++r)
            for (int t = 0; t < nt; ++t) t_nl->vec_dot(F, &out[t][r], 0, blob + 2 * gate_b + (size_t) r * d_row, 0, hp[t], 0, 1);
    };
    auto avx512_gu = [&](const uint8_t* blob, int nt, float* const* ff) {
        cpu::iq512_gu_rows(23, blob, gu_row, gate_b, E, ap, nt, ff, 0, F);
    };
    auto avx2_gu = [&](const uint8_t* blob, int nt, float* const* ff) {
        cpu::iq256_gu_rows(23, blob, gu_row, gate_b, E, ap, nt, ff, 0, F);
    };
    auto avx2_down = [&](const uint8_t* blob, int nt, float* const* out) {
        cpu::iq4nl256_down_rows(blob + 2 * gate_b, d_row, F, hp, nt, out, 0, E);
    };
    auto avx512_down = [&](const uint8_t* blob, int nt, float* const* out) {
        cpu::iq4nl512_down_rows(blob + 2 * gate_b, d_row, F, hp, nt, out, 0, E);
    };

    struct K { const char* name; std::function<void(const uint8_t*, int, float* const*)> fn; bool gu; };
    std::vector<K> ks = {{"gate/up ggml", ggml_gu, true}, {"gate/up avx2", avx2_gu, true},
                         {"down ggml", ggml_down, false}, {"down avx2", avx2_down, false}};
    if (cpu::cpu_avx512_ok()) {
        ks.insert(ks.begin() + 2, K{"gate/up avx512", avx512_gu, true});
        ks.push_back(K{"down avx512", avx512_down, false});
    }
    // ---- bits: every expert, every width, against ggml
    for (const K& k : ks) {
        if (std::strstr(k.name, "ggml")) continue;
        int diff = 0;
        for (int e = 0; e < NE; ++e)
            for (int nt = 1; nt <= kMaxT; ++nt) {
                const uint8_t* b = blobs.data() + (size_t) e * blob_b;
                if (k.gu) {
                    ggml_gu(b, nt, ffap);
                    k.fn(b, nt, ffbp);
                    for (int t = 0; t < nt; ++t) diff += std::memcmp(ffa[t].data(), ffb[t].data(), F * 4) != 0;
                } else {
                    ggml_down(b, nt, oap);
                    k.fn(b, nt, obp);
                    for (int t = 0; t < nt; ++t) diff += std::memcmp(oa[t].data(), ob[t].data(), (size_t) E * 4) != 0;
                }
            }
        std::printf("%-15s bits vs ggml: %s (%d token rows differ)\n", k.name, diff ? "DIFFER" : "equal", diff);
        if (diff && std::strstr(k.name, "avx512")) ++bad;
    }
    // ---- time: in cache (expert 0 again) and from RAM (the next expert each call; NE blobs > L3)
    std::printf("\nus per expert call    nt:      1        2        3        4        5\n");
    for (const K& k : ks)
        for (const bool cold : {false, true}) {
            std::printf("%-15s %-6s", k.name, cold ? "RAM" : "cache");
            for (int nt = 1; nt <= 5; ++nt) {
                const double ms = time_ms(cold ? NE : 200, [&](int i) {
                    const uint8_t* b = blobs.data() + (size_t) (cold ? i % NE : 0) * blob_b;
                    k.fn(b, nt, k.gu ? ffbp : obp);
                });
                std::printf(" %8.1f", ms * 1e3);
            }
            std::printf("\n");
        }
    return bad ? 1 : 0;
}
