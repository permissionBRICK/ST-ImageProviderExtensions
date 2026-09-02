#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const WORKFLOW_NAME = 'Krea2_Turbo_Managed_RunPod.json';
export const PRESET_NAME = 'Managed RunPod — Krea 2 Turbo';

export const KREA_CATALOG = [
    {
        name: 'LUSTIFY v10 (Krea 2 Turbo, NSFW) fp8',
        value: 'lustifyNSFWCheckpoint_v10Krea2.safetensors',
        kind: 'model',
        downloads: [
            'checkpoints/lustifyNSFWCheckpoint_v10Krea2.safetensors https://civitai.com/api/download/models/3112728?fileId=2996235',
            'text_encoders/qwen3vl_4b_bf16.safetensors https://huggingface.co/Comfy-Org/Krea-2/resolve/main/text_encoders/qwen3vl_4b_bf16.safetensors',
            'vae/qwen_image_vae.safetensors https://huggingface.co/Comfy-Org/Krea-2/resolve/main/vae/qwen_image_vae.safetensors',
        ].join('\n'),
    },
    {
        name: 'Krea 2 Turbo 4-step LoRA (lvladikov)',
        value: 'krea2_turbo_4step_rank_64_lora_latest.safetensors',
        kind: 'lora',
        downloads: 'loras/krea2_turbo_4step_rank_64_lora_latest.safetensors https://huggingface.co/lvladikov/Krea2-Turbo-Distill-4step-LoRA/resolve/main/krea2_turbo_4step_rank_64_lora_latest_comfyui.safetensors',
    },
];

export const KREA_PRESET = {
    source: 'comfy',
    comfy_type: 'managed_runpod',
    comfy_url: '',
    comfy_workflow: WORKFLOW_NAME,
    model: 'lustifyNSFWCheckpoint_v10Krea2.safetensors',
    text_encoder: 'qwen3vl_4b_bf16.safetensors',
    vae: 'qwen_image_vae.safetensors',
    lora: 'krea2_turbo_4step_rank_64_lora_latest.safetensors',
    lora_strength: 1,
    sampler: 'euler',
    scheduler: 'simple',
    steps: 4,
    scale: 1,
    width: 1920,
    height: 1088,
    denoising_strength: 1,
};

/** Add/update the Krea catalog and preset in a parsed SillyTavern settings object. */
export function configureKrea2(settings, { activate = false } = {}) {
    settings.extension_settings ??= {};
    const sd = settings.extension_settings.sd ??= {};
    sd.runpod_gpu_profile = 'available';
    sd.runpod_models = Array.isArray(sd.runpod_models) ? sd.runpod_models : [];
    for (const entry of KREA_CATALOG) {
        const index = sd.runpod_models.findIndex(item => item?.value === entry.value);
        if (index >= 0) sd.runpod_models[index] = structuredClone(entry);
        else sd.runpod_models.push(structuredClone(entry));
    }

    sd.settings_preset_chain = Array.isArray(sd.settings_preset_chain) ? sd.settings_preset_chain : [];
    const presetEntry = { name: PRESET_NAME, preset: structuredClone(KREA_PRESET) };
    const presetIndex = sd.settings_preset_chain.findIndex(item => item?.name === PRESET_NAME
        || (item?.preset?.source === 'comfy'
            && item.preset.model === KREA_PRESET.model
            && item.preset.lora === KREA_PRESET.lora));
    if (presetIndex >= 0) sd.settings_preset_chain[presetIndex] = presetEntry;
    else sd.settings_preset_chain.push(presetEntry);
    sd.comfy_workflow_prefs ??= {};
    sd.comfy_workflow_prefs[WORKFLOW_NAME] = {
        model: KREA_PRESET.model,
        text_encoder: KREA_PRESET.text_encoder,
        lora: KREA_PRESET.lora,
    };
    if (activate) Object.assign(sd, structuredClone(KREA_PRESET));
    return settings;
}

function parseArgs(argv) {
    const args = { activate: false, dataDir: '' };
    for (let index = 0; index < argv.length; index++) {
        if (argv[index] === '--activate') args.activate = true;
        else if (argv[index] === '--data-dir') args.dataDir = argv[++index] ?? '';
        else throw new Error(`Unknown argument: ${argv[index]}`);
    }
    if (!args.dataDir) throw new Error('Usage: setup-krea2.mjs --data-dir <SillyTavern user data directory> [--activate]');
    return args;
}

export function installKrea2({ dataDir, activate = false }) {
    const settingsPath = path.join(dataDir, 'settings.json');
    const workflowsDir = path.join(dataDir, 'user', 'workflows');
    const sourceWorkflow = fileURLToPath(new URL(`../examples/${WORKFLOW_NAME}`, import.meta.url));
    if (!fs.existsSync(settingsPath)) throw new Error(`SillyTavern settings not found: ${settingsPath}`);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    configureKrea2(settings, { activate });
    fs.mkdirSync(workflowsDir, { recursive: true });
    fs.copyFileSync(sourceWorkflow, path.join(workflowsDir, WORKFLOW_NAME));
    const backupPath = `${settingsPath}.before-krea2-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(settingsPath, backupPath);
    fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 4)}\n`);
    return { settingsPath, backupPath, workflowPath: path.join(workflowsDir, WORKFLOW_NAME), activated: activate };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const result = installKrea2(parseArgs(process.argv.slice(2)));
        console.log(`Krea 2 setup complete: ${result.workflowPath}`);
        console.log(`${result.activated ? 'Activated' : 'Added'} preset: ${PRESET_NAME}`);
        console.log(`Settings backup: ${result.backupPath}`);
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
