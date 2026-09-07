import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KREA_LORA_URL, migrateRunpodDownloads } from '../runpod-catalog.js';
import { RunpodManager } from '../server/runpod-manager.mjs';

const retired = 'https://huggingface.co/lvladikov/Krea2-Turbo-Distill-4step-LoRA/resolve/main/krea2_turbo_4step_rank_64_lora_latest_comfyui.safetensors';

test('saved catalog migration preserves filenames, custom URLs and unrelated downloads', () => {
    const custom = `${retired}?custom=1`;
    const before = `loras/saved-name.safetensors ${retired}\nloras/custom.safetensors ${custom}\nvae/model https://example.com/model`;
    const after = before.replace(retired, KREA_LORA_URL);
    assert.equal(migrateRunpodDownloads(before), after);
    assert.equal(migrateRunpodDownloads(after), after);
    assert.equal(migrateRunpodDownloads(undefined), undefined);
});

test('stale browser catalogs produce a corrected boot manifest without changing selections', async () => {
    let manifest;
    const manager = new RunpodManager({
        env: { RUNPOD_KEY: 'test-key' },
        fetchImpl: async (_url, options) => {
            manifest = JSON.parse(JSON.parse(options.body).env.MODEL_MANIFEST);
            return { ok: true, text: async () => JSON.stringify({ id: 'test-pod' }) };
        },
    });
    const files = [{ dest: 'loras/saved-name.safetensors', url: retired }, { dest: 'vae/custom', url: 'https://example.com/custom' }];
    manager.setCatalog({ active: ['saved-name'], models: [{ value: 'saved-name', files }] });
    await manager.createPod(manager.activeValues());
    assert.deepEqual(manifest, [{ ...files[0], url: KREA_LORA_URL }, files[1]]);
    assert.equal(files[0].url, retired, 'the caller catalog is not mutated');
});
