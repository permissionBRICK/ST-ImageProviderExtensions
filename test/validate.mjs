import assert from 'node:assert/strict';
import fs from 'node:fs';
const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url)));
assert.equal(manifest.generate_interceptor, 'SD_ProcessTriggers');
for (const file of [manifest.js, manifest.css, 'comfy-defaults.js', 'settings.html', 'button.html', 'dropdown.html', 'README.md', 'LICENSE', 'examples/Krea2_Turbo_Managed_RunPod.json', 'scripts/setup-krea2.mjs']) assert.ok(fs.existsSync(new URL(`../${file}`, import.meta.url)), file);
assert.ok(fs.existsSync(new URL('../server/index.mjs', import.meta.url)), 'server/index.mjs');

const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const settings = fs.readFileSync(new URL('../settings.html', import.meta.url), 'utf8');
const workflowEditor = fs.readFileSync(new URL('../comfyWorkflowEditor.html', import.meta.url), 'utf8');
for (const marker of ['runpodControl', 'resolveReferenceImageForGeneration', 'renderRunpodModels', 'renderCustomEntriesList', 'withConnectionProfile', 'TEMPORARY_CONNECTION_STARTED', 'LEGACY_IMAGE_PROMPT_PROFILE_MODULE', 'rememberImagePromptBeforeEdit', 'onImagePromptMessageEdited', 'sd_prompt_override', 'IMAGE_SWIPED']) {
    assert.ok(source.includes(marker), `missing custom image feature: ${marker}`);
}
for (const marker of ['COMFY_DEFAULT_SAMPLERS', 'COMFY_DEFAULT_SCHEDULERS', 'getColdRunpodOptions']) {
    assert.ok(source.includes(marker), `missing cold RunPod option fallback: ${marker}`);
}
for (const marker of ['sd_runpod_warmup', 'sd_ref_images_list', 'sd_lora_strength', 'sd_text_encoder', 'sd_custom_entry_add', 'sd_prompt_generation_profile']) {
    assert.ok(settings.includes(marker), `missing custom image setting: ${marker}`);
}
assert.ok(source.includes("third-party/ST-ImageProviderExtensions/comfyWorkflowEditor.html"));
assert.ok(source.includes("renderExtensionTemplateAsync('third-party/ST-ImageProviderExtensions'"));
assert.ok(!source.includes("renderExtensionTemplateAsync('stable-diffusion'"));
assert.ok(manifest.dependencies.includes('connection-manager'));
assert.ok(!source.includes('STImageGenerationHooks?.generatePrompt'), 'companion hook should be fully consolidated');
assert.ok(source.includes("'st-token-saver:temporary-connection-started'"), 'temporary profile switches must pause Token Saver without a core patch');
assert.ok(!source.includes('event_types.CONNECTION_PROFILE_TEMPORARY_STARTED'), 'must not require custom SillyTavern event constants');
assert.ok(source.includes("'/api/plugins/image-provider-extensions/comfy'"), 'ComfyUI metadata must use the bundled server plugin');
assert.ok(source.includes("'/api/plugins/image-provider-extensions/runpod'"), 'managed RunPod must use the bundled server plugin');
assert.ok(settings.includes('value="managed_runpod"'), 'managed RunPod must be a first-class ComfyUI server type');
assert.ok(!settings.includes('id="sd_runpod_lazy_url"'), 'stand-alone proxy URL control must be removed');
assert.ok(source.includes('`${COMFY_METADATA_API}/text_encoders`'), 'text encoders must use bundled metadata discovery');
assert.ok(source.includes("'text_encoder',"), 'ComfyUI generation must substitute the text encoder placeholder');
assert.ok(workflowEditor.includes('data-placeholder="text_encoder"'), 'workflow editor must indicate the text encoder placeholder');
assert.ok(!source.includes("'/api/sd/comfy/loras'"), 'LoRA discovery must not require a SillyTavern server patch');
