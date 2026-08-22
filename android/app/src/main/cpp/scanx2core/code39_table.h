// Code 39 (Code 3 of 9) symbol patterns. Each character is 9 elements
// (bar,space,bar,space,bar,space,bar,space,bar), 3 of the 9 wide (=3),
// the other 6 narrow (=1) -- "3 of 9". No mandatory checksum. Unlike
// Code 128, characters are not packed edge-to-edge: an inter-character
// gap (one narrow space, not part of the symbol) separates them, and
// the same '*' pattern is both start and stop.
//
// Table sourced from the python-barcode project's own charset data
// (barcode.charsets.code39), independently verified here by rendering
// every character class through python-barcode and round-tripping the
// image through pyzbar -- a decoder with no code in common with the
// encoder -- confirming exact text match (22 Aug 2026).
#pragma once
#include <cstdint>
namespace scanx {
inline constexpr char CODE39_REF[43] = {
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 
  'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 
  'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 
  'U', 'V', 'W', 'X', 'Y', 'Z', '-', '.', ' ', '$', 
  '/', '+', '%', 
};
inline constexpr uint8_t CODE39[43][9] = {
  {1,1,1,3,3,1,3,1,1},  // 0
  {3,1,1,3,1,1,1,1,3},  // 1
  {1,1,3,3,1,1,1,1,3},  // 2
  {3,1,3,3,1,1,1,1,1},  // 3
  {1,1,1,3,3,1,1,1,3},  // 4
  {3,1,1,3,3,1,1,1,1},  // 5
  {1,1,3,3,3,1,1,1,1},  // 6
  {1,1,1,3,1,1,3,1,3},  // 7
  {3,1,1,3,1,1,3,1,1},  // 8
  {1,1,3,3,1,1,3,1,1},  // 9
  {3,1,1,1,1,3,1,1,3},  // A
  {1,1,3,1,1,3,1,1,3},  // B
  {3,1,3,1,1,3,1,1,1},  // C
  {1,1,1,1,3,3,1,1,3},  // D
  {3,1,1,1,3,3,1,1,1},  // E
  {1,1,3,1,3,3,1,1,1},  // F
  {1,1,1,1,1,3,3,1,3},  // G
  {3,1,1,1,1,3,3,1,1},  // H
  {1,1,3,1,1,3,3,1,1},  // I
  {1,1,1,1,3,3,3,1,1},  // J
  {3,1,1,1,1,1,1,3,3},  // K
  {1,1,3,1,1,1,1,3,3},  // L
  {3,1,3,1,1,1,1,3,1},  // M
  {1,1,1,1,3,1,1,3,3},  // N
  {3,1,1,1,3,1,1,3,1},  // O
  {1,1,3,1,3,1,1,3,1},  // P
  {1,1,1,1,1,1,3,3,3},  // Q
  {3,1,1,1,1,1,3,3,1},  // R
  {1,1,3,1,1,1,3,3,1},  // S
  {1,1,1,1,3,1,3,3,1},  // T
  {3,3,1,1,1,1,1,1,3},  // U
  {1,3,3,1,1,1,1,1,3},  // V
  {3,3,3,1,1,1,1,1,1},  // W
  {1,3,1,1,3,1,1,1,3},  // X
  {3,3,1,1,3,1,1,1,1},  // Y
  {1,3,3,1,3,1,1,1,1},  // Z
  {1,3,1,1,1,1,3,1,3},  // -
  {3,3,1,1,1,1,3,1,1},  // .
  {1,3,3,1,1,1,3,1,1},  // ' '
  {1,3,1,3,1,3,1,1,1},  // $
  {1,3,1,3,1,1,1,3,1},  // /
  {1,3,1,1,1,3,1,3,1},  // +
  {1,1,1,3,1,3,1,3,1},  // %
};
// Start/Stop character '*' -- same pattern used at both ends.
inline constexpr uint8_t CODE39_STAR[9] = {1,3,1,1,3,1,3,1,1};
}  // namespace scanx
