#!/usr/bin/env node
/** Benchmark the bundled Krea 2 workflow on several disposable RunPod Pods.
 *
 * Requires RUNPOD_KEY and optional HF_TOKEN/CIVITAI_TOKEN/GITHUB_TOKEN. Every
 * Pod is created without a volume and account-deleted in a finally block.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://rest.runpod.io/v1';
const IMAGE = process.env.RUNPOD_BENCH_IMAGE ?? 'ghcr.io/permissionbrick/comfyui-runpod-worker:cuda13-candidate';
const RUNS = Number(process.env.RUNPOD_BENCH_RUNS ?? 3);
const READY_TIMEOUT_MS = Number(process.env.RUNPOD_BENCH_READY_TIMEOUT_SECONDS ?? 2700) * 1000;
const key = process.env.RUNPOD_KEY ?? '';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const allCandidates = [
    { label: 'RTX 5090', id: 'NVIDIA GeForce RTX 5090', clouds: ['COMMUNITY', 'SECURE'] },
    { label: 'RTX 4090', id: 'NVIDIA GeForce RTX 4090', clouds: ['COMMUNITY', 'SECURE'] },
    { label: 'RTX A5000', id: 'NVIDIA RTX A5000', clouds: ['SECURE'] },
    { label: 'A40', id: 'NVIDIA A40', clouds: ['SECURE'] },
    { label: 'L40S', id: 'NVIDIA L40S', clouds: ['COMMUNITY', 'SECURE'] },
];
const requestedLabels = new Set(String(process.env.RUNPOD_BENCH_GPUS ?? '').split(',').map(value => value.trim()).filter(Boolean));
const secureOnly = process.env.RUNPOD_BENCH_SECURE_ONLY === '1';
const selectedCandidates = requestedLabels.size ? allCandidates.filter(candidate => requestedLabels.has(candidate.label)) : allCandidates;
const candidates = selectedCandidates.map(candidate => ({
    ...candidate,
    clouds: secureOnly ? ['SECURE'] : candidate.clouds,
}));

const files = [
    { dest: 'checkpoints/lustifyNSFWCheckpoint_v10Krea2.safetensors', url: 'https://civitai.com/api/download/models/3112728?fileId=2996235' },
    { dest: 'text_encoders/qwen3vl_4b_bf16.safetensors', url: 'https://huggingface.co/Comfy-Org/Krea-2/resolve/main/text_encoders/qwen3vl_4b_bf16.safetensors' },
    { dest: 'vae/qwen_image_vae.safetensors', url: 'https://huggingface.co/Comfy-Org/Krea-2/resolve/main/vae/qwen_image_vae.safetensors' },
    { dest: 'loras/krea2_turbo_4step_rank_64_lora_latest.safetensors', url: 'https://huggingface.co/lvladikov/Krea2-Turbo-Distill-4step-LoRA/resolve/main/krea2_turbo_4step_rank_64_lora_latest_comfyui.safetensors' },
];

function log(label, message) {
    console.log(`${new Date().toISOString()} [${label}] ${message}`);
}

async function api(method, route, body) {
    const response = await fetch(`${API}${route}`, {
        method,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${route}: HTTP ${response.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
}

function podUrl(id, port) {
    return `https://${id}-${port}.proxy.runpod.net`;
}

async function create(candidate) {
    let lastError;
    for (const cloudType of candidate.clouds) {
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const pod = await api('POST', '/pods', {
                    name: `krea2-bench-${candidate.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}`,
                    imageName: IMAGE,
                    gpuTypeIds: [candidate.id],
                    gpuCount: 1,
                    cloudType,
                    supportPublicIp: true,
                    containerDiskInGb: 80,
                    volumeInGb: 0,
                    ports: ['8188/http', '8189/http'],
                    allowedCudaVersions: ['13.0'],
                    env: {
                        HF_TOKEN: process.env.HF_TOKEN ?? '',
                        CIVITAI_TOKEN: process.env.CIVITAI_TOKEN ?? '',
                        GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? '',
                        MODEL_KEY: 'krea2-benchmark',
                        MODEL_MANIFEST: JSON.stringify(files),
                        RUNPOD_SELF_REAP_SECONDS: '3600',
                        RUNPOD_SELF_REAP_BOOT_GRACE_SECONDS: '3600',
                    },
                    dockerStartCmd: ['bash', '-c', '(python3 /model-manager.py &) ; (python3 /self-reaper.py &) ; python3 /boot-models.py && cd /comfyui && exec python main.py --listen 0.0.0.0 --port 8188 --use-pytorch-cross-attention'],
                });
                return { ...pod, requestedCloud: cloudType };
            } catch (error) {
                lastError = error;
                log(candidate.label, `${cloudType} create attempt ${attempt} failed: ${error.message}`);
                await sleep(10_000);
            }
        }
    }
    throw lastError;
}

async function waitReady(candidate, pod) {
    const started = Date.now();
    let lastProgress = '';
    while (Date.now() - started < READY_TIMEOUT_MS) {
        try {
            const response = await fetch(`${podUrl(pod.id, 8189)}/status`, { signal: AbortSignal.timeout(10_000) });
            if (response.ok) {
                const status = await response.json();
                const progress = JSON.stringify({ present: status.present?.length ?? 0, queued: status.queued?.length ?? 0, downloading: status.downloading ?? {} });
                if (progress !== lastProgress) {
                    log(candidate.label, `models ${progress}`);
                    lastProgress = progress;
                }
            }
        } catch { /* image/manager is still starting */ }
        try {
            const response = await fetch(`${podUrl(pod.id, 8188)}/system_stats`, { signal: AbortSignal.timeout(10_000) });
            if (response.ok) {
                await response.arrayBuffer();
                return (Date.now() - started) / 1000;
            }
        } catch { /* ComfyUI is still starting */ }
        await sleep(10_000);
    }
    throw new Error(`not ready after ${READY_TIMEOUT_MS / 1000}s`);
}

function workflow(seed) {
    const file = fileURLToPath(new URL('../examples/Krea2_Turbo_Managed_RunPod.json', import.meta.url));
    let text = fs.readFileSync(file, 'utf8');
    const values = {
        prompt: 'cinematic editorial portrait of an astronaut in a greenhouse, natural light, intricate foliage, realistic materials, high detail',
        negative_prompt: '',
        model: 'lustifyNSFWCheckpoint_v10Krea2.safetensors',
        text_encoder: 'qwen3vl_4b_bf16.safetensors',
        vae: 'qwen_image_vae.safetensors',
        lora: 'krea2_turbo_4step_rank_64_lora_latest.safetensors',
        lora_strength: 1,
        sampler: 'euler', scheduler: 'simple', steps: 4, scale: 1,
        denoise: 1, seed, width: 1920, height: 1088,
    };
    for (const [name, value] of Object.entries(values)) text = text.replaceAll(`"%${name}%"`, JSON.stringify(value));
    return JSON.parse(text);
}

async function generate(candidate, pod, seed) {
    const started = performance.now();
    const response = await fetch(`${podUrl(pod.id, 8188)}/prompt`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: workflow(seed) }), signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`prompt HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
    const promptId = (await response.json()).prompt_id;
    while (true) {
        const historyResponse = await fetch(`${podUrl(pod.id, 8188)}/history/${promptId}`, { signal: AbortSignal.timeout(30_000) });
        if (!historyResponse.ok) throw new Error(`history HTTP ${historyResponse.status}`);
        const item = (await historyResponse.json())[promptId];
        if (item) {
            if (item.status?.status_str === 'error') throw new Error(`generation failed: ${JSON.stringify(item.status)}`);
            const image = Object.values(item.outputs ?? {}).flatMap(output => output.images ?? [])[0];
            if (!image) throw new Error('generation completed without an image');
            const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder ?? '', type: image.type ?? 'output' });
            const imageResponse = await fetch(`${podUrl(pod.id, 8188)}/view?${query}`, { signal: AbortSignal.timeout(30_000) });
            if (!imageResponse.ok) throw new Error(`image HTTP ${imageResponse.status}`);
            await imageResponse.arrayBuffer();
            const seconds = (performance.now() - started) / 1000;
            log(candidate.label, `seed ${seed}: ${seconds.toFixed(2)}s`);
            return seconds;
        }
        await sleep(250);
    }
}

async function benchmark(candidate, livePods) {
    const result = { gpu: candidate.label, gpuId: candidate.id, status: 'failed', runs: [] };
    let pod;
    try {
        pod = await create(candidate);
        livePods.set(pod.id, candidate.label);
        Object.assign(result, { podId: pod.id, cloud: pod.requestedCloud, pricePerHour: pod.costPerHr ?? pod.adjustedCostPerHr ?? null });
        log(candidate.label, `created ${pod.id} on ${pod.requestedCloud}; $${result.pricePerHour ?? '?'}/hr`);
        result.coldStartSeconds = await waitReady(candidate, pod);
        log(candidate.label, `ready after ${result.coldStartSeconds.toFixed(1)}s`);
        for (let index = 0; index < RUNS; index++) result.runs.push(await generate(candidate, pod, 41000 + index));
        result.averageSeconds = result.runs.reduce((sum, value) => sum + value, 0) / result.runs.length;
        result.medianSeconds = [...result.runs].sort((a, b) => a - b)[Math.floor(result.runs.length / 2)];
        const warmRuns = result.runs.slice(1);
        result.warmAverageSeconds = warmRuns.length
            ? warmRuns.reduce((sum, value) => sum + value, 0) / warmRuns.length
            : result.averageSeconds;
        result.imagesPerDollar = result.pricePerHour ? 3600 / result.warmAverageSeconds / result.pricePerHour : null;
        result.status = 'ok';
    } catch (error) {
        result.error = error.message;
        log(candidate.label, `FAILED: ${error.message}`);
    } finally {
        if (pod?.id) {
            try {
                await api('DELETE', `/pods/${pod.id}`);
                livePods.delete(pod.id);
                log(candidate.label, `deleted ${pod.id}`);
            } catch (error) {
                log(candidate.label, `DELETE FAILED for ${pod.id}: ${error.message}`);
            }
        }
    }
    return result;
}

async function main() {
    if (!key) throw new Error('RUNPOD_KEY is required');
    const livePods = new Map();
    let results;
    try {
        results = await Promise.all(candidates.map(candidate => benchmark(candidate, livePods)));
    } finally {
        await Promise.all([...livePods].map(async ([id, label]) => {
            try {
                await api('DELETE', `/pods/${id}`);
                log(label, `deleted ${id}`);
            } catch (error) {
                log(label, `DELETE FAILED for ${id}: ${error.message}`);
            }
        }));
    }
    console.log(`BENCHMARK_RESULTS=${JSON.stringify(results)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => { console.error(error); process.exitCode = 1; });
}
