import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { configureKrea2, KREA_CATALOG, KREA_PRESET, PRESET_NAME, WORKFLOW_NAME } from '../scripts/setup-krea2.mjs';

test('Krea setup adds an idempotent managed RunPod preset and model catalog', () => {
    const settings = { extension_settings: { sd: {
        source: 'openrouter',
        model: 'existing-model',
        runpod_models: [{ name: 'Keep me', value: 'other.safetensors', downloads: '' }],
        settings_preset_chain: [{ name: 'Keep me too', preset: { source: 'openai' } }],
    } } };
    configureKrea2(settings);
    configureKrea2(settings);

    const sd = settings.extension_settings.sd;
    assert.equal(sd.source, 'openrouter', 'setup is non-destructive unless --activate is used');
    assert.equal(sd.runpod_models.length, 1 + KREA_CATALOG.length);
    assert.equal(sd.settings_preset_chain.filter(item => item.name === PRESET_NAME).length, 1);
    assert.deepEqual(sd.settings_preset_chain.find(item => item.name === PRESET_NAME).preset, KREA_PRESET);
    assert.equal(sd.comfy_workflow_prefs[WORKFLOW_NAME].text_encoder, KREA_PRESET.text_encoder);
});

test('Krea setup can activate the managed RunPod configuration', () => {
    const settings = {};
    configureKrea2(settings, { activate: true });
    assert.equal(settings.extension_settings.sd.source, 'comfy');
    assert.equal(settings.extension_settings.sd.comfy_type, 'managed_runpod');
    assert.equal(settings.extension_settings.sd.comfy_workflow, WORKFLOW_NAME);
    assert.equal(settings.extension_settings.sd.steps, 4);
});

test('bundled Krea workflow is valid API JSON with all expected placeholders', () => {
    const workflow = fs.readFileSync(new URL(`../examples/${WORKFLOW_NAME}`, import.meta.url), 'utf8');
    assert.doesNotThrow(() => JSON.parse(workflow));
    for (const placeholder of ['prompt', 'negative_prompt', 'model', 'text_encoder', 'vae', 'lora', 'lora_strength', 'sampler', 'scheduler', 'steps', 'scale', 'denoise', 'seed', 'width', 'height']) {
        assert.match(workflow, new RegExp(`%${placeholder}%`));
    }
});
