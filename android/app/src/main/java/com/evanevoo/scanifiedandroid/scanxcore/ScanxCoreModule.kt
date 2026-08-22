package com.evanevoo.scanifiedandroid.scanxcore

import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import org.json.JSONObject

/**
 * Native bridge to scanx2core (see NEW SCANIFIED project docs,
 * claude/scanx-cpp-rebuild-2026-08-22.md and
 * claude/scanx2core-emscripten-perf-finding-2026-08-22.md for why this is
 * a compiled native module rather than a JS/WASM one: Hermes has no JIT
 * and no WebAssembly support, and this decoder's survey phase is too
 * arithmetic-heavy to run acceptably interpreted. Compiling it with the
 * NDK sidesteps that entirely -- this runs as real machine code, same as
 * the native CLI already measured at 300-1900 ms/frame on the real corpus.
 *
 * This is a classic ReactContextBaseJavaModule / ReactPackage, not a
 * TurboModule -- confirmed RN's New Architecture interop layer still
 * supports these (newArchEnabled=true in this project), so no codegen
 * step is required for this simple, single-call native surface.
 *
 * Classic bridge cannot share raw memory buffers, so the luma frame
 * crosses as a base64 string (JS side must hand-roll the encoding --
 * Hermes has neither Buffer nor btoa) and is decoded back to bytes here
 * before reaching JNI.
 */
class ScanxCoreModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  companion object {
    init {
      System.loadLibrary("scanxcore")
    }
  }

  override fun getName(): String = "ScanxCore"

  private external fun nativeDecodeJson(
      gray: ByteArray, width: Int, height: Int,
      minMargin: Double, budgetMs: Double
  ): String

  private external fun nativeVersion(): String

  @ReactMethod
  fun version(promise: Promise) {
    try {
      promise.resolve(nativeVersion())
    } catch (e: Exception) {
      promise.reject("scanxcore_version_error", e)
    }
  }

  /**
   * @param grayBase64 base64-encoded 8-bit luminance, row-major, stride = width
   */
  @ReactMethod
  fun decode(
      grayBase64: String,
      width: Int,
      height: Int,
      minMargin: Double,
      budgetMs: Double,
      promise: Promise
  ) {
    try {
      val gray = Base64.decode(grayBase64, Base64.NO_WRAP)
      val expected = width.toLong() * height.toLong()
      if (gray.size.toLong() != expected) {
        promise.reject(
            "scanxcore_bad_input",
            "decoded byte length ${gray.size} != width*height $expected"
        )
        return
      }
      val json = nativeDecodeJson(gray, width, height, minMargin, budgetMs)
      val obj = JSONObject(json)
      val map: WritableMap = Arguments.createMap()
      map.putBoolean("ok", obj.optInt("ok", 0) == 1)
      map.putString("text", obj.optString("text", ""))
      map.putString("format", obj.optString("format", ""))
      map.putDouble("margin", obj.optDouble("margin", 0.0))
      map.putDouble("modulePx", obj.optDouble("module_px", 0.0))
      map.putInt("chars", obj.optInt("chars", 0))
      map.putInt("bandY", obj.optInt("band_y", -1))
      map.putBoolean("rotated", obj.optInt("rotated", 0) == 1)
      map.putBoolean("reversed", obj.optInt("reversed", 0) == 1)
      map.putDouble("ms", obj.optDouble("ms", 0.0))
      map.putBoolean("timedOut", obj.optInt("timed_out", 0) == 1)
      map.putString("failure", obj.optString("failure", ""))
      promise.resolve(map)
    } catch (e: Exception) {
      promise.reject("scanxcore_decode_error", e)
    }
  }
}
