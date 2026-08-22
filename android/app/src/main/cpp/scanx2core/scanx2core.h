/**
 * scanx2core — clean-room rebuild of the ScanX grey-level Code 128 decoder.
 *
 * The original C++ was lost with its build sandbox (see
 * claude/scanified-sdk-architecture-report.md §0.2); this file is rebuilt
 * from the surviving algorithm documentation:
 *
 *   claude/scanx-core-build-log.md        — matched filter over raw luminance,
 *                                           blurred reference patterns, sub-pixel
 *                                           transition seeding, per-symbol tracking,
 *                                           merged-bar second seed
 *   claude/scanx-core-band-sweep.md       — whole-frame band sweep, contrast and
 *                                           roughness gates (both set inside
 *                                           measured gaps, not guessed)
 *   claude/scanx-core-detect-then-decode.md — orientation handling (v1 here covers
 *                                           horizontal + vertical; arbitrary tilt
 *                                           is documented future work)
 *
 * Two deliberate additions the lost engine did not have:
 *   · a hard wall-clock budget threaded through every search loop — the lack
 *     of one is what froze the app's Lab screens (see
 *     claude/scanx-core-freeze-root-cause-2026-08-22.md)
 *   · this header IS the C ABI seam the SDK architecture report calls for:
 *     a narrow create/decode/destroy interface over a luminance buffer.
 */
#pragma once
#include <cstdint>
#include <cstddef>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
  int ok;              /* 1 = checksum-valid read */
  char text[128];      /* decoded payload, NUL terminated */
  char format[16];     /* "Code128" */
  double margin;       /* weakest symbol's win over its runner-up, 0..1 */
  double module_px;    /* estimated narrow-bar width in source pixels */
  int chars;           /* payload length */
  int band_y;          /* centre row of the band that read it (-1 if none) */
  int rotated;         /* 1 = read from the transposed (vertical) sweep */
  int reversed;        /* 1 = read right-to-left */
  double ms;           /* wall time spent */
  int timed_out;       /* 1 = budget expired before the search finished */
  char failure[64];    /* human-readable reason when ok == 0 */
} sx2_result;

/**
 * Decode one grayscale frame.
 *  gray     8-bit luminance, row-major, stride = width
 *  budget_ms  hard wall-clock cap; <= 0 means 2000. The call RETURNS when it
 *             expires — this is the fix for the freeze, so it is not optional.
 *  min_margin reads below this confidence are reported as failures (0..1)
 */
sx2_result sx2_decode_gray(const uint8_t* gray, int width, int height,
                           double min_margin, double budget_ms);

const char* sx2_version(void);

#ifdef __cplusplus
}
#endif
