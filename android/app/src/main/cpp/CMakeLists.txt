# CMake build for the scanx2core native Android module.
#
# Referenced from android/app/build.gradle's externalNativeBuild block
# (path relative to that file: src/main/cpp/CMakeLists.txt). Produces
# libscanxcore.so, loaded from Kotlin via System.loadLibrary("scanxcore").
cmake_minimum_required(VERSION 3.22.1)
project(scanxcore)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_library(scanxcore SHARED
    scanx2core/decode.cpp
    scanx2core/jni_bridge.cpp
)

target_include_directories(scanxcore PRIVATE scanx2core)

# -O2 for both build types: this is a compute-bound correlation search,
# not something to leave at -O0/-Og even in a debug APK, or the on-device
# behaviour stops matching what was measured (300-1900 ms/frame at -O2
# on the real corpus, see README.md "Measured").
target_compile_options(scanxcore PRIVATE -O2 -Wall)

find_library(log-lib log)
target_link_libraries(scanxcore ${log-lib})
