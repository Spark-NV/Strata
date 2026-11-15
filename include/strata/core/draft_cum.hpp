// include/strata/core/draft_cum.hpp - the cumulative draft-length rule (STRATA_DRAFT_CUM=<threshold>, off by default).
//
// Ported from Basalt (github.com/jesdga95/basalt, include/basalt/core/draft_cum.hpp, MIT), which forked Strata.
// With --spec-min-p the MTP chain stops after the first draft whose own probability is below min_p.  This rule instead
// keeps draft j while the estimated chance that drafts 0..j are ALL accepted stays at or above the threshold: the
// product over i <= j of acc(p_i), where acc maps a draft probability to the observed acceptance rate of drafts in
// that probability bin.  A middling first draft is cheap to verify and still often right, so it is proposed; a long
// run of merely high probabilities stops once the joint chance decays.  The draft chain (mtp chain_rule) and the
// window rule (spec/window_rule.hpp) evaluate the same float products in the same order, so they agree exactly.
// Only what is proposed changes: acceptance and outputs stay exact.
//
// The per-request threshold (DraftCumAdapt) falls from the base toward kLo while the request's drafts are accepted
// more often than the bin table predicts: when they run well, longer windows pay.  STRATA_DRAFT_CUM_ADAPT=0 keeps the
// base threshold.
#pragma once

#include <cmath>
#include <cstdlib>

namespace strata::core {

/// The acceptance rate of a sampled draft by its probability bin (Basalt's table, measured on Flash-Next).
inline float draft_cum_acc(float p) {
    return p < 0.30f ? 0.12f : p < 0.50f ? 0.26f : p < 0.70f ? 0.43f : p < 0.80f ? 0.51f
         : p < 0.90f ? 0.59f : p < 0.95f ? 0.66f : p < 0.99f ? 0.79f : 0.96f;
}

/// STRATA_DRAFT_CUM's base threshold (0: off, the --spec-min-p rule).  Basalt's default is 0.35.
inline float draft_cum_env() {
    static const float th = [] {
        const char* e = std::getenv("STRATA_DRAFT_CUM");
        return e != nullptr ? (float) std::atof(e) : 0.0f;
    }();
    return th;
}

inline bool draft_cum_adapt_env() {
    static const bool on = [] {
        const char* e = std::getenv("STRATA_DRAFT_CUM_ADAPT");
        return e == nullptr || std::atoi(e) != 0;
    }();
    return on;
}

/// Per-request threshold.  The observed and expected accepted counts decay per window; their ratio sets the
/// threshold along a linear ramp from the base (ratio <= 0.9) to kLo (ratio >= 1.1).  The value is fixed before a
/// window's drafts are made and shared by the chain rule and the window rule.
struct DraftCumAdapt {
    float base = 0.0f;
    double obs = 0.0, exp = 0.0;
    float cur = 0.0f;

    explicit DraftCumAdapt(float b = 0.0f) : base(b), cur(b) {}
    float th() const { return cur; }
    void reset() { obs = 0.0; exp = 0.0; cur = base; }

    /// One verified window of the MTP chain: `n` drafts were offered with probabilities probs[0..n), `acc` accepted.
    void observe(const float* probs, int n, int acc) {
        if (n <= 0 || !draft_cum_adapt_env()) return;
        double c = 1.0, e = 0.0;
        for (int j = 0; j < n; ++j) { c *= (double) draft_cum_acc(probs[j]); e += c; }
        constexpr double kDecay = 0.97, kRlo = 0.9, kRhi = 1.1;
        constexpr float kLo = 0.25f;
        obs = obs * kDecay + (double) acc;
        exp = exp * kDecay + e;
        if (exp < 0.5) return;
        const double t = std::fmin(std::fmax((obs / exp - kRlo) / (kRhi - kRlo), 0.0), 1.0);
        cur = base + (float) t * (std::fmin(kLo, base) - base);
    }
};

}  // namespace strata::core
