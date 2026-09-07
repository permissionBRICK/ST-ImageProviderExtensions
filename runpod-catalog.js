// Keep the workflow's local filename stable while pinning the renamed upstream
// ComfyUI weights. A revision pin survives further upstream file reorganizations.
export const KREA_LORA_URL = 'https://huggingface.co/lvladikov/Krea2-Turbo-Distill-4step-LoRA/resolve/e383f7a85d21d4c03c03a7347e018f9f9bf4046c/krea2_turbo_4step_rank_64_lora_comfyui.safetensors';
const RETIRED_KREA_LORA_URL = 'https://huggingface.co/lvladikov/Krea2-Turbo-Distill-4step-LoRA/resolve/main/krea2_turbo_4step_rank_64_lora_latest_comfyui.safetensors';

export function migrateRunpodDownloadUrl(url) {
    return url === RETIRED_KREA_LORA_URL ? KREA_LORA_URL : url;
}

export function migrateRunpodDownloads(downloads) {
    return typeof downloads === 'string'
        ? downloads.replace(/https?:\/\/\S+/g, migrateRunpodDownloadUrl)
        : downloads;
}
