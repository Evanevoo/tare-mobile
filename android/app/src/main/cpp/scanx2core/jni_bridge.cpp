/**
 * JNI bridge for scanx2core -- the real ship path, not the Emscripten one.
 *
 * This runs the exact same decode.cpp compiled by the NDK's clang (native
 * ARM machine code), so the interpreted-JS speed problem documented in
 * claude/scanx2core-emscripten-perf-finding-2026-08-22.md does not apply
 * here at all: this is not JS, jitless or otherwise. The Emscripten build
 * stays what it was scoped to be -- a native-reference/CLI artifact -- and
 * is NOT part of this module.
 *
 * JNI naming: method names must exactly match
 *   Java_<package_with_underscores>_<ClassName>_<methodName>
 * for package com.evanevoo.scanifiedandroid.scanxcore, class ScanxCoreModule,
 * method nativeDecodeJson, that is:
 *   Java_com_evanevoo_scanifiedandroid_scanxcore_ScanxCoreModule_nativeDecodeJson
 *
 * Signature: (byte[] gray, int width, int height, double minMargin,
 * double budgetMs) -> String (JSON), matching the field set and escaping
 * emscripten/bridge.cpp already uses, so any JS-side JSON parsing code
 * written against that bridge works unchanged against this one.
 */
#include <jni.h>
#include <cstdio>
#include <cstring>
#include "scanx2core.h"

static void json_escape(const char* in, char* out, int out_cap) {
  int e = 0;
  for (const char* c = in; *c && e < out_cap - 8; c++) {
    if (*c == '"' || *c == '\\') { out[e++] = '\\'; out[e++] = *c; }
    else if ((unsigned char)*c < 0x20) {
      e += std::snprintf(out + e, 8, "\\u%04x", (unsigned char)*c);
    } else {
      out[e++] = *c;
    }
  }
  out[e] = 0;
}

extern "C"
JNIEXPORT jstring JNICALL
Java_com_evanevoo_scanifiedandroid_scanxcore_ScanxCoreModule_nativeDecodeJson(
    JNIEnv* env, jobject /*thiz*/,
    jbyteArray gray, jint width, jint height,
    jdouble minMargin, jdouble budgetMs) {

  jsize len = env->GetArrayLength(gray);
  jbyte* bytes = env->GetByteArrayElements(gray, nullptr);

  sx2_result r = sx2_decode_gray(
      reinterpret_cast<const uint8_t*>(bytes),
      (int)width, (int)height, (double)minMargin, (double)budgetMs);

  env->ReleaseByteArrayElements(gray, bytes, JNI_ABORT);
  (void)len;

  char text_esc[512];
  json_escape(r.text, text_esc, sizeof(text_esc));
  char fail_esc[96];
  json_escape(r.failure, fail_esc, sizeof(fail_esc));

  char json[768];
  std::snprintf(json, sizeof(json),
    "{\"ok\":%d,\"text\":\"%s\",\"format\":\"%s\",\"margin\":%.4f,"
    "\"module_px\":%.3f,\"chars\":%d,\"band_y\":%d,\"rotated\":%d,"
    "\"reversed\":%d,\"ms\":%.2f,\"timed_out\":%d,\"failure\":\"%s\"}",
    r.ok, text_esc, r.format, r.margin, r.module_px, r.chars, r.band_y,
    r.rotated, r.reversed, r.ms, r.timed_out, fail_esc);

  return env->NewStringUTF(json);
}

extern "C"
JNIEXPORT jstring JNICALL
Java_com_evanevoo_scanifiedandroid_scanxcore_ScanxCoreModule_nativeVersion(
    JNIEnv* env, jobject /*thiz*/) {
  return env->NewStringUTF(sx2_version());
}
