import assert from 'node:assert/strict';
import fs from 'node:fs';
const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url)));
assert.equal(manifest.generate_interceptor, 'SD_ProcessTriggers');
for (const file of [manifest.js, manifest.css, 'settings.html', 'button.html', 'dropdown.html', 'README.md', 'LICENSE']) assert.ok(fs.existsSync(new URL(`../${file}`, import.meta.url)), file);

const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const settings = fs.readFileSync(new URL('../settings.html', import.meta.url), 'utf8');
for (const marker of ['runpodControl', 'resolveReferenceImageForGeneration', 'renderRunpodModels', 'renderCustomEntriesList', 'withConnectionProfile', 'CONNECTION_PROFILE_TEMPORARY_STARTED', 'LEGACY_IMAGE_PROMPT_PROFILE_MODULE', 'rememberImagePromptBeforeEdit', 'onImagePromptMessageEdited', 'sd_prompt_override', 'IMAGE_SWIPED']) {
    assert.ok(source.includes(marker), `missing custom image feature: ${marker}`);
}
for (const marker of ['sd_runpod_warmup', 'sd_ref_images_list', 'sd_lora_strength', 'sd_custom_entry_add', 'sd_prompt_generation_profile']) {
    assert.ok(settings.includes(marker), `missing custom image setting: ${marker}`);
}
assert.ok(source.includes("third-party/ST-ImageProviderExtensions/comfyWorkflowEditor.html"));
assert.ok(source.includes("renderExtensionTemplateAsync('third-party/ST-ImageProviderExtensions'"));
assert.ok(!source.includes("renderExtensionTemplateAsync('stable-diffusion'"));
assert.ok(manifest.dependencies.includes('connection-manager'));
assert.ok(!source.includes('STImageGenerationHooks?.generatePrompt'), 'companion hook should be fully consolidated');
