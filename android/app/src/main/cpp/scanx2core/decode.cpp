/**
 * scanx2core decoder. See scanx2core.h for provenance; comments here name the
 * doc section each technique was rebuilt from.
 */
#include "scanx2core.h"
#include "code128_table.h"
#include "code39_table.h"
#include <vector>
#include <cmath>
#include <cstring>
#include <cstdio>
#include <algorithm>
#include <chrono>
#include <cstdlib>

namespace scanx {

using clock_t_ = std::chrono::steady_clock;

struct Deadline {
  clock_t_::time_point end;
  bool expired() const { return clock_t_::now() >= end; }
};

/* ── profile extraction: the band sweep (scanx-core-band-sweep.md) ────────── */

// Average rows of a horizontal band into one 1D profile.
static void band_profile(const uint8_t* g, int w, int /*h*/, int y0, int y1,
                         std::vector<float>& out) {
  out.assign(w, 0.f);
  const float inv = 1.f / float(y1 - y0);
  for (int y = y0; y < y1; y++) {
    const uint8_t* row = g + size_t(y) * w;
    for (int x = 0; x < w; x++) out[x] += row[x] * inv;
  }
}

// Contrast gate: 95th percentile of |sample − local mean| in raw grey levels,
// BEFORE normalisation rescales it away. Doc: barcode bands 75 min / 129
// median, row-averaged noise 1.6; gate at 4.
// Roughness gate: mean |first difference| ÷ that contrast. Scale-free; white
// noise ≈ 0.6, bars ≤ 0.41 (corpus max). Gate at 0.48.
static bool band_gates(const std::vector<float>& p, float* contrast_out) {
  const int n = int(p.size());
  if (n < 32) return false;
  const int win = std::max(16, n / 16);
  std::vector<float> dev(n);
  float run = 0;
  for (int i = 0; i < win; i++) run += p[i];
  for (int i = 0; i < n; i++) {
    int a = std::max(0, i - win / 2), b = std::min(n, a + win);
    a = b - win;
    if (i > 0) { run += p[std::min(n - 1, b - 1)] - p[std::max(0, a - 1)]; }
    float mean = run / win;
    dev[i] = std::fabs(p[i] - mean);
  }
  std::vector<float> tmp(dev);
  size_t k = size_t(0.95 * (n - 1));
  std::nth_element(tmp.begin(), tmp.begin() + k, tmp.end());
  float contrast = tmp[k];
  *contrast_out = contrast;
  if (contrast < 4.f) return false;
  double rough = 0;
  for (int i = 1; i < n; i++) rough += std::fabs(p[i] - p[i - 1]);
  rough /= (n - 1);
  return (rough / contrast) < 0.48f;
}

// Normalise to roughly [-1,+1]: subtract local mean, divide by local p95.
// Space (light) → +1, bar (dark) → −1 after the sign flip below.
static void normalise(const std::vector<float>& in, std::vector<float>& out) {
  const int n = int(in.size());
  out.assign(n, 0.f);
  const int win = std::max(24, n / 12);
  for (int i = 0; i < n; i++) {
    int a = std::max(0, i - win / 2), b = std::min(n, i + win / 2);
    float mean = 0;
    for (int j = a; j < b; j++) mean += in[j];
    mean /= (b - a);
    out[i] = in[i] - mean;
  }
  std::vector<float> mag(n);
  for (int i = 0; i < n; i++) mag[i] = std::fabs(out[i]);
  std::vector<float> tmp(mag);
  size_t k = size_t(0.95 * (n - 1));
  std::nth_element(tmp.begin(), tmp.begin() + k, tmp.end());
  float scale = std::max(1e-3f, tmp[k]);
  // flip sign: raw luminance has bars dark; the matcher wants bar = +1 so a
  // pattern template of {bar,space,...} correlates positively.
  for (int i = 0; i < n; i++) out[i] = std::clamp(-out[i] / scale, -2.f, 2.f);
}

/* ── transition seeding (scanx-core-build-log.md §2 and §4) ───────────────── */

// Sub-pixel zero crossings of the normalised profile.
static void crossings(const std::vector<float>& p0, std::vector<double>& t) {
  t.clear();
  std::vector<float> p(p0.size());
  for (size_t i = 0; i < p0.size(); i++) {
    float a3 = p0[i], b3 = p0[i ? i - 1 : 0], c3 = p0[std::min(p0.size() - 1, i + 1)];
    p[i] = 0.5f * a3 + 0.25f * (b3 + c3);
  }
  for (size_t i = 1; i < p.size(); i++) {
    float a = p[i - 1], b = p[i];
    if ((a <= 0 && b > 0) || (a >= 0 && b < 0)) {
      double frac = (a == b) ? 0.5 : double(-a) / double(b - a);
      t.push_back(double(i - 1) + frac);
    }
  }
}

// Unsmoothed variant: at 1 px/module the 3-tap smooth is a full module wide
// and shifts every edge; tiny-module seeding needs the raw crossings.
static void crossings_raw(const std::vector<float>& p, std::vector<double>& t) {
  t.clear();
  for (size_t i = 1; i < p.size(); i++) {
    float a = p[i - 1], b = p[i];
    if ((a <= 0 && b > 0) || (a >= 0 && b < 0)) {
      double frac = (a == b) ? 0.5 : double(-a) / double(b - a);
      t.push_back(double(i - 1) + frac);
    }
  }
}

struct Seed { double start; double module; };

// A Code 128 start symbol spans 11 modules over 6 elements, so transition i
// to i+6 measured ÷ 11 IS the module width, sub-pixel. Second seed for
// merged bars: the 20th percentile of surviving gap widths.
static void make_seeds(const std::vector<double>& t, std::vector<Seed>& seeds) {
  seeds.clear();
  for (size_t i = 0; i + 6 < t.size(); i++) {
    double m = (t[i + 6] - t[i]) / 11.0;
    if (m >= 0.7 && m <= 24.0) seeds.push_back({t[i], m});
  }
  if (t.size() >= 8) {
    std::vector<double> gaps;
    for (size_t i = 1; i < t.size(); i++) gaps.push_back(t[i] - t[i - 1]);
    std::vector<double> tmp(gaps);
    size_t k = size_t(0.20 * (tmp.size() - 1));
    std::nth_element(tmp.begin(), tmp.begin() + k, tmp.end());
    double m = tmp[k];
    if (m >= 0.7 && m <= 24.0) {
      for (size_t i = 0; i + 1 < t.size(); i += 2) seeds.push_back({t[i], m});
    }
  }
}

/* ── blurred reference matching (build-log §1: the biggest single win) ────── */

// Template value at distance d past an edge, for blur sigma s: a smoothed
// step. tanh is a cheap erf stand-in with the right shape.
static inline double edgestep(double d, double s) { return std::tanh(d / s); }

// Template value of one pattern, exact: reconstruct from
// alternating levels. Level over element i is +1 (bar) for even i, −1 for
// odd. Sum of transitions:
static inline double pattern_at(const uint8_t* widths, int elems,
                                double x, double sigma) {
  // before the symbol: space (−1). Each edge k at cumulative position c_k
  // flips the level; a smoothed flip adds ±(1 + tanh((x-c)/sigma)).
  double v = -1.0;
  double c = 0.0;
  double dir = +1.0;                        // first edge rises into a bar
  v += dir * (1.0 + edgestep(x - c, sigma));
  for (int i = 0; i < elems; i++) {
    c += widths[i];
    dir = -dir;
    v += dir * (1.0 + edgestep(x - c, sigma));
  }
  // after the last element the level returns to space; the loop's final term
  // handles it (elems edges after the first).
  return v;
}

// Score one candidate symbol: normalised correlation between the observed
// profile and a blurred template, maximised over BLURS. Higher is better.
static const double BLURS[3] = {0.35, 0.8, 1.5};   // in modules

// Precomputed template banks. For a fixed sampling grid (offsets in module
// units) a template depends only on (pattern, blur) — never on the seed —
// so evaluating tanh per sample per seed was recomputing constants
// millions of times per frame. Grid: mx = MX0 + k*STEP, k in [0, NPTS).
static constexpr double TPL_MX0 = -1.0;
static constexpr double TPL_STEP = 1.0 / 3.0;
static constexpr int TPL_NPTS = 39;        // spans [-1, +12) — 11-module symbols
static constexpr int TPL_NPTS_STOP = 45;   // spans [-1, +14) — the 13-module stop

struct Bank {
  // [pattern 0..106][blur 0..2][k]
  float sym[107][3][TPL_NPTS];
  float symnorm[107][3];
  float stop[3][TPL_NPTS_STOP];
  float stopnorm[3];
  Bank() {
    for (int v = 0; v < 107; v++)
      for (int b = 0; b < 3; b++) {
        double nb = 0;
        for (int k = 0; k < TPL_NPTS; k++) {
          double tp = pattern_at(CODE128[v], 6, TPL_MX0 + k * TPL_STEP, BLURS[b]);
          sym[v][b][k] = float(tp);
          nb += tp * tp;
        }
        symnorm[v][b] = float(std::sqrt(nb));
      }
    for (int b = 0; b < 3; b++) {
      double nb = 0;
      for (int k = 0; k < TPL_NPTS_STOP; k++) {
        double tp = pattern_at(CODE128_STOP, 7, TPL_MX0 + k * TPL_STEP, BLURS[b]);
        stop[b][k] = float(tp);
        nb += tp * tp;
      }
      stopnorm[b] = float(std::sqrt(nb));
    }
  }
};
static const Bank& bank() { static Bank b; return b; }

// NCC of the observed profile at (start, module) against one banked template.
static double score_banked(const std::vector<float>& p, double start,
                           double module, const float* tpl, float tplnorm,
                           int npts) {
  const int n = int(p.size());
  double dot = 0, na = 0;
  double px = start + TPL_MX0 * module;
  const double dpx = TPL_STEP * module;
  for (int k = 0; k < npts; k++, px += dpx) {
    int xi = int(px);
    if (xi < 0 || xi + 1 >= n) continue;
    double frac = px - xi;
    double ob = p[xi] * (1 - frac) + p[xi + 1] * frac;
    dot += ob * tpl[k];
    na += ob * ob;
  }
  if (na <= 0) return -1e9;
  return dot / (std::sqrt(na) * tplnorm);
}

// Symbol score maximised over blurs. `widths` selects the banked pattern:
// pass the pattern INDEX via value semantics below instead of raw widths.
static double score_symbol_v(const std::vector<float>& p, double start,
                             double module, int value) {
  const Bank& B = bank();
  double best = -1e9;
  for (int b = 0; b < 3; b++) {
    double s = score_banked(p, start, module, B.sym[value][b], B.symnorm[value][b], TPL_NPTS);
    if (s > best) best = s;
  }
  return best;
}

static double score_stop(const std::vector<float>& p, double start, double module) {
  const Bank& B = bank();
  double best = -1e9;
  for (int b = 0; b < 3; b++) {
    double s = score_banked(p, start, module, B.stop[b], B.stopnorm[b], TPL_NPTS_STOP);
    if (s > best) best = s;
  }
  return best;
}

/* ── the symbol walk (build-log §3: track, don't dead-reckon) ─────────────── */

// Quiet-zone evidence. Magnitude is the WRONG test: next to a dark
// background a wide normalisation window drags the whole quiet margin away
// from the local mean, so a genuinely blank zone can sit at |p| ≈ 1 (this
// killed every read on the p4 cylinder frame). What bars have and blank
// margins lack is OSCILLATION — so compare high-frequency energy (mean
// |first difference|) in the zone against the same measure inside the
// symbol. A zone quieter than 45% of the symbol's flank passes. Off-frame
// zones pass: a cropped band cannot testify either way.
static double hf_energy(const std::vector<float>& p, int ia, int ib) {
  ia = std::max(1, ia); ib = std::min(int(p.size()), ib);
  if (ib - ia < 2) return -1.0;
  double e = 0;
  for (int i = ia; i < ib; i++) e += std::fabs(p[i] - p[i - 1]);
  return e / (ib - ia);
}

static bool zone_quiet_vs(const std::vector<float>& p, double a, double b,
                          double sym_a, double sym_b) {
  double ez = hf_energy(p, int(a), int(b));
  if (ez < 0) return true;
  double es = hf_energy(p, int(sym_a), int(sym_b));
  if (es <= 0) return true;
  if (ez < 0.45 * es) return true;
  // Absolute fallback: on a plain background the zone sits near the local
  // mean with little swing; noisy-but-blank zones can fail the relative test
  // when the symbol's own per-pixel energy is low (large modules).
  int ia = std::max(0, int(a)), ib = std::min(int(p.size()), int(b));
  if (ib - ia < 2) return true;
  std::vector<float> mag;
  for (int i = ia; i < ib; i++) mag.push_back(std::fabs(p[i]));
  size_t k = size_t(0.9 * (mag.size() - 1));
  std::nth_element(mag.begin(), mag.begin() + k, mag.end());
  return mag[k] < 0.55f;
}

// One cheap look: does a start symbol plausibly sit at this seed? Single
// blur, coarse sampling, the three start patterns only.
static double quick_start_score(const std::vector<float>& p, Seed sd) {
  const Bank& B = bank();
  double best = -1e9;
  for (int v = 103; v <= 105; v++) {
    double s = score_banked(p, sd.start, sd.module, B.sym[v][1], B.symnorm[v][1], TPL_NPTS);
    if (s > best) best = s;
  }
  return best;
}

// Decode one direction of one profile from one seed. Returns symbol values
// (start..checksum) or empty. margin_out = weakest (best − runner-up).
// Per-symbol margins and runner-up values are kept for checksum repair: when
// exactly one symbol was misjudged, the checksum plus the runner-up identify
// and fix it — the same role the margins played in the original engine.
struct WalkOut { std::vector<int> vals; std::vector<double> margins; std::vector<int> runners; };

static WalkOut walk(const std::vector<float>& p, Seed seed,
                    const Deadline& dl, double* margin_out,
                    double* module_out) {
  WalkOut wo;
  std::vector<int>& out = wo.vals;
  double module = seed.module;
  double pos = seed.start;

  // 1) the seed must look like a start symbol
  double best_start = -1e9; int start_val = -1; double runner_start = -1e9;
  for (int v = 103; v <= 105; v++) {
    double s = score_symbol_v(p, pos, module, v);
    if (s > best_start) { runner_start = best_start; best_start = s; start_val = v; }
    else if (s > runner_start) runner_start = s;
  }
  if (std::getenv("SX2_DEBUG2"))
    std::fprintf(stderr, "      start@%.1f m=%.2f best_start=%.3f zone=%d\n",
                 pos, module, best_start,
                 int(zone_quiet_vs(p, pos - 4.5 * module, pos - 1.5 * module,
                                   pos, pos + 11 * module)));
  if (best_start < 0.55) return wo;       // not a start here
  // QUIET ZONE, leading: the spec demands ~10 modules of clear space; a
  // start pattern matched INSIDE a longer code has bars there instead.
  if (!zone_quiet_vs(p, pos - 4.5 * module, pos - 1.5 * module,
                     pos, pos + 11 * module)) return wo;
  out.push_back(start_val);
  wo.margins.push_back(1.0); wo.runners.push_back(start_val);
  double weakest = 1.0;                    // margins tracked as best−runner

  // refine the start position a little
  for (double off = -0.6; off <= 0.6; off += 0.15) {
    double s = score_symbol_v(p, pos + off * module, module, start_val);
    if (s > best_start) { best_start = s; pos = pos + off * module; }
  }
  pos += 11 * module;

  // 2) walk symbols; each is re-found within half a module of its predicted
  // position and the walk advances from the CORRECTED position (§3).
  for (int k = 0; k < 40; k++) {
    if (dl.expired()) return WalkOut{};
    // is this the stop pattern?
    double stop_s = -1e9;
    for (double off = -0.5; off <= 0.5; off += 0.125) {
      double s = score_stop(p, pos + off * module, module);
      if (s > stop_s) stop_s = s;
    }
    // TOP-K REFINEMENT, not winner-only. At 1.6 px/module a wrong winner at
    // the nominal offset is common and refining only the winner can never
    // recover it — the true symbol often wins once its position is allowed
    // to shift half a module. Score all 103 coarsely, then refine the top 5
    // over position and module and re-rank on the refined scores.
    struct Cand { double s; int v; };
    Cand top[5];
    int ntop = 0;
    for (int v = 0; v < 103; v++) {
      double sc = score_symbol_v(p, pos, module, v);
      if (ntop < 5) {
        top[ntop++] = {sc, v};
        std::sort(top, top + ntop, [](const Cand& a, const Cand& b) { return a.s > b.s; });
      } else if (sc > top[4].s) {
        top[4] = {sc, v};
        std::sort(top, top + 5, [](const Cand& a, const Cand& b) { return a.s > b.s; });
      }
    }
    double best = -1e9, runner = -1e9, best_pos = pos, best_mod = module;
    int best_v = -1, runner_v = -1;
    for (int c = 0; c < ntop; c++) {
      double cb = -1e9, cb_pos = pos, cb_mod = module;
      for (double off = -0.5; off <= 0.5; off += 0.125) {
        for (double dm = -0.08; dm <= 0.08; dm += 0.04) {
          double sc = score_symbol_v(p, pos + off * module, module * (1 + dm), top[c].v);
          if (sc > cb) { cb = sc; cb_pos = pos + off * module; cb_mod = module * (1 + dm); }
        }
      }
      if (cb > best) {
        runner = best; runner_v = best_v;
        best = cb; best_v = top[c].v; best_pos = cb_pos; best_mod = cb_mod;
      } else if (cb > runner) { runner = cb; runner_v = top[c].v; }
    }
    if (stop_s > best && stop_s > 0.55 && out.size() >= 3) {
      // finished: start + ≥1 data + checksum walked before the stop —
      // provided the trailing QUIET ZONE is real, which is what separates
      // a symbol boundary from a lucky match inside a longer code.
      double stop_end = pos + 13.5 * module;
      if (zone_quiet_vs(p, stop_end + 1.5 * module, stop_end + 4.5 * module,
                        pos, pos + 13 * module)) {
        *margin_out = weakest;
        *module_out = module;
        return wo;
      }
      // bars where the stop's quiet zone should be: this is not the stop,
      // it is a stop-shaped symbol mid-code — keep walking, don't abort.
    }
    if (std::getenv("SX2_DEBUG2"))
      std::fprintf(stderr, "        k=%d best=%.3f v=%d stop=%.3f pos=%.1f m=%.2f\n",
                   k, best, best_v, stop_s, pos, module);
    if (best < 0.45) return WalkOut{};     // signal lost
    weakest = std::min(weakest, best - runner);
    out.push_back(best_v);
    wo.margins.push_back(best - runner);
    wo.runners.push_back(runner_v);
    pos = best_pos + 11 * best_mod;
    module = 0.8 * module + 0.2 * best_mod;
  }
  return WalkOut{};
}

// Checksum repair: if the walk's symbols fail the checksum, swapping ONE
// low-margin symbol for its runner-up may satisfy it — and the checksum
// (1 in 103) then independently verifies the swap. Try the three weakest.
static bool checksum_ok(const std::vector<int>& vals);

static bool repair(WalkOut& wo) {
  if (wo.vals.size() < 3) return false;
  std::vector<size_t> idx;
  for (size_t i = 1; i + 1 < wo.vals.size(); i++) idx.push_back(i);
  std::sort(idx.begin(), idx.end(),
            [&](size_t a, size_t b) { return wo.margins[a] < wo.margins[b]; });
  for (size_t k = 0; k < idx.size() && k < 3; k++) {
    size_t i = idx[k];
    if (wo.runners[i] < 0 || wo.runners[i] > 102) continue;
    std::swap(wo.vals[i], wo.runners[i]);
    if (checksum_ok(wo.vals)) return true;
    std::swap(wo.vals[i], wo.runners[i]);
  }
  return false;
}

/* ── Code 128 semantics ───────────────────────────────────────────────────── */

static bool checksum_ok(const std::vector<int>& vals) {
  if (vals.size() < 3) return false;
  long ck = vals[0];
  for (size_t i = 1; i + 1 < vals.size(); i++) ck += long(i) * vals[i];
  return (ck % 103) == vals.back();
}

static bool semantics(const std::vector<int>& vals, char* text, int cap, int* chars) {
  int set = vals[0] - 103;                 // 0=A 1=B 2=C
  if (set < 0 || set > 2) return false;
  int n = 0;
  int shift = -1;
  for (size_t i = 1; i + 1 < vals.size(); i++) {
    int v = vals[i];
    int cur = (shift >= 0) ? shift : set;
    shift = -1;
    if (cur == 2) {                        // set C: pairs of digits
      if (v <= 99) {
        if (n + 2 >= cap) return false;
        text[n++] = char('0' + v / 10);
        text[n++] = char('0' + v % 10);
        continue;
      }
      if (v == 100) { set = 1; continue; }
      if (v == 101) { set = 0; continue; }
      if (v == 102) { continue; }          // FNC1
      return false;
    }
    // sets A and B
    if (v < 64) { if (n + 1 >= cap) return false; text[n++] = char(v + 32); continue; }
    if (cur == 1 && v < 96) { if (n + 1 >= cap) return false; text[n++] = char(v + 32); continue; }
    if (cur == 0 && v < 96) { if (n + 1 >= cap) return false; text[n++] = char(v - 64); continue; }
    if (v == 98) { shift = 1 - cur; continue; }
    if (v == 99) { set = 2; continue; }
    if (v == 100) { if (cur == 0) set = 1; continue; }   // Code B (or FNC4 in B)
    if (v == 101) { if (cur == 1) set = 0; continue; }
    if (v == 102) { continue; }            // FNC1
    if (v >= 96) { continue; }             // FNC2/3, unhandled controls
    return false;
  }
  text[n] = 0;
  *chars = n;
  // No real payload here contains control characters or is shorter than 4;
  // both are signatures of a low-margin walk that happened to checksum.
  if (n < 4) return false;
  for (int i = 0; i < n; i++) if ((unsigned char)text[i] < 0x20) return false;
  return true;
}

/* ── Code 39 ("3 of 9") ────────────────────────────────────────────────────
 * 9 elements per character (5 bars, 4 spaces), 3 of the 9 wide (=3 units),
 * summing to 15 modules. Reuses the same blurred-template matching
 * (pattern_at/score_banked) and quiet-zone evidence (zone_quiet_vs) as
 * Code 128 above -- only the element shape differs. Two real differences
 * from Code 128 drive the code below: characters are NOT packed edge to
 * edge (an inter-character gap, unconstrained by spec, separates them --
 * the position search window is widened to ±1 module to absorb it), and
 * the SAME '*' pattern is both start and stop, so there is one bank, not
 * a start-symbol trio plus a separate stop table. No mandatory checksum
 * exists for Code 39, so an internal margin floor (0.12, above Code 128's
 * externally-supplied min_margin) substitutes for the checksum's evidence
 * that would otherwise catch a wrong read.
 */
static constexpr double C39_WIDTH = 15.0;   // one character's 9 widths, summed
static constexpr int C39_NPTS = 51;         // spans [-1, +16) at TPL_STEP
static constexpr double C39_GAP = 1.0;      // assumed inter-character gap, modules

struct Bank39 {
  float sym[43][3][C39_NPTS];
  float symnorm[43][3];
  float star[3][C39_NPTS];
  float starnorm[3];
  Bank39() {
    for (int v = 0; v < 43; v++)
      for (int b = 0; b < 3; b++) {
        double nb = 0;
        for (int k = 0; k < C39_NPTS; k++) {
          double tp = pattern_at(CODE39[v], 9, TPL_MX0 + k * TPL_STEP, BLURS[b]);
          sym[v][b][k] = float(tp);
          nb += tp * tp;
        }
        symnorm[v][b] = float(std::sqrt(nb));
      }
    for (int b = 0; b < 3; b++) {
      double nb = 0;
      for (int k = 0; k < C39_NPTS; k++) {
        double tp = pattern_at(CODE39_STAR, 9, TPL_MX0 + k * TPL_STEP, BLURS[b]);
        star[b][k] = float(tp);
        nb += tp * tp;
      }
      starnorm[b] = float(std::sqrt(nb));
    }
  }
};
static const Bank39& bank39() { static Bank39 b; return b; }

static double score_symbol39(const std::vector<float>& p, double start,
                             double module, int value) {
  const Bank39& B = bank39();
  double best = -1e9;
  for (int b = 0; b < 3; b++) {
    double s = score_banked(p, start, module, B.sym[value][b], B.symnorm[value][b], C39_NPTS);
    if (s > best) best = s;
  }
  return best;
}

static double score_star39(const std::vector<float>& p, double start, double module) {
  const Bank39& B = bank39();
  double best = -1e9;
  for (int b = 0; b < 3; b++) {
    double s = score_banked(p, start, module, B.star[b], B.starnorm[b], C39_NPTS);
    if (s > best) best = s;
  }
  return best;
}

static double quick_star_score(const std::vector<float>& p, Seed sd) {
  return score_star39(p, sd.start, sd.module);
}

// Same shape as make_seeds, parameterised for a 9-element/15-module symbol
// instead of Code 128's 6-element/11-module start.
static void make_seeds39(const std::vector<double>& t, std::vector<Seed>& seeds) {
  seeds.clear();
  for (size_t i = 0; i + 9 < t.size(); i++) {
    double m = (t[i + 9] - t[i]) / C39_WIDTH;
    if (m >= 0.7 && m <= 24.0) seeds.push_back({t[i], m});
  }
  if (t.size() >= 10) {
    std::vector<double> gaps;
    for (size_t i = 1; i < t.size(); i++) gaps.push_back(t[i] - t[i - 1]);
    std::vector<double> tmp(gaps);
    size_t k = size_t(0.20 * (tmp.size() - 1));
    std::nth_element(tmp.begin(), tmp.begin() + k, tmp.end());
    double m = tmp[k];
    if (m >= 0.7 && m <= 24.0) {
      for (size_t i = 0; i + 1 < t.size(); i += 2) seeds.push_back({t[i], m});
    }
  }
}

// Decode one direction of one profile from one seed. Writes ASCII text
// directly (no intermediate value list -- Code 39 has no checksum
// semantics to defer). margin_out = weakest character's win over runner-up.
static bool walk39(const std::vector<float>& p, Seed seed, const Deadline& dl,
                   char* text_out, int cap, int* chars_out,
                   double* margin_out, double* module_out) {
  double module = seed.module;
  double pos = seed.start;

  double best_start = score_star39(p, pos, module);
  if (std::getenv("SX2_DEBUG2"))
    std::fprintf(stderr, "  c39 start@%.1f m=%.2f score=%.3f\n", pos, module, best_start);
  if (best_start < 0.55) return false;
  if (!zone_quiet_vs(p, pos - 4.5 * module, pos - 1.5 * module,
                     pos, pos + C39_WIDTH * module)) return false;

  for (double off = -0.6; off <= 0.6; off += 0.15) {
    double s = score_star39(p, pos + off * module, module);
    if (s > best_start) { best_start = s; pos = seed.start + off * module; }
  }
  pos += (C39_WIDTH + C39_GAP) * module;

  double weakest = 1.0;
  int n = 0;
  for (int k = 0; k < 40; k++) {
    if (dl.expired()) return false;
    double stop_s = -1e9;
    for (double off = -1.0; off <= 1.0; off += 0.2) {
      double s = score_star39(p, pos + off * module, module);
      if (s > stop_s) stop_s = s;
    }
    // Top-k refinement, same rationale as Code 128's walk(): the coarse
    // winner at the nominal (unrefined) position is not always the true
    // character once positions are allowed to shift with the gap.
    struct Cand39 { double s; int v; };
    Cand39 top[5]; int ntop = 0;
    for (int v = 0; v < 43; v++) {
      double sc = score_symbol39(p, pos, module, v);
      if (ntop < 5) {
        top[ntop++] = {sc, v};
        std::sort(top, top + ntop, [](const Cand39& a, const Cand39& b) { return a.s > b.s; });
      } else if (sc > top[4].s) {
        top[4] = {sc, v};
        std::sort(top, top + 5, [](const Cand39& a, const Cand39& b) { return a.s > b.s; });
      }
    }
    double best = -1e9, runner = -1e9, best_pos = pos, best_mod = module;
    int best_v = -1;
    for (int c = 0; c < ntop; c++) {
      double cb = -1e9, cb_pos = pos, cb_mod = module;
      for (double off = -1.0; off <= 1.0; off += 0.2) {
        for (double dm = -0.08; dm <= 0.08; dm += 0.04) {
          double sc = score_symbol39(p, pos + off * module, module * (1 + dm), top[c].v);
          if (sc > cb) { cb = sc; cb_pos = pos + off * module; cb_mod = module * (1 + dm); }
        }
      }
      if (cb > best) { runner = best; best = cb; best_v = top[c].v; best_pos = cb_pos; best_mod = cb_mod; }
      else if (cb > runner) runner = cb;
    }
    if (stop_s > best && stop_s > 0.55 && n >= 1) {
      double stop_end = pos + C39_WIDTH * module;   // approx.; refined below
      if (zone_quiet_vs(p, stop_end + 1.5 * module, stop_end + 4.5 * module,
                        pos, pos + C39_WIDTH * module)) {
        *margin_out = weakest;
        *module_out = module;
        *chars_out = n;
        text_out[n] = 0;
        return n >= 1;
      }
    }
    if (best < 0.45) return false;
    if (n + 1 >= cap) return false;
    text_out[n++] = CODE39_REF[best_v];
    weakest = std::min(weakest, best - runner);
    pos = best_pos + (C39_WIDTH + C39_GAP) * best_mod;
    module = 0.8 * module + 0.2 * best_mod;
  }
  return false;
}

/* ── the sweep driver ─────────────────────────────────────────────────────── */

struct Attempt {
  sx2_result res;
  bool better_than(const Attempt& o) const {
    if (res.ok != o.res.ok) return res.ok > o.res.ok;
    return res.margin > o.res.margin;
  }
};

// ── survey, then walk ─────────────────────────────────────────────────────
//
// The band a barcode lives in is not knowable in advance, and walking every
// band as it is met means band ORDER decides what the budget reaches — the
// failure mode where a frame times out with the true barcode never visited.
// So the sweep is two-phase: survey EVERY band with only the cheap banked
// start-screen (no walks), pool the candidates from the whole frame, then
// walk them globally in descending screen score. The true start's screen
// score (~0.9) outranks texture (~0.6-0.8), so it is walked first no matter
// which band it sits in.

struct Candidate {
  float score;
  Seed seed;
  int band_y;
  int bh;
  uint8_t rev;
  uint8_t rotated;
  std::vector<float> prof;   // normalised profile, direction applied
};

// pool39 may be null when a Code 128 phase already produced a confident
// read and the caller chose to skip Code 39 entirely (saves the extra
// per-band scoring pass).
static void survey_profile(const std::vector<float>& raw, int band_y, int bh,
                           bool rotated, std::vector<Candidate>& pool,
                           std::vector<Candidate>* pool39) {
  float contrast;
  std::vector<float> p;
  {
    std::vector<float> gated(raw);
    if (!band_gates(gated, &contrast)) return;
    normalise(gated, p);
  }
  for (int rev = 0; rev < 2; rev++) {
    std::vector<float> prof = p;
    if (rev) std::reverse(prof.begin(), prof.end());
    std::vector<double> t, t2;
    crossings(prof, t);
    crossings_raw(prof, t2);
    if (t.size() < 8 && t2.size() < 8) continue;

    auto collect = [&](auto make_seeds_fn, auto score_fn, std::vector<Candidate>& dst) {
      std::vector<Seed> ss;
      make_seeds_fn(t, ss);
      std::vector<Seed> extra;
      make_seeds_fn(t2, extra);
      ss.insert(ss.end(), extra.begin(), extra.end());

      struct Local { double sc; Seed sd; };
      Local top[3] = {{-1, {}}, {-1, {}}, {-1, {}}};
      for (const Seed& sd : ss) {
        double cs = score_fn(prof, sd);
        if (cs > top[2].sc) {
          top[2] = {cs, sd};
          if (top[2].sc > top[1].sc) std::swap(top[1], top[2]);
          if (top[1].sc > top[0].sc) std::swap(top[0], top[1]);
        }
      }
      for (const Local& L : top) {
        if (L.sc < 0.60) break;
        Candidate c;
        c.score = float(L.sc);
        c.seed = L.sd;
        c.band_y = band_y;
        c.bh = bh;
        c.rev = uint8_t(rev);
        c.rotated = rotated ? 1 : 0;
        c.prof = prof;           // copy; a candidate that survives is rare
        dst.push_back(std::move(c));
      }
    };

    collect(make_seeds, quick_start_score, pool);
    if (pool39) collect(make_seeds39, quick_star_score, *pool39);
  }
}

static void walk_candidate(const Candidate& c, const Deadline& dl,
                           double min_margin, Attempt& best) {
  const bool dbg = std::getenv("SX2_DEBUG") != nullptr;
  size_t deepest = 0;
  for (double mscale : {1.0, 1.25, 0.8}) {
    if (dl.expired()) return;
    if (mscale != 1.0 && deepest >= 4) break;
    Seed sd{c.seed.start, c.seed.module * mscale};
    double margin = 0, module = 0;
    WalkOut wo = walk(c.prof, sd, dl, &margin, &module);
    deepest = std::max(deepest, wo.vals.size());
    bool ck = !wo.vals.empty() && checksum_ok(wo.vals);
    bool repaired = false;
    if (!ck && !wo.vals.empty() && repair(wo)) {
      // A repair fixes exactly one symbol and lets the checksum verify the
      // swap — sound only when ONE symbol was wrong. Two conditions make it
      // evidence instead of coincidence: the swapped symbol was genuinely
      // ambiguous (a near-tie — its own margin under 0.04), and every other
      // symbol is individually solid (min 0.10) — a second hidden error
      // shows up as a second weak margin, and a checksum that still passes
      // then is 1-in-103 luck, which across thousands of walks does arrive:
      // it produced a real misread on the bench before these gates.
      std::vector<double> rest;
      for (size_t i = 1; i + 1 < wo.margins.size(); i++) rest.push_back(wo.margins[i]);
      std::sort(rest.begin(), rest.end());
      if (rest.size() > 1 && rest[0] < 0.04 && rest[1] >= 0.10) {
        ck = true; repaired = true;
        margin = rest[1];
      }
    }
    if (dbg && !wo.vals.empty())
      std::fprintf(stderr, "  walk y=%d rot=%d q=%.2f m=%.2f -> %zu syms%s%s\n",
                   c.band_y, c.rotated, c.score, sd.module, wo.vals.size(),
                   ck ? " CKOK" : " ckfail", repaired ? " (repaired)" : "");
    if (!ck) continue;
    Attempt a{};
    if (!semantics(wo.vals, a.res.text, sizeof(a.res.text), &a.res.chars)) continue;
    a.res.ok = margin >= min_margin ? 1 : 0;
    std::snprintf(a.res.format, sizeof(a.res.format), "Code128");
    a.res.margin = margin;
    a.res.module_px = module;
    a.res.band_y = c.band_y;
    a.res.rotated = c.rotated;
    a.res.reversed = c.rev;
    if (!a.res.ok)
      std::snprintf(a.res.failure, sizeof(a.res.failure),
                    "read below margin (%.3f)", margin);
    if (a.better_than(best)) best = a;
    return;                       // this candidate produced its answer
  }
}

// Code 39 counterpart of walk_candidate. No checksum exists to confirm a
// read, so an internal margin floor (0.12, tighter than a typical Code 128
// min_margin) stands in for the evidence a checksum would otherwise give.
static void walk_candidate39(const Candidate& c, const Deadline& dl,
                             double min_margin, Attempt& best) {
  const bool dbg = std::getenv("SX2_DEBUG") != nullptr;
  for (double mscale : {1.0, 1.25, 0.8}) {
    if (dl.expired()) return;
    Seed sd{c.seed.start, c.seed.module * mscale};
    char text[128];
    int chars = 0; double margin = 0, module = 0;
    bool okwalk = walk39(c.prof, sd, dl, text, sizeof(text), &chars, &margin, &module);
    if (dbg && okwalk)
      std::fprintf(stderr, "  c39 walk y=%d rot=%d q=%.2f m=%.2f -> \"%s\" margin=%.2f\n",
                   c.band_y, c.rotated, c.score, sd.module, text, margin);
    if (!okwalk || chars < 3 || margin < 0.12) continue;
    Attempt a{};
    std::memcpy(a.res.text, text, size_t(chars) + 1);
    a.res.chars = chars;
    a.res.ok = margin >= min_margin ? 1 : 0;
    std::snprintf(a.res.format, sizeof(a.res.format), "Code39");
    a.res.margin = margin;
    a.res.module_px = module;
    a.res.band_y = c.band_y;
    a.res.rotated = c.rotated;
    a.res.reversed = c.rev;
    if (!a.res.ok)
      std::snprintf(a.res.failure, sizeof(a.res.failure),
                    "read below margin (%.3f)", margin);
    if (a.better_than(best)) best = a;
    return;
  }
}

static void sweep(const uint8_t* g, int w, int h, bool rotated,
                  const Deadline& dl, double /*min_margin*/, Attempt& /*best*/,
                  std::vector<Candidate>& pool, std::vector<Candidate>* pool39) {
  // BAND PYRAMID: three heights with half-band overlap, because the corpus
  // has barcodes from 18 px to a third of the frame tall. Survey only —
  // walking happens globally afterwards.
  std::vector<float> prof;
  for (int div : {12, 24, 48, 96, 192}) {
    int bh = std::max(6, h / div);
    for (int y0 = 0; y0 + bh <= h; y0 += std::max(3, bh / 2)) {
      if (dl.expired()) return;
      band_profile(g, w, h, y0, y0 + bh, prof);
      survey_profile(prof, y0 + bh / 2, bh, rotated, pool, pool39);
    }
  }
}

}  // namespace scanx

/* ── C ABI ────────────────────────────────────────────────────────────────── */

extern "C" const char* sx2_version(void) { return "2.0.0-rebuild"; }

extern "C" sx2_result sx2_decode_gray(const uint8_t* gray, int w, int h,
                                      double min_margin, double budget_ms) {
  using namespace scanx;
  auto t0 = clock_t_::now();
  if (budget_ms <= 0) budget_ms = 2000;
  Deadline dl{t0 + std::chrono::milliseconds(long(budget_ms))};

  Attempt best{};
  best.res.band_y = -1;
  std::snprintf(best.res.failure, sizeof(best.res.failure), "no barcode found");

  // Phase 1 — survey both orientations completely (cheap; no walks).
  // Code 39 candidates are pooled in the same pass (survey_profile shares
  // the band_profile/gates/crossings work across symbologies).
  std::vector<Candidate> pool, pool39;
  sweep(gray, w, h, false, dl, min_margin, best, pool, &pool39);
  {
    std::vector<uint8_t> tr(size_t(w) * h);
    for (int y = 0; y < h; y++)
      for (int x = 0; x < w; x++)
        tr[size_t(x) * h + y] = gray[size_t(y) * w + x];
    if (!dl.expired()) sweep(tr.data(), h, w, true, dl, min_margin, best, pool, &pool39);
  }

  // Phase 2 — walk candidates from the whole frame, best screen score first.
  std::sort(pool.begin(), pool.end(),
            [](const Candidate& a, const Candidate& b) { return a.score > b.score; });
  {
    // Dedupe: the pyramid's overlapping bands rediscover the same start many
    // times; walking each copy re-buys the same failure.
    std::vector<Candidate> kept;
    std::vector<int> copies;
    for (auto& c : pool) {
      int seen = 0;
      for (size_t i = 0; i < kept.size(); i++) {
        const auto& k = kept[i];
        if (k.rotated == c.rotated && k.rev == c.rev
            && std::abs(k.band_y - c.band_y) <= std::max(k.bh, c.bh)
            && std::fabs(k.seed.start - c.seed.start) < 6.0
            && std::fabs(k.seed.module - c.seed.module) < 0.25 * k.seed.module)
          seen++;
      }
      // Keep up to three band variants of one start: the same barcode seen
      // through a straddling band and through a pure thin band are the same
      // "candidate" only in position — one of them decodes and one doesn't,
      // and the survey score cannot tell which.
      if (seen < 3) kept.push_back(std::move(c));
      if (kept.size() >= 72) break;
    }
    (void)copies;
    pool.swap(kept);
  }
  if (std::getenv("SX2_DEBUG"))
    for (size_t i = 0; i < pool.size() && i < 15; i++)
      std::fprintf(stderr, "cand[%zu] q=%.3f y=%d bh=%d rot=%d rev=%d m=%.2f\n",
                   i, pool[i].score, pool[i].band_y, pool[i].bh,
                   pool[i].rotated, pool[i].rev, pool[i].seed.module);
  for (const Candidate& c : pool) {
    if (dl.expired()) break;
    walk_candidate(c, dl, min_margin, best);
    if (best.res.ok && best.res.margin > 0.15) break;
  }

  // Code 39 phase — same survey-then-walk shape, run only when Code 128
  // did not already land a confident read (real labels are one symbology
  // or the other, and skipping this when it is not needed saves the time).
  if (!(best.res.ok && best.res.margin > 0.15) && !dl.expired()) {
    std::sort(pool39.begin(), pool39.end(),
              [](const Candidate& a, const Candidate& b) { return a.score > b.score; });
    std::vector<Candidate> kept39;
    for (auto& c : pool39) {
      int seen = 0;
      for (const auto& k : kept39) {
        if (k.rotated == c.rotated && k.rev == c.rev
            && std::abs(k.band_y - c.band_y) <= std::max(k.bh, c.bh)
            && std::fabs(k.seed.start - c.seed.start) < 6.0
            && std::fabs(k.seed.module - c.seed.module) < 0.25 * k.seed.module)
          seen++;
      }
      if (seen < 3) kept39.push_back(std::move(c));
      if (kept39.size() >= 72) break;
    }
    for (const Candidate& c : kept39) {
      if (dl.expired()) break;
      walk_candidate39(c, dl, min_margin, best);
      if (best.res.ok && best.res.margin > 0.15) break;
    }
  }

  best.res.timed_out = dl.expired() && !best.res.ok ? 1 : 0;
  if (best.res.timed_out)
    std::snprintf(best.res.failure, sizeof(best.res.failure),
                  "budget expired (%.0f ms)", budget_ms);
  best.res.ms = std::chrono::duration<double, std::milli>(clock_t_::now() - t0).count();
  return best.res;
}
