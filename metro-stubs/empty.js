/**
 * Stub for Node core modules ('path', 'fs') that core.js — the ScanX asm.js
 * decoder (src/scanx/core.js, Emscripten-generated) — references inside an
 * `if (ENVIRONMENT_IS_NODE)` branch. That branch never runs under Hermes/RN
 * (ENVIRONMENT_IS_NODE is false there), but Metro still statically resolves
 * every `require(...)` it sees regardless of which runtime branch it's in,
 * so the bundle fails to build without something here to resolve to.
 *
 * Safe to be empty: nothing in this object is ever called at runtime, only
 * resolved. See metro.config.js.
 */
module.exports = {};
