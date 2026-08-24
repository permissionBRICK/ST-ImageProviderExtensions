import express from 'express';
import fetch from 'node-fetch';

export const COMFY_METADATA_TIMEOUT_MS = 15000;
export const COMFY_METADATA_CACHE_TTL_MS = 30000;
const SUPPORTED_KINDS = new Set(['ping', 'samplers', 'models', 'schedulers', 'vaes', 'loras', 'text_encoders']);
const apiRouter = express.Router();
const objectInfoStores = new WeakMap();

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

function uniqueStrings(values) {
    return [...new Set(values.filter(value => typeof value === 'string' && value.length > 0))];
}

function getEnumValues(node, inputName) {
    const definition = node?.input?.required?.[inputName];
    const values = definition?.[0];
    if (Array.isArray(values)) {
        return values;
    }
    const comboOptions = definition?.[1]?.options;
    return values === 'COMBO' && Array.isArray(comboOptions) ? comboOptions : [];
}

function collectEnumValues(data, inputName, preferredNodes = []) {
    const preferred = preferredNodes.flatMap(nodeName => getEnumValues(data?.[nodeName], inputName));
    const discovered = Object.values(data ?? {}).flatMap(node => getEnumValues(node, inputName));
    return uniqueStrings([...preferred, ...discovered]);
}

function collectTextEncoderValues(data) {
    const values = [];
    for (const [nodeName, node] of Object.entries(data ?? {})) {
        if (!/(?:CLIP|TextEncoder).*Loader/i.test(nodeName) || /(?:Vision|Audio)/i.test(nodeName)) {
            continue;
        }
        for (const inputName of Object.keys(node?.input?.required ?? {})) {
            if (/^clip_name\d*$/i.test(inputName) || /^text_encoder(?:_name)?$/i.test(inputName)) {
                values.push(...getEnumValues(node, inputName));
            }
        }
    }
    return uniqueStrings(values);
}

function parseObjectInfo(kind, data) {
    switch (kind) {
        case 'samplers':
            return collectEnumValues(data, 'sampler_name', ['KSampler']);
        case 'models': {
            const ckpts = collectEnumValues(data, 'ckpt_name', ['CheckpointLoaderSimple'])
                .map(value => ({ value, text: value }));
            const unets = collectEnumValues(data, 'unet_name', ['UNETLoader'])
                .map(value => ({ value, text: `UNet: ${value}` }));
            const ggufs = getEnumValues(data?.UnetLoaderGGUF, 'unet_name')
                .map(value => ({ value, text: `GGUF: ${value}` }));
            const models = [...new Map([...ckpts, ...unets, ...ggufs].map(model => [model.value, model])).values()];
            models.forEach(model => model.text = model.text.replace(/\.[^.]*$/, '').replace(/_/g, ' '));
            return models;
        }
        case 'schedulers':
            return collectEnumValues(data, 'scheduler', ['KSampler']);
        case 'vaes':
            return collectEnumValues(data, 'vae_name', ['VAELoader']);
        case 'loras':
            return collectEnumValues(data, 'lora_name', ['LoraLoader']);
        case 'text_encoders':
            return collectTextEncoderValues(data);
        default:
            throw new Error(`Unsupported ComfyUI metadata kind: ${kind}`);
    }
}

function getObjectInfoStore(fetchImpl) {
    let store = objectInfoStores.get(fetchImpl);
    if (!store) {
        store = new Map();
        objectInfoStores.set(fetchImpl, store);
    }
    return store;
}

async function getObjectInfo(baseUrl, fetchImpl, timeoutMs, cacheTtlMs) {
    const url = makeComfyUrl(baseUrl, 'object_info').toString();
    const store = getObjectInfoStore(fetchImpl);
    const cached = store.get(url);
    if (cached?.data && cached.expiresAt > Date.now()) {
        return cached.data;
    }
    if (cached?.promise) {
        return cached.promise;
    }

    const promise = (async () => {
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
        if (!response.ok) {
            throw new Error(`ComfyUI returned HTTP ${response.status}`);
        }
        return response.json();
    })();
    store.set(url, { promise });

    try {
        const data = await promise;
        store.set(url, { data, expiresAt: Date.now() + cacheTtlMs });
        return data;
    } catch (error) {
        if (store.get(url)?.promise === promise) {
            store.delete(url);
        }
        throw error;
    }
}

/**
 * Fetch a bounded ComfyUI status/metadata request for the browser extension.
 * @param {string} kind Metadata kind.
 * @param {string} baseUrl ComfyUI base URL.
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number, cacheTtlMs?: number}} options Test/runtime overrides.
 * @returns {Promise<true|unknown[]>} Parsed metadata, or true for a successful ping.
 */
export async function readComfyMetadata(kind, baseUrl, {
    fetchImpl = fetch,
    timeoutMs = COMFY_METADATA_TIMEOUT_MS,
    cacheTtlMs = COMFY_METADATA_CACHE_TTL_MS,
} = {}) {
    if (!SUPPORTED_KINDS.has(kind)) {
        throw new Error(`Unsupported ComfyUI metadata kind: ${kind}`);
    }
    if (kind === 'ping') {
        const response = await fetchImpl(makeComfyUrl(baseUrl, 'system_stats'), {
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
            throw new Error(`ComfyUI returned HTTP ${response.status}`);
        }
        return true;
    }
    return parseObjectInfo(kind, await getObjectInfo(baseUrl, fetchImpl, timeoutMs, cacheTtlMs));
}

function publicErrorMessage(error) {
    const code = error?.cause?.code ?? error?.code;
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
        return `Timed out after ${COMFY_METADATA_TIMEOUT_MS / 1000} seconds while contacting ComfyUI`;
    }
    if (code === 'ECONNREFUSED') {
        return 'ComfyUI refused the connection; check its address and --listen setting';
    }
    if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
        return 'The SillyTavern server cannot reach the ComfyUI machine';
    }
    if (code === 'ENOTFOUND') {
        return 'The ComfyUI hostname could not be resolved';
    }
    return String(error?.message ?? error);
}

apiRouter.post('/comfy/:kind', async (request, response) => {
    try {
        const result = await readComfyMetadata(request.params.kind, request.body?.url);
        return request.params.kind === 'ping' ? response.sendStatus(200) : response.send(result);
    } catch (error) {
        console.error('[Image Provider Extensions] ComfyUI metadata request failed:', error?.message ?? error);
        return response.status(502).send({ error: publicErrorMessage(error) });
    }
});

apiRouter.get('/capabilities', (_request, response) => {
    response.send({
        comfyMetadataProxy: true,
        timeoutMs: COMFY_METADATA_TIMEOUT_MS,
        cacheTtlMs: COMFY_METADATA_CACHE_TTL_MS,
        coalescedObjectInfo: true,
        textEncoderDiscovery: true,
    });
});

export async function init(router) {
    router.use(apiRouter);
}

export const info = {
    id: 'image-provider-extensions',
    name: 'Image Provider Extensions',
    description: 'Bounded ComfyUI metadata and LoRA discovery endpoints for ST-ImageProviderExtensions.',
};
