import path from 'node:path';
import fetch from 'node-fetch';

const UA = 'Mozilla/5.0 (compatible; st-image-generation-runpod)';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const DEFAULT_AVAILABLE_GPU_TYPES = [
    'NVIDIA RTX A5000',
    'NVIDIA A40',
    'NVIDIA RTX A6000',
    'NVIDIA RTX A4000',
    'NVIDIA GeForce RTX 4090',
    'NVIDIA GeForce RTX 5090',
];

function csv(value, fallback = '') {
    return String(value ?? fallback).split(',').map(x => x.trim()).filter(Boolean);
}

function errorWithStatus(message, status = 500) {
    return Object.assign(new Error(message), { status });
}

/** Managed on-demand RunPod lifecycle for the Image Generation server plugin. */
export class RunpodManager {
    constructor({ env = process.env, fetchImpl = fetch, now = () => Date.now() } = {}) {
        this.env = env;
        this.fetch = fetchImpl;
        this.now = now;
        this.key = env.RUNPOD_KEY ?? '';
        this.idleMs = Number(env.RUNPOD_IDLE_SECONDS ?? 900) * 1000;
        this.keepaliveMs = Math.max(1000, Number(env.RUNPOD_KEEPALIVE_SECONDS ?? 60) * 1000);
        this.frontendLeaseMs = Math.max(1000, Number(env.RUNPOD_FRONTEND_LEASE_SECONDS ?? 300) * 1000);
        this.startTimeoutMs = Number(env.RUNPOD_START_TIMEOUT ?? 1500) * 1000;
        this.datacenters = csv(env.RUNPOD_DATACENTERS);
        this.cloudType = env.RUNPOD_CLOUD_TYPE ?? 'SECURE';
        this.image = env.RUNPOD_IMAGE ?? 'ghcr.io/permissionbrick/comfyui-runpod-worker:latest';
        const availableGpuTypes = csv(env.RUNPOD_GPU_AVAILABLE_TYPES, DEFAULT_AVAILABLE_GPU_TYPES.join(','));
        this.gpuProfiles = {
            a5000: {
                types: [env.RUNPOD_GPU_A5000_TYPE ?? 'NVIDIA RTX A5000'],
                priority: 'custom',
            },
            rtx5090: {
                types: [env.RUNPOD_GPU_5090_TYPE ?? 'NVIDIA GeForce RTX 5090'],
                priority: 'custom',
            },
            available: {
                types: availableGpuTypes.length ? availableGpuTypes : [...DEFAULT_AVAILABLE_GPU_TYPES],
                priority: 'availability',
            },
        };
        this.cudaVersions = csv(env.RUNPOD_CUDA_VERSIONS, '13.0');
        this.podName = env.RUNPOD_POD_NAME ?? 'comfyui-lazy';
        this.comfyArgs = env.RUNPOD_COMFY_ARGS ?? '--listen 0.0.0.0 --port 8188 --use-pytorch-cross-attention';
        this.selfReapSeconds = Number(env.RUNPOD_SELF_REAP_SECONDS ?? 1200);
        this.selfReapBootGraceSeconds = Number(env.RUNPOD_SELF_REAP_BOOT_GRACE_SECONDS ?? 2400);
        this.catalog = { models: [], active: [], gpuProfile: 'available' };
        this.state = {
            podId: null,
            model: null,
            phase: 'red',
            gpu: null,
            since: this.now() / 1000,
            last: this.now(),
            frontendLastSeen: null,
            keepaliveLast: null,
            ensuring: 0,
            activeRequests: 0,
            controlEpoch: 0,
            prefetchPod: null,
            ensurePromise: null,
        };
        this.timers = [];
    }

    get configured() {
        return Boolean(this.key);
    }

    log(...args) {
        console.log('[Image Generation / RunPod]', ...args);
    }

    requireConfigured() {
        if (!this.configured) {
            throw errorWithStatus('Managed RunPod is not configured on the SillyTavern server (RUNPOD_KEY is missing).', 503);
        }
    }

    async api(method, route, body) {
        this.requireConfigured();
        const response = await this.fetch(`https://rest.runpod.io/v1${route}`, {
            method,
            headers: {
                'Authorization': `Bearer ${this.key}`,
                'Content-Type': 'application/json',
                'User-Agent': UA,
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (!response.ok) {
            throw new Error(`RunPod ${method} ${route} returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
        }
        const text = await response.text();
        return text ? JSON.parse(text) : {};
    }

    activeValues() {
        const active = Array.isArray(this.catalog.active) ? this.catalog.active : [this.catalog.active];
        return active.filter(value => typeof value === 'string' && value);
    }

    valuesKey(values) {
        return [...(values ?? [])].sort().join('+');
    }

    keyValues(key) {
        return new Set(String(key ?? '').split('+').filter(Boolean));
    }

    catalogEntry(value) {
        return this.catalog.models.find(entry => entry?.value === value);
    }

    neededFiles(values) {
        return (values ?? []).flatMap(value => this.catalogEntry(value)?.files ?? []);
    }

    allCatalogFiles() {
        return this.catalog.models.flatMap(entry => entry?.files ?? []);
    }

    async findPod() {
        if (!this.configured) return [null, null, null];
        try {
            const pods = await this.api('GET', '/pods');
            const pod = pods.find(item => item.name === this.podName && item.desiredStatus === 'RUNNING');
            if (!pod) return [null, null, null];
            return [
                pod.id,
                pod.env?.MODEL_KEY ?? null,
                pod.machine?.gpuTypeId ?? pod.gpu?.displayName ?? pod.env?.REQUESTED_GPU_TYPE ?? null,
            ];
        } catch (error) {
            this.log('pod discovery failed:', error.message);
            return [null, null, null];
        }
    }

    podUrl(podId) {
        return `https://${podId}-8188.proxy.runpod.net`;
    }

    managerUrl(podId) {
        return `https://${podId}-8189.proxy.runpod.net`;
    }

    async createPod(values, datacenters) {
        const files = this.neededFiles(values);
        const requestedGpus = this.requestedGpus();
        const gpuPriority = this.requestedGpuPriority();
        const podEnv = {
            HF_TOKEN: this.env.HF_TOKEN ?? '',
            CIVITAI_TOKEN: this.env.CIVITAI_TOKEN ?? '',
            GITHUB_TOKEN: this.env.GITHUB_TOKEN ?? '',
            MODEL_KEY: this.valuesKey(values),
            RUNPOD_SELF_REAP_SECONDS: String(this.selfReapSeconds),
            RUNPOD_SELF_REAP_BOOT_GRACE_SECONDS: String(this.selfReapBootGraceSeconds),
            REQUESTED_GPU_PROFILE: this.catalog.gpuProfile,
            REQUESTED_GPU_TYPES: requestedGpus.join(','),
        };
        if (requestedGpus.length === 1) podEnv.REQUESTED_GPU_TYPE = requestedGpus[0];
        // RunPod's injected pod-scoped key cannot delete its own Pod, and the
        // public API cannot mint a per-Pod key. Pass the existing management
        // key only when the optional dead-man switch is enabled.
        if (this.selfReapSeconds > 0) podEnv.RUNPOD_TERMINATE_API_KEY = this.key;
        if (files.length) podEnv.MODEL_MANIFEST = JSON.stringify(files);
        else podEnv.MODELS = 'all';
        const body = {
            name: this.podName,
            imageName: this.image,
            gpuTypeIds: requestedGpus,
            gpuTypePriority: gpuPriority,
            gpuCount: 1,
            cloudType: this.cloudType,
            containerDiskInGb: 80,
            volumeInGb: 0,
            ports: ['8188/http', '8189/http'],
            env: podEnv,
            dockerStartCmd: ['bash', '-c', `(python3 /model-manager.py &) ; (python3 /self-reaper.py &) ; python3 /boot-models.py && cd /comfyui && exec python main.py ${this.comfyArgs}`],
        };
        if (datacenters?.length) body.dataCenterIds = datacenters;
        if (this.cudaVersions.length) body.allowedCudaVersions = this.cudaVersions;
        const pod = await this.api('POST', '/pods', body);
        this.log(`created pod ${pod.id} models=${podEnv.MODEL_KEY || 'legacy-all'} GPU=${pod.machine?.gpuTypeId ?? '?'} cost=${pod.costPerHr ?? '?'} per hour`);
        return [pod.id, pod.machine?.gpuTypeId ?? pod.gpu?.displayName ?? null];
    }

    async createPodWithRetries(values, epoch) {
        this.state.phase = 'orange';
        this.state.since = this.now() / 1000;
        const plans = this.datacenters.length ? [this.datacenters, this.datacenters, null] : [null, null, null];
        let lastError;
        for (const datacenters of plans) {
            if (epoch !== this.state.controlEpoch) throw new Error('pod warmup cancelled');
            try {
                const created = await this.createPod(values, datacenters);
                if (epoch !== this.state.controlEpoch) {
                    await this.terminate(created[0]);
                    throw new Error('pod warmup cancelled');
                }
                return created;
            } catch (error) {
                if (error.message === 'pod warmup cancelled') throw error;
                lastError = error;
                this.log('pod creation attempt failed:', error.message);
                await delay(5000);
            }
        }
        this.state.phase = 'red';
        throw new Error(`could not create pod: ${lastError?.message ?? 'unknown error'}`);
    }

    async managerRequest(podId, method, route, object, timeoutMs = 15000) {
        const response = await this.fetch(`${this.managerUrl(podId)}${route}`, {
            method,
            headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
            body: object === undefined ? undefined : JSON.stringify(object),
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) throw new Error(`model manager returned ${response.status}`);
        return response.json();
    }

    async touchPod(podId = this.state.podId) {
        if (!podId) return false;
        try {
            await this.managerRequest(podId, 'POST', '/activity', {}, 10000);
            return true;
        } catch {
            return false;
        }
    }

    async upstreamReady(podId) {
        try {
            const response = await this.fetch(`${this.podUrl(podId)}/system_stats`, {
                headers: { 'User-Agent': UA },
                signal: AbortSignal.timeout(5000),
            });
            if (response.ok) {
                await response.arrayBuffer();
                return true;
            }
        } catch { /* not ready */ }
        return false;
    }

    async terminate(podId) {
        if (!podId) return;
        try {
            await this.api('DELETE', `/pods/${podId}`);
            this.log(`terminated pod ${podId}`);
        } catch (error) {
            this.log(`could not terminate pod ${podId}:`, error.message);
            throw error;
        }
    }

    async prefetchRest(podId) {
        const files = this.allCatalogFiles();
        if (!files.length) return;
        try {
            const result = await this.managerRequest(podId, 'POST', '/ensure', { files }, 20000);
            if (result.queued?.length) this.log('background prefetch queued:', result.queued.join(', '));
        } catch { /* old worker image or pod disappeared */ }
    }

    async ensurePod(values = this.activeValues(), epoch = this.state.controlEpoch) {
        this.requireConfigured();
        const checkCancelled = () => {
            if (epoch !== this.state.controlEpoch) throw new Error('pod warmup cancelled');
        };
        const key = this.valuesKey(values);
        const files = this.neededFiles(values);
        const destinations = files.map(file => file.dest.replace(/^\/+/, ''));
        let [podId, have, gpu] = [this.state.podId, this.state.model, this.state.gpu];
        let created = false;
        checkCancelled();
        if (!podId) [podId, have, gpu] = await this.findPod();
        const requestedGpus = this.requestedGpus();
        if (podId && gpu && !requestedGpus.includes(gpu)) {
            this.log(`GPU profile changed (${gpu} -> ${requestedGpus.join(' | ')}); replacing ${podId}`);
            await this.terminate(podId);
            [podId, have, gpu] = [null, null, null];
        }
        if (!podId) {
            [podId, gpu] = await this.createPodWithRetries(values, epoch);
            have = key;
            created = true;
        }
        checkCancelled();
        Object.assign(this.state, { podId, model: have, gpu, last: this.now(), phase: this.state.phase === 'green' ? 'green' : 'orange' });
        let ensured = created || files.length === 0;
        let noManagerStrikes = 0;
        this.state.ensuring++;
        try {
            const deadline = this.now() + this.startTimeoutMs;
            while (this.now() < deadline) {
                checkCancelled();
                if (this.state.podId !== podId) throw new Error('pod replaced while waiting');
                this.state.last = this.now();
                if (!ensured) {
                    try {
                        await this.managerRequest(podId, 'POST', '/ensure', { files, priority: true });
                        ensured = true;
                        this.state.model = this.valuesKey(new Set([...this.keyValues(this.state.model), ...values]));
                        this.log(`in-place model ensure requested: ${key}`);
                    } catch { /* manager is still booting */ }
                }
                const ready = await this.upstreamReady(podId);
                let modelsOk = true;
                if (!created && files.length && ensured) {
                    try {
                        const manager = await this.managerRequest(podId, 'GET', '/status', undefined, 10000);
                        const errors = Object.fromEntries(Object.entries(manager.errors ?? {}).filter(([dest]) => destinations.includes(dest)));
                        if (Object.keys(errors).length) throw new Error(`model download failed: ${JSON.stringify(errors)}`);
                        modelsOk = destinations.every(dest => (manager.present ?? []).includes(dest));
                    } catch (error) {
                        if (error.message.startsWith('model download failed:')) throw error;
                        modelsOk = false;
                    }
                }
                if (ready && !ensured) noManagerStrikes++;
                if (noManagerStrikes >= 3 && key && this.state.model && this.state.model !== key) {
                    this.log(`old worker has models=${this.state.model}; recreating for ${key}`);
                    await this.terminate(podId);
                    [podId, gpu] = await this.createPodWithRetries(values, epoch);
                    Object.assign(this.state, { podId, model: key, gpu, last: this.now() });
                    created = ensured = true;
                    continue;
                }
                if (ready && modelsOk) {
                    checkCancelled();
                    this.state.phase = 'green';
                    this.state.since = this.now() / 1000;
                    await this.touchPod(podId);
                    if (this.state.prefetchPod !== podId) {
                        this.state.prefetchPod = podId;
                        void this.prefetchRest(podId);
                    }
                    this.log(`pod ready: ${podId}`);
                    return podId;
                }
                this.state.phase = 'orange';
                await delay(5000);
            }
            throw new Error('pod not ready within RUNPOD_START_TIMEOUT');
        } finally {
            this.state.ensuring--;
        }
    }

    setCatalog(payload = {}) {
        const active = Array.isArray(payload.active) ? payload.active : [payload.active];
        const gpuProfile = String(payload.gpu_profile ?? this.catalog.gpuProfile ?? 'available');
        if (!Object.hasOwn(this.gpuProfiles, gpuProfile)) {
            throw errorWithStatus(`Unknown managed RunPod GPU profile: ${gpuProfile}`, 400);
        }
        this.catalog = {
            models: Array.isArray(payload.models) ? payload.models : [],
            active: active.filter(value => typeof value === 'string' && value),
            gpuProfile,
        };
        this.log(`catalog updated: ${this.catalog.models.length} models; active=${this.catalog.active.join('+')}; GPU=${gpuProfile}`);
    }

    selectedGpuProfile() {
        return this.gpuProfiles[this.catalog.gpuProfile] ?? this.gpuProfiles.available;
    }

    requestedGpus() {
        return [...this.selectedGpuProfile().types];
    }

    requestedGpuPriority() {
        return this.selectedGpuProfile().priority;
    }

    requestedGpu() {
        return this.requestedGpus()[0];
    }

    warmup() {
        this.requireConfigured();
        if (!this.state.ensurePromise) {
            const epoch = this.state.controlEpoch;
            this.state.phase = this.state.phase === 'green' ? 'green' : 'orange';
            this.state.ensurePromise = this.ensurePod(this.activeValues(), epoch)
                .catch(error => {
                    this.log('warmup failed:', error.message);
                    if (epoch === this.state.controlEpoch) this.state.phase = 'red';
                })
                .finally(() => { this.state.ensurePromise = null; });
        }
    }

    async shutdown() {
        this.requireConfigured();
        this.state.controlEpoch++;
        const podId = this.state.podId ?? (await this.findPod())[0];
        if (podId) await this.terminate(podId);
        Object.assign(this.state, {
            podId: null, model: null, gpu: null, phase: 'red', since: this.now() / 1000,
            prefetchPod: null, frontendLastSeen: null,
        });
    }

    ping() {
        this.state.frontendLastSeen = this.now();
    }

    frontendLeaseLeft(now = this.now()) {
        if (this.state.frontendLastSeen === null) return 0;
        return Math.max(0, this.frontendLeaseMs - (now - this.state.frontendLastSeen));
    }

    async maintainKeepalive() {
        const now = this.now();
        const podId = this.state.podId;
        if (!podId || this.state.phase !== 'green' || this.state.ensuring || this.frontendLeaseLeft(now) <= 0) return false;
        if (!(await this.upstreamReady(podId))) return false;
        if (podId !== this.state.podId || this.frontendLeaseLeft(now) <= 0) return false;
        await this.touchPod(podId);
        this.state.last = now;
        this.state.keepaliveLast = now;
        return true;
    }

    async reapIdle() {
        if (this.state.activeRequests || this.state.ensuring || this.frontendLeaseLeft() > 0) return;
        if (this.now() - this.state.last <= this.idleMs) return;
        const podId = this.state.podId ?? (await this.findPod())[0];
        if (podId) {
            this.log(`idle for ${Math.round((this.now() - this.state.last) / 1000)}s; terminating ${podId}`);
            await this.terminate(podId);
        }
        Object.assign(this.state, { podId: null, model: null, gpu: null, phase: 'red', since: this.now() / 1000, prefetchPod: null });
    }

    async status({ probe = true } = {}) {
        if (!this.configured) return { configured: false, state: 'red', error: 'RUNPOD_KEY is missing' };
        if (probe && !this.state.ensuring) {
            if (this.state.podId) {
                if (await this.upstreamReady(this.state.podId)) this.state.phase = 'green';
                else {
                    const [found, model, gpu] = await this.findPod();
                    if (found) Object.assign(this.state, { podId: found, model, gpu, phase: 'orange' });
                    else Object.assign(this.state, { podId: null, model: null, gpu: null, phase: 'red' });
                }
            } else {
                const [found, model, gpu] = await this.findPod();
                if (found) Object.assign(this.state, { podId: found, model, gpu, phase: await this.upstreamReady(found) ? 'green' : 'orange' });
            }
        }
        return {
            configured: true,
            state: this.state.phase,
            pod_id: this.state.podId,
            model: this.state.model,
            active: this.activeValues(),
            gpu: this.state.gpu,
            since: this.state.since,
            url: this.state.podId ? this.podUrl(this.state.podId) : null,
            idle_seconds_left: this.state.podId ? Math.max(0, Math.ceil((this.idleMs - (this.now() - this.state.last)) / 1000)) : 0,
            frontend_lease_seconds_left: Math.ceil(this.frontendLeaseLeft() / 1000),
            keepalive_active: Boolean(this.state.podId && this.state.phase === 'green' && this.frontendLeaseLeft() > 0),
            self_reaper_seconds: this.selfReapSeconds,
            self_reaper_configured: this.selfReapSeconds > 0,
            gpu_profile: this.catalog.gpuProfile,
            requested_gpu: this.requestedGpu(),
            requested_gpus: this.requestedGpus(),
            gpu_type_priority: this.requestedGpuPriority(),
        };
    }

    async generate(promptText, signal) {
        const podId = this.state.podId;
        if (!podId || this.state.phase !== 'green' || !(await this.upstreamReady(podId))) {
            throw errorWithStatus('Managed RunPod is not ready. Start it with the Warm up control.', 503);
        }
        this.state.activeRequests++;
        this.state.last = this.now();
        let pulseAt = 0;
        const pulse = async () => {
            this.state.last = this.now();
            if (this.now() - pulseAt >= this.keepaliveMs) {
                pulseAt = this.now();
                await this.touchPod(podId);
            }
        };
        try {
            await pulse();
            const promptResponse = await this.fetch(`${this.podUrl(podId)}/prompt`, {
                method: 'POST', body: promptText, headers: { 'Content-Type': 'application/json', 'User-Agent': UA }, signal,
            });
            if (!promptResponse.ok) throw new Error(`ComfyUI prompt failed: ${(await promptResponse.text()).slice(0, 500)}`);
            const id = (await promptResponse.json()).prompt_id;
            let item;
            while (!item) {
                if (signal?.aborted) throw signal.reason ?? new Error('generation aborted');
                await pulse();
                const historyResponse = await this.fetch(`${this.podUrl(podId)}/history`, { headers: { 'User-Agent': UA }, signal });
                if (!historyResponse.ok) throw new Error(`ComfyUI history returned ${historyResponse.status}`);
                item = (await historyResponse.json())[id];
                if (!item) await delay(250);
            }
            if (item.status?.status_str === 'error') throw new Error('ComfyUI generation failed');
            const outputs = Object.values(item.outputs ?? {});
            const image = outputs.flatMap(output => output.images ?? output.gifs ?? [])[0];
            if (!image) throw new Error('ComfyUI returned no image');
            const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder ?? '', type: image.type ?? 'output' });
            const imageResponse = await this.fetch(`${this.podUrl(podId)}/view?${query}`, { headers: { 'User-Agent': UA }, signal });
            if (!imageResponse.ok) throw new Error(`ComfyUI image fetch returned ${imageResponse.status}`);
            return {
                format: path.extname(image.filename).slice(1).toLowerCase() || 'png',
                data: Buffer.from(await imageResponse.arrayBuffer()).toString('base64'),
            };
        } finally {
            this.state.activeRequests--;
            this.state.last = this.now();
            void this.touchPod(podId);
        }
    }

    async start() {
        if (!this.configured) {
            this.log('disabled: RUNPOD_KEY is not configured');
            return;
        }
        const [podId, model, gpu] = await this.findPod();
        if (podId) {
            Object.assign(this.state, { podId, model, gpu, phase: 'orange', last: this.now() });
            this.log(`adopted existing pod ${podId}`);
        }
        this.timers.push(setInterval(() => void this.reapIdle().catch(error => this.log('idle reaper failed:', error.message)), 30000));
        this.timers.push(setInterval(() => void this.maintainKeepalive().catch(error => this.log('keepalive failed:', error.message)), this.keepaliveMs));
        this.timers.forEach(timer => timer.unref?.());
    }

    stop() {
        this.timers.forEach(clearInterval);
        this.timers = [];
    }
}

export { errorWithStatus };
