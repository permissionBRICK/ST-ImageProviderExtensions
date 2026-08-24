import express from 'express';
import fetch from 'node-fetch';

export const COMFY_METADATA_TIMEOUT_MS = 5000;
const SUPPORTED_KINDS = new Set(['ping', 'samplers', 'models', 'schedulers', 'vaes', 'loras']);
const apiRouter = express.Router();

function makeComfyUrl(baseUrl, endpoint) {
    const url = new URL(String(baseUrl ?? ''));
    if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error('ComfyUI URL must use HTTP or HTTPS');
    }
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/${endpoint}`;
    url.search = '';
    url.hash = '';
    return url;
}

function parseObjectInfo(kind, data) {
    switch (kind) {
        case 'samplers':
            return data.KSampler.input.required.sampler_name[0];
        case 'models': {
            const ckpts = (data.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] ?? [])
                .map(value => ({ value, text: value }));
            const unets = (data.UNETLoader?.input?.required?.unet_name?.[0] ?? [])
                .map(value => ({ value, text: `UNet: ${value}` }));
            const ggufs = (data.UnetLoaderGGUF?.input?.required?.unet_name?.[0] ?? [])
                .map(value => ({ value, text: `GGUF: ${value}` }));
            const models = [...ckpts, ...unets, ...ggufs];
            models.forEach(model => model.text = model.text.replace(/\.[^.]*$/, '').replace(/_/g, ' '));
            return models;
        }
        case 'schedulers':
            return data.KSampler.input.required.scheduler[0];
        case 'vaes':
            return data.VAELoader.input.required.vae_name[0];
        case 'loras':
            return data.LoraLoader?.input?.required?.lora_name?.[0] ?? [];
        default:
            throw new Error(`Unsupported ComfyUI metadata kind: ${kind}`);
    }
}

/**
 * Fetch a bounded ComfyUI status/metadata request for the browser extension.
 * @param {string} kind Metadata kind.
 * @param {string} baseUrl ComfyUI base URL.
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number}} options Test/runtime overrides.
 * @returns {Promise<true|unknown[]>} Parsed metadata, or true for a successful ping.
 */
export async function readComfyMetadata(kind, baseUrl, { fetchImpl = fetch, timeoutMs = COMFY_METADATA_TIMEOUT_MS } = {}) {
    if (!SUPPORTED_KINDS.has(kind)) {
        throw new Error(`Unsupported ComfyUI metadata kind: ${kind}`);
    }
    const endpoint = kind === 'ping' ? 'system_stats' : 'object_info';
    const response = await fetchImpl(makeComfyUrl(baseUrl, endpoint), {
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
        throw new Error(`ComfyUI returned HTTP ${response.status}`);
    }
    if (kind === 'ping') {
        return true;
    }
    return parseObjectInfo(kind, await response.json());
}

apiRouter.post('/comfy/:kind', async (request, response) => {
    try {
        const result = await readComfyMetadata(request.params.kind, request.body?.url);
        return request.params.kind === 'ping' ? response.sendStatus(200) : response.send(result);
    } catch (error) {
        console.error('[Image Provider Extensions] ComfyUI metadata request failed:', error?.message ?? error);
        return response.status(502).send({ error: String(error?.message ?? error) });
    }
});

apiRouter.get('/capabilities', (_request, response) => {
    response.send({ comfyMetadataProxy: true, timeoutMs: COMFY_METADATA_TIMEOUT_MS });
});

export async function init(router) {
    router.use(apiRouter);
}

export const info = {
    id: 'image-provider-extensions',
    name: 'Image Provider Extensions',
    description: 'Bounded ComfyUI metadata and LoRA discovery endpoints for ST-ImageProviderExtensions.',
};
