import assert from 'node:assert/strict';
import test from 'node:test';
import {
    COMFY_DEFAULT_SAMPLERS,
    COMFY_DEFAULT_SCHEDULERS,
    getColdRunpodOptions,
} from '../comfy-defaults.js';

test('provides canonical cold RunPod sampler and scheduler choices', () => {
    assert.equal(COMFY_DEFAULT_SAMPLERS.length, 44);
    assert.equal(COMFY_DEFAULT_SCHEDULERS.length, 9);
    assert.ok(COMFY_DEFAULT_SAMPLERS.includes('euler'));
    assert.ok(COMFY_DEFAULT_SAMPLERS.includes('dpmpp_2m'));
    assert.ok(COMFY_DEFAULT_SCHEDULERS.includes('normal'));
    assert.ok(COMFY_DEFAULT_SCHEDULERS.includes('karras'));
});

test('retains saved custom values without duplicating canonical values', () => {
    assert.deepEqual(getColdRunpodOptions(COMFY_DEFAULT_SCHEDULERS, ''), COMFY_DEFAULT_SCHEDULERS);
    assert.deepEqual(getColdRunpodOptions(COMFY_DEFAULT_SCHEDULERS, 'karras'), COMFY_DEFAULT_SCHEDULERS);
    assert.deepEqual(getColdRunpodOptions(COMFY_DEFAULT_SCHEDULERS, 'custom'), ['custom', ...COMFY_DEFAULT_SCHEDULERS]);
});
