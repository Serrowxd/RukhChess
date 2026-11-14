// test/gpu-name.test.mjs - the graphics adapter name shown in Settings > About (three/gpuName.js).
// Run from the app root:  node --test test/gpu-name.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cleanGpuName, readGpuName } from '../src/three/gpuName.js';

test('ANGLE renderer strings are cut down to the adapter name', () => {
  assert.equal(cleanGpuName('ANGLE (NVIDIA, NVIDIA GeForce RTX 5080 (0x00002C02) Direct3D11 vs_5_0 ps_5_0, D3D11)'), 'NVIDIA GeForce RTX 5080');
  assert.equal(cleanGpuName('ANGLE (AMD, AMD Radeon(TM) Graphics (0x000013C0) Direct3D11 vs_5_0 ps_5_0, D3D11)'), 'AMD Radeon(TM) Graphics');
  assert.equal(cleanGpuName('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)'), 'Intel(R) UHD Graphics 620');
  assert.equal(cleanGpuName('ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)'), 'Mesa Intel(R) UHD Graphics 620 (KBL GT2)');
  assert.equal(cleanGpuName('ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)'), 'Apple M1 Pro');
});

test('plain renderer strings are kept, minus the bus suffix', () => {
  assert.equal(cleanGpuName('NVIDIA GeForce GTX 980/PCIe/SSE2'), 'NVIDIA GeForce GTX 980');
  assert.equal(cleanGpuName('  Apple GPU  '), 'Apple GPU');
});

test('no name when the string is missing', () => {
  assert.equal(cleanGpuName(undefined), '');
  assert.equal(cleanGpuName(null), '');
  assert.equal(cleanGpuName(''), '');
  assert.equal(readGpuName(null), '');
  assert.equal(readGpuName({ getExtension: () => null, getParameter: () => 'x' }), '');
  assert.equal(readGpuName({ getExtension: () => { throw new Error('lost'); }, getParameter: () => 'x' }), '');
});

test('the name is read from the debug renderer extension', () => {
  const ext = { UNMASKED_RENDERER_WEBGL: 0x9246 };
  const gl = {
    getExtension: name => (name === 'WEBGL_debug_renderer_info' ? ext : null),
    getParameter: p => (p === 0x9246 ? 'ANGLE (NVIDIA, NVIDIA GeForce RTX 5080 (0x00002C02) Direct3D11 vs_5_0 ps_5_0, D3D11)' : null),
  };
  assert.equal(readGpuName(gl), 'NVIDIA GeForce RTX 5080');
});

test('ANGLE on Vulkan: the inner device name, without the PCI id or a doubled vendor', () => {
  assert.equal(cleanGpuName('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)'), 'SwiftShader Device (Subzero)');
  assert.equal(cleanGpuName('ANGLE (NVIDIA, Vulkan 1.3.277 (NVIDIA NVIDIA GeForce RTX 3080 (0x00002206)), NVIDIA-551.61.0.0)'), 'NVIDIA GeForce RTX 3080');
  assert.equal(cleanGpuName('ANGLE (AMD, Vulkan 1.3.260 (AMD Radeon RX 6800 (0x000073BF)), AMD open-source driver-2.0.279)'), 'AMD Radeon RX 6800');
});

test("Firefox's ', or similar' is kept after the cleaned name", () => {
  assert.equal(cleanGpuName('ANGLE (NVIDIA, NVIDIA GeForce GTX 980 Direct3D11 vs_5_0 ps_5_0), or similar'), 'NVIDIA GeForce GTX 980, or similar');
  assert.equal(cleanGpuName('GeForce GTX 980, or similar'), 'GeForce GTX 980, or similar');
});

test('other common forms', () => {
  assert.equal(cleanGpuName('Apple M2'), 'Apple M2');
  assert.equal(cleanGpuName('ANGLE (Intel(R) HD Graphics 4000 Direct3D11 vs_5_0 ps_5_0)'), 'Intel(R) HD Graphics 4000');
  assert.equal(cleanGpuName('ANGLE (Apple, Apple M1, OpenGL 4.1 Metal - 83.1)'), 'Apple M1');
  assert.equal(cleanGpuName(42), '');
  assert.equal(cleanGpuName({}), '');
});

test('placeholder strings that name no adapter give no name', () => {
  for (const raw of ['Mozilla', 'Generic Renderer', 'ANGLE (Unknown, Unknown, Unknown)', 'WebKit WebGL', 'Unknown, or similar']) {
    assert.equal(cleanGpuName(raw), '', raw);
  }
});

test('a very long run of whitespace is cleaned quickly and collapsed', () => {
  const started = Date.now();
  assert.equal(cleanGpuName(`NVIDIA GeForce RTX 5080${' '.repeat(100000)}(0x00002C02)x`), 'NVIDIA GeForce RTX 5080');
  assert.equal(cleanGpuName(`ANGLE (A, B${' '.repeat(100000)}Direct3D11 vs_5_0 ps_5_0, D3D11)`), 'B');
  assert.ok(Date.now() - started < 500, 'took too long');
});
