import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { RunpodManager } from '../server/runpod-manager.mjs';
import { BootGuard } from '../server/runpod-boot-guard.mjs';

const API = 'https://api.runpod.io/v2';
const GPU_4090 = 'NVIDIA GeForce RTX 4090';
const NO_CAPACITY_BODY = {
    detail: 'There are no longer any instances available with the requested specifications. Please refresh and try again.',
    status: 400,
    title: 'Bad Request',
};

function response(body = {}, status = 200, headers = {}) {
    const text = body === null ? '' : JSON.stringify(body);
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: name => headers[name.toLowerCase()] ?? null },
        text: async () => text,
        json: async () => body ?? {},
        arrayBuffer: async () => Buffer.from(text),
    };
}

test('managed Pod creation passes the management key only as the self-reaper credential', async () => {
    const requests = [];
    const manager = new RunpodManager({
        env: {
            RUNPOD_KEY: 'account-secret',
            HF_TOKEN: 'hf-secret',
            RUNPOD_SELF_REAP_SECONDS: '1200',
            RUNPOD_SELF_REAP_BOOT_GRACE_SECONDS: '2400',
        },
        fetchImpl: async (url, options) => {
            requests.push({ url, options });
            return response({ id: 'pod-123', name: 'comfyui-lazy', status: 'PROVISIONING', gpu: { id: 'NVIDIA RTX A5000', count: 1 }, dataCenterId: 'EU-RO-1', cost: 0.27 });
        },
    });
    manager.setCatalog({
        active: ['model.gguf'],
        models: [{ value: 'model.gguf', files: [{ dest: 'unet/model.gguf', url: 'https://example/model' }] }],
        gpu_profile: 'a5000',
    });

    assert.deepEqual(await manager.createPod(manager.activeValues()), ['pod-123', 'NVIDIA RTX A5000']);
    assert.deepEqual(manager.pods.get('pod-123'), { created: manager.pods.get('pod-123').created, gpu: 'NVIDIA RTX A5000', dataCenter: 'EU-RO-1' });
    const request = requests[0];
    const body = JSON.parse(request.options.body);
    assert.equal(request.url, `${API}/pods`);
    assert.equal(request.options.method, 'POST');
    assert.equal(request.options.headers.Authorization, 'Bearer account-secret');
    assert.equal(body.env.HF_TOKEN, 'hf-secret');
    assert.equal(body.env.RUNPOD_SELF_REAP_SECONDS, '1200');
    assert.equal(body.env.RUNPOD_SELF_REAP_BOOT_GRACE_SECONDS, '2400');
    assert.equal(body.env.RUNPOD_TERMINATE_API_KEY, 'account-secret');
    assert.equal(body.env.RUNPOD_KEY, undefined);
    assert.equal(body.env.RUNPOD_API_KEY, undefined, 'RunPod injects the pod-scoped key itself');
    assert.deepEqual(body.gpu, { id: 'NVIDIA RTX A5000', count: 1, allowedCudaVersions: ['13.0'] });
    assert.equal(body.name, 'comfyui-lazy');
    assert.equal(body.image, 'ghcr.io/permissionbrick/comfyui-runpod-worker:latest');
    assert.equal(body.cloud, 'SECURE');
    assert.equal(body.disk, 80);
    assert.deepEqual(body.ports, ['8188/http', '8189/http']);
    assert.equal(body.dataCenterIds, undefined);
    for (const field of ['imageName', 'gpuTypeIds', 'gpuTypePriority', 'gpuCount', 'cloudType', 'containerDiskInGb', 'volumeInGb', 'dockerStartCmd', 'minDownloadMbps', 'allowedCudaVersions']) {
        assert.equal(body[field], undefined, `REST v1 field ${field} must not be sent`);
    }
    assert.equal(body.env.REQUESTED_GPU_TYPE, 'NVIDIA RTX A5000');
    assert.equal(body.env.REQUESTED_GPU_PROFILE, 'a5000');
    assert.equal(body.env.REQUESTED_GPU_TYPES, 'NVIDIA RTX A5000');
    assert.equal(body.env.RUNPOD_API_BASE, API, 'older worker images default their self-reaper to REST v1');
    assert.match(body.cmd[2], /self-reaper\.py/);
});

test('disabling pod-local self-reaping keeps the management key out of the Pod', async () => {
    const requests = [];
    const manager = new RunpodManager({
        env: { RUNPOD_KEY: 'account-secret', RUNPOD_SELF_REAP_SECONDS: '0' },
        fetchImpl: async (url, options) => {
            requests.push({ url, options });
            return response({ id: 'pod-123', status: 'PROVISIONING', gpu: { id: GPU_4090, count: 1 } });
        },
    });

    await manager.createPod([]);
    const body = JSON.parse(requests[0].options.body);
    assert.equal(body.env.RUNPOD_SELF_REAP_SECONDS, '0');
    assert.equal(body.env.RUNPOD_TERMINATE_API_KEY, undefined);
    const status = await manager.status({ probe: false });
    assert.equal(status.self_reaper_configured, false);
    assert.equal(status.self_reaper_seconds, 0);
});

test('server watchdog fully deletes a Pod after its idle deadline', async () => {
    let now = 1_000_000;
    const requests = [];
    const manager = new RunpodManager({
        env: { RUNPOD_KEY: 'account-secret', RUNPOD_IDLE_SECONDS: '900' },
        now: () => now,
        fetchImpl: async (url, options) => {
            requests.push({ url, options });
            return response(null, 204);
        },
    });
    Object.assign(manager.state, { podId: 'pod-idle', phase: 'green', last: now });

    now += 899_000;
    await manager.reapIdle();
    assert.equal(requests.length, 0);

    now += 2_000;
    await manager.reapIdle();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, `${API}/pods/pod-idle`);
    assert.equal(requests[0].options.method, 'DELETE');
    assert.equal(manager.state.podId, null);
    assert.equal(manager.state.phase, 'red');
});

test('GPU profiles request an exact card and reject unknown profile IDs', async () => {
    const requests = [];
    const manager = new RunpodManager({
        env: { RUNPOD_KEY: 'account-secret' },
        fetchImpl: async (url, options) => {
            requests.push({ url, options });
            return response({ id: 'pod-exact', gpu: { id: JSON.parse(options.body).gpu.id, count: 1 } });
        },
    });
    for (const [profile, gpu] of [['rtx4090', 'NVIDIA GeForce RTX 4090'], ['rtx5090', 'NVIDIA GeForce RTX 5090']]) {
        requests.length = 0;
        manager.setCatalog({ gpu_profile: profile });
        assert.deepEqual(await manager.createPod([]), ['pod-exact', gpu]);
        const body = JSON.parse(requests[0].options.body);
        assert.equal(body.gpu.id, gpu);
        assert.equal(body.gpu.count, 1);
        assert.equal(body.env.REQUESTED_GPU_TYPE, gpu);
        assert.equal(body.env.REQUESTED_GPU_TYPES, gpu);
        assert.equal(body.env.REQUESTED_GPU_PROFILE, profile);
    }
    assert.throws(() => manager.setCatalog({ gpu_profile: 'h100' }), error => error.status === 400);
});

const DEFAULT_POOL = ['NVIDIA GeForce RTX 4090', 'NVIDIA A40', 'NVIDIA GeForce RTX 5090', 'NVIDIA RTX A5000'];

test('Available GPU profile creates one GPU type per request, starting with the first pool entry', async () => {
    const requests = [];
    const manager = new RunpodManager({
        env: { RUNPOD_KEY: 'account-secret' },
        fetchImpl: async (url, options) => {
            requests.push({ url, options });
            return response({ id: 'pod-available', gpu: { id: JSON.parse(options.body).gpu.id, count: 1 } });
        },
    });
    assert.equal(manager.catalog.gpuProfile, 'available', 'Available must be the server default before catalog sync');

    assert.deepEqual(await manager.createPod([]), ['pod-available', GPU_4090]);
    const body = JSON.parse(requests[0].options.body);
    assert.equal(body.gpu.id, GPU_4090);
    assert.equal(body.env.REQUESTED_GPU_PROFILE, 'available');
    assert.equal(body.env.REQUESTED_GPU_TYPES, DEFAULT_POOL.join(','));
    assert.equal(body.env.REQUESTED_GPU_TYPE, GPU_4090);

    requests.length = 0;
    assert.deepEqual(await manager.createPod([], null, 'NVIDIA A40'), ['pod-available', 'NVIDIA A40']);
    const second = JSON.parse(requests[0].options.body);
    assert.equal(second.gpu.id, 'NVIDIA A40');
    assert.equal(second.env.REQUESTED_GPU_TYPE, 'NVIDIA A40', 'the env hint names the type actually requested');

    const status = await manager.status({ probe: false });
    assert.deepEqual(status.requested_gpus, DEFAULT_POOL);
    assert.equal(status.requested_gpu, GPU_4090);
    assert.equal(status.gpu_type_priority, undefined);
});

test('default Available profile tries RTX 4090 -> A40 -> RTX 5090 -> RTX A5000 on no-capacity', async () => {
    const bodies = [];
    const waits = [];
    const manager = new RunpodManager({
        env: { RUNPOD_KEY: 'test-key' },
        sleep: async ms => waits.push(ms),
        fetchImpl: async (url, options) => {
            bodies.push(JSON.parse(options.body));
            return response(NO_CAPACITY_BODY, 400);
        },
    });
    manager.log = () => {};
    await assert.rejects(manager.createPodWithRetries([], 0), /could not create pod:.*400.*no longer any instances/);
    assert.deepEqual(bodies.map(body => body.gpu.id), [...DEFAULT_POOL, ...DEFAULT_POOL, ...DEFAULT_POOL]);
    assert.ok(bodies.every(body => body.env.REQUESTED_GPU_TYPE === body.gpu.id));
    assert.deepEqual(waits, [5000, 5000], 'only the datacenter plan rounds back off');
    assert.equal(manager.state.phase, 'red');
});

test('Available GPU pool can be overridden without allowing an empty pool', () => {
    const configured = new RunpodManager({
        env: { RUNPOD_KEY: 'account-secret', RUNPOD_GPU_AVAILABLE_TYPES: 'NVIDIA A40,NVIDIA L40S' },
    });
    configured.setCatalog({ gpu_profile: 'available' });
    assert.deepEqual(configured.requestedGpus(), ['NVIDIA A40', 'NVIDIA L40S']);

    const empty = new RunpodManager({ env: { RUNPOD_KEY: 'account-secret', RUNPOD_GPU_AVAILABLE_TYPES: '' } });
    empty.setCatalog({ gpu_profile: 'available' });
    assert.deepEqual(empty.requestedGpus(), DEFAULT_POOL);
});

test('Available profile adopts a running Pod whose assigned GPU is in the pool', async () => {
    const manager = new RunpodManager({ env: { RUNPOD_KEY: 'account-secret' } });
    manager.setCatalog({ gpu_profile: 'available' });
    Object.assign(manager.state, { podId: 'pod-a40', gpu: 'NVIDIA A40', phase: 'orange' });
    manager.upstreamReady = async podId => podId === 'pod-a40';
    manager.touchPod = async () => true;
    manager.terminate = async () => assert.fail('an accepted GPU must not be replaced');
    manager.createPodWithRetries = async () => assert.fail('an accepted GPU must not be recreated');

    assert.equal(await manager.ensurePod([]), 'pod-a40');
    assert.equal(manager.state.phase, 'green');
});

test('Pod discovery records the assigned GPU rather than the request hint and skips dead Pods', async () => {
    const manager = new RunpodManager({
        env: { RUNPOD_KEY: 'account-secret' },
        fetchImpl: async () => response({
            pods: [
                { id: 'pod-old', name: 'comfyui-lazy', status: 'EXITED', gpu: { id: 'NVIDIA A40', count: 1 }, env: {} },
                { id: 'pod-other', name: 'something-else', status: 'RUNNING', gpu: { id: 'NVIDIA A40', count: 1 }, env: {} },
                {
                    id: 'pod-a40',
                    name: 'comfyui-lazy',
                    status: 'RUNNING',
                    env: { MODEL_KEY: 'model.gguf', REQUESTED_GPU_TYPE: 'NVIDIA RTX A5000' },
                    gpu: { id: 'NVIDIA A40', count: 1 },
                },
            ],
            pagination: { hasNextPage: false },
        }),
    });

    assert.deepEqual(await manager.findPod(), ['pod-a40', 'model.gguf', 'NVIDIA A40']);
});

test('Pod discovery adopts provisioning Pods and falls back to the request hint without a GPU', async () => {
    for (const status of ['PROVISIONING', 'STARTING']) {
        const manager = new RunpodManager({
            env: { RUNPOD_KEY: 'account-secret' },
            fetchImpl: async () => response({ pods: [{ id: 'pod-new', name: 'comfyui-lazy', status, env: { MODEL_KEY: 'm', REQUESTED_GPU_TYPE: GPU_4090 } }] }),
        });
        assert.deepEqual(await manager.findPod(), ['pod-new', 'm', GPU_4090]);
    }
});

test('Pod discovery follows pagination cursors across pages', async () => {
    const urls = [];
    const manager = new RunpodManager({
        env: { RUNPOD_KEY: 'account-secret' },
        fetchImpl: async (url, options) => {
            urls.push(url);
            assert.equal(options.method, 'GET');
            if (url === `${API}/pods`) return response({
                pods: [{ id: 'pod-x', name: 'unrelated', status: 'RUNNING', gpu: { id: 'NVIDIA A40', count: 1 } }],
                pagination: { hasNextPage: true, nextCursor: 'page/2=' },
            });
            if (url === `${API}/pods?cursor=page%2F2%3D`) return response({
                pods: [{ id: 'pod-mine', name: 'comfyui-lazy', status: 'RUNNING', gpu: { id: GPU_4090, count: 1 }, env: { MODEL_KEY: 'k' } }],
                pagination: { hasNextPage: false, nextCursor: null },
            });
            throw new Error(`unexpected URL ${url}`);
        },
    });
    assert.deepEqual(await manager.findPod(), ['pod-mine', 'k', GPU_4090]);
    assert.deepEqual(urls, [`${API}/pods`, `${API}/pods?cursor=page%2F2%3D`]);
});

test('api() retries HTTP 429 using Retry-After, then exponential backoff, capped at 600s', async () => {
    const waits = [];
    const replies = [
        response({ detail: 'rate limited', status: 429 }, 429, { 'retry-after': '7' }),
        response({ detail: 'rate limited', status: 429 }, 429),
        response({ detail: 'rate limited', status: 429 }, 429, { 'retry-after': '9999' }),
        response({ pods: [] }),
    ];
    let calls = 0;
    const manager = new RunpodManager({
        env: { RUNPOD_KEY: 'test-key' },
        sleep: async ms => waits.push(ms),
        fetchImpl: async () => replies[calls++],
    });
    manager.log = () => {};
    assert.deepEqual(await manager.api('GET', '/pods'), { pods: [] });
    assert.equal(calls, 4);
    assert.deepEqual(waits, [7000, 10000, 600000]);
});

test('api() gives up after RUNPOD_RATE_LIMIT_RETRIES and surfaces the 429', async () => {
    const waits = [];
    let calls = 0;
    const manager = new RunpodManager({
        env: { RUNPOD_KEY: 'test-key', RUNPOD_RATE_LIMIT_RETRIES: '2' },
        sleep: async ms => waits.push(ms),
        fetchImpl: async () => { calls++; return response({ detail: 'rate limited' }, 429); },
    });
    manager.log = () => {};
    await assert.rejects(manager.api('DELETE', '/pods/pod-1'), error => error.status === 429 && !error.noCapacity);
    assert.equal(calls, 3);
    assert.deepEqual(waits, [5000, 10000]);
});

test('frontend lease prevents idle cleanup until the lease expires', async () => {
    let now = 2_000_000;
    let deleted = false;
    const manager = new RunpodManager({
        env: { RUNPOD_KEY: 'account-secret', RUNPOD_IDLE_SECONDS: '1', RUNPOD_FRONTEND_LEASE_SECONDS: '5' },
        now: () => now,
        fetchImpl: async () => {
            deleted = true;
            return response(null, 204);
        },
    });
    Object.assign(manager.state, { podId: 'pod-live', phase: 'green', last: now - 10_000 });
    manager.ping();
    await manager.reapIdle();
    assert.equal(deleted, false);

    now += 5_001;
    await manager.reapIdle();
    assert.equal(deleted, true);
});

test('unconfigured manager reports disabled and rejects lifecycle changes', async () => {
    const manager = new RunpodManager({ env: {} });
    assert.deepEqual(await manager.status(), { configured: false, state: 'red', error: 'RUNPOD_KEY is missing' });
    assert.throws(() => manager.warmup(), error => error.status === 503);
});

test('generation proxies a ready Pod directly and never provisions implicitly', async () => {
    const requests = [];
    const manager = new RunpodManager({
        env: { RUNPOD_KEY: 'account-secret' },
        fetchImpl: async (url, options = {}) => {
            requests.push({ url, options });
            if (url.endsWith('/system_stats')) return response({});
            if (url.endsWith('/activity')) return response({ ok: true });
            if (url.endsWith('/prompt')) return response({ prompt_id: 'job-1' });
            if (url.endsWith('/history')) return response({
                'job-1': { outputs: { '9': { images: [{ filename: 'result.webp', subfolder: '', type: 'output' }] } } },
            });
            if (url.includes('/view?')) return {
                ok: true,
                status: 200,
                arrayBuffer: async () => Buffer.from('image-bytes'),
            };
            throw new Error(`unexpected URL ${url}`);
        },
    });

    await assert.rejects(() => manager.generate('{"prompt":{}}'), error => error.status === 503);
    assert.equal(requests.some(request => request.url.startsWith(API)), false);

    Object.assign(manager.state, { podId: 'pod-ready', phase: 'green' });
    assert.deepEqual(await manager.generate('{"prompt":{"1":{}}}'), {
        format: 'webp',
        data: Buffer.from('image-bytes').toString('base64'),
    });
    const promptRequest = requests.find(request => request.url.endsWith('/prompt'));
    assert.equal(promptRequest.options.body, '{"prompt":{"1":{}}}');
    assert.equal(manager.state.activeRequests, 0);
});

function bootFixture({ kind = 'pull', cap = 3, cancelAt = null, env = {} } = {}) {
    let now = Date.parse('2026-01-01T00:00:00Z');
    const requests = [];
    const createdAt = new Map();
    let count = 0;
    let cancelling = false;
    const line = (id, seconds, text) => `${new Date(createdAt.get(id) + seconds * 1000).toISOString()} ${text}`;
    const manager = new RunpodManager({
        env: { RUNPOD_KEY: 'test-key', RUNPOD_MAX_REPLACEMENTS: String(cap), ...env },
        now: () => now,
        sleep: async ms => { now += ms; },
        fetchImpl: async (url, options = {}) => {
            requests.push({ url, method: options.method ?? 'GET', body: options.body });
            if (url === `${API}/pods` && options.method === 'GET') return response({ pods: [], pagination: { hasNextPage: false } });
            if (url === `${API}/pods` && options.method === 'POST') {
                const id = `pod-${++count}`;
                createdAt.set(id, now);
                if (count === 2 && cancelAt === 'create') await manager.shutdown();
                return response({ id, name: 'comfyui-lazy', status: 'PROVISIONING', gpu: { id: JSON.parse(options.body).gpu.id, count: 1 }, dataCenterId: 'region', cost: 0.69 });
            }
            if (options.method === 'DELETE') {
                if (count === 2 && cancelAt === 'delete' && !cancelling && url.endsWith('/pod-1')) {
                    cancelling = true;
                    await manager.shutdown();
                }
                return response(null, 204);
            }
            const id = url.match(/(?:pod\/|https:\/\/)(pod-\d+)/)?.[1];
            if (!id) throw new Error(`unexpected URL ${url}`);
            const age = (now - createdAt.get(id)) / 1000;
            const slow = kind !== 'fast' && (kind === 'cap' || id === 'pod-1');
            if (url.endsWith('/system_stats')) return response({}, !slow && age >= 10 || kind === 'cap' && count === cap + 1 && age >= 80 ? 200 : 503);
            if (url.endsWith('/status')) return response({ present: [], downloading: { 'unet/model.bin': 0 } }, kind === 'model' || !slow ? 200 : 503);
            if (url.endsWith('/activity') || url.endsWith('/ensure')) return response({});
            if (url.endsWith('/logs')) {
                assert.equal(options.headers.Authorization, 'Bearer test-key');
                assert.match(options.headers['User-Agent'], /Mozilla/);
                if (kind === 'model' && slow) return response({ system: [], container: [
                    line(id, 0, 'boot-models: GET unet/model.bin <- https://example.com/model (10.0GB, ranges=True)'),
                    ...[30, 60, 90].filter(t => t <= age).map(t => line(id, t, `boot-models: ... unet/model.bin ${(t / 30).toFixed(1)}GB @ 33MB/s (8 streams)`)),
                ] });
                if (!slow) return response({ system: [line(id, 1, 'Status: Image is up to date'), line(id, 2, 'start container begin')], container: [] });
                return response({ container: [], system: Array.from({ length: Math.floor(age / 10) + 1 }, (_, i) => line(id, i * 10, `012345abcdef Downloading [==> ] ${(i * 0.1).toFixed(1)}GB/10.0GB`)) });
            }
            throw new Error(`unexpected URL ${url}`);
        },
    });
    manager.log = () => {};
    manager.prefetchRest = async () => {};
    manager.setCatalog({ active: ['model'], models: [{ value: 'model', files: [{ dest: 'unet/model.bin', url: 'https://example.com/model', size: 10e9 }] }] });
    return { manager, requests, count: () => count };
}

test('no-capacity moves to the next GPU type and preserves CUDA and datacenter options', async () => {
    const bodies = [];
    const waits = [];
    const manager = new RunpodManager({
        env: { RUNPOD_KEY: 'test-key', RUNPOD_DATACENTERS: 'region' },
        sleep: async ms => waits.push(ms),
        fetchImpl: async (url, options) => {
            bodies.push(JSON.parse(options.body));
            return bodies.length < 3 ? response(NO_CAPACITY_BODY, 400) : response({ id: 'pod-1', gpu: { id: 'NVIDIA GeForce RTX 5090', count: 1 } });
        },
    });
    manager.log = () => {};
    assert.deepEqual(await manager.createPodWithRetries([], 0), ['pod-1', 'NVIDIA GeForce RTX 5090']);
    assert.deepEqual(bodies.map(body => body.gpu.id), DEFAULT_POOL.slice(0, 3));
    assert.deepEqual(waits, [], 'no-capacity must not back off');
    const strip = ({ gpu: { id, ...gpu }, env: { REQUESTED_GPU_TYPE, ...env }, ...rest }) => ({ ...rest, gpu, env });
    for (const body of bodies.slice(1)) assert.deepEqual(strip(body), strip(bodies[0]));
    assert.deepEqual(bodies[0].dataCenterIds, ['region']);
    assert.deepEqual(bodies[0].gpu.allowedCudaVersions, ['13.0']);
});

test('no-capacity is recognised from the RFC 9457 400 body', async () => {
    const manager = new RunpodManager({ env: { RUNPOD_KEY: 'test-key' }, fetchImpl: async () => response(NO_CAPACITY_BODY, 400) });
    await assert.rejects(manager.api('POST', '/pods', {}), error => error.status === 400 && error.noCapacity === true);
});

test('a 4xx without the no-capacity message does not move on to another GPU type', async () => {
    const gpus = [];
    const manager = new RunpodManager({ env: { RUNPOD_KEY: 'test-key' }, sleep: async () => {}, fetchImpl: async (url, options) => {
        gpus.push(JSON.parse(options.body).gpu.id);
        return response({ detail: 'image is invalid', status: 400, title: 'Bad Request' }, 400);
    } });
    manager.log = () => {};
    await assert.rejects(manager.createPodWithRetries([], 0), /could not create pod:.*400.*image is invalid/);
    assert.deepEqual(gpus, [GPU_4090, GPU_4090, GPU_4090], 'one attempt per datacenter plan round');
});

test('transient create failures retry the same GPU type', async () => {
    const gpus = [];
    const waits = [];
    const manager = new RunpodManager({ env: { RUNPOD_KEY: 'test-key' }, sleep: async ms => waits.push(ms),
        fetchImpl: async (url, options) => {
            gpus.push(JSON.parse(options.body).gpu.id);
            return gpus.length === 1 ? response({ detail: 'temporary gateway failure' }, 502) : response({ id: 'pod-1', gpu: { id: GPU_4090, count: 1 } });
        } });
    manager.log = () => {};
    await manager.createPodWithRetries([], 0);
    assert.deepEqual(gpus, [GPU_4090, GPU_4090]);
    assert.deepEqual(waits, [5000]);
});

for (const kind of ['pull', 'model']) {
    test(`slow ${kind} download creates the replacement before deleting the old Pod`, async () => {
        const { manager, requests, count } = bootFixture({ kind });
        assert.equal(await manager.ensurePod(), 'pod-2');
        assert.equal(count(), 2);
        const creates = requests.map((r, i) => r.method === 'POST' && r.url.endsWith('/pods') ? i : -1).filter(i => i >= 0);
        assert.ok(creates[1] < requests.findIndex(r => r.method === 'DELETE' && r.url.endsWith('/pod-1')));
        assert.equal(manager.state.podId, 'pod-2');
        assert.equal(manager.state.boot.swaps, 1);
        assert.equal(manager.state.ensuring, 0);
    });
}

test('fast cached-image boot keeps the first Pod', async () => {
    const { manager, requests, count } = bootFixture({ kind: 'fast' });
    assert.equal(await manager.ensurePod(), 'pod-1');
    assert.equal(count(), 1);
    assert.equal(requests.some(r => r.method === 'DELETE'), false);
    assert.equal(manager.state.boot.containerSeconds, 2);
    assert.equal(manager.state.boot.gpu, GPU_4090);
    assert.equal(manager.state.boot.dataCenter, 'region');
    for (const field of ['tier', 'machineId', 'uplink']) assert.equal(manager.state.boot[field], undefined);
});

test('boot guard describe() reports GPU and datacenter', () => {
    const g = new BootGuard({ created: 0, gpu: 'NVIDIA A40', dataCenter: 'EU-RO-1' }, [], guardOptions);
    assert.equal(g.describe(), 'GPU=NVIDIA A40 dataCenter=EU-RO-1 container=?s pull=?MB/s models=?MB/s');
    assert.match(new BootGuard({ created: 0 }, [], guardOptions).describe(), /^GPU=\? dataCenter=\? /);
});

test('slow-host swap cap accepts the fourth Pod without creating a fifth', async () => {
    const { manager, count } = bootFixture({ kind: 'cap' });
    assert.equal(await manager.ensurePod(), 'pod-4');
    assert.equal(count(), 4);
    assert.equal(manager.state.boot.swaps, 3);
});

for (const cancelAt of ['create', 'delete']) {
    test(`cancellation during replacement ${cancelAt} cleans up the unadopted Pod`, async () => {
        const { manager, requests, count } = bootFixture({ cancelAt });
        await assert.rejects(manager.ensurePod(), /pod warmup cancelled/);
        assert.equal(count(), 2);
        for (const id of ['pod-1', 'pod-2']) assert.ok(requests.some(r => r.method === 'DELETE' && r.url.endsWith(`/${id}`)));
        assert.equal(manager.state.podId, null);
        assert.equal(manager.state.ensuring, 0);
    });
}

// Keep phase boundaries covered: host-independent work must never cause swaps.
const guardOptions = { pullAfterMs: 45000, modelAfterMs: 45000, windowMs: 30000, pullMin: 50, modelMin: 40, doneFraction: 0.85, containerDeadlineMs: 360000 };
function guardedLogs(entries) {
    return entries.map(([seconds, text]) => `${new Date(seconds * 1000).toISOString()} ${text}`);
}
function guard() {
    return new BootGuard({ created: 0 }, [{ dest: 'unet/model.bin', size: 10e9 }], guardOptions);
}

test('container deadline swaps a new Pod even when logs are unavailable', async () => {
    const { manager, count } = bootFixture();
    manager.podLogs = async () => { throw new Error('logs unavailable'); };
    assert.equal(await manager.ensurePod(), 'pod-2');
    assert.equal(count(), 2);
});

test('container startup ends the deadline even if ComfyUI takes minutes', () => {
    const g = guard();
    const logs = { system: guardedLogs([[1, 'Status: Image is up to date'], [2, 'start container begin']]) };
    assert.equal(g.observe(logs, 900000), null);
    assert.equal(g.containerSeconds, 2);
});

test('nearly finished downloads and completed pulls are not replaced', () => {
    const system = guardedLogs([[0, '012345abcdef Downloading [] 8.5GB/10GB'], [30, '012345abcdef Downloading [] 8.6GB/10GB'], [60, '012345abcdef Downloading [] 8.7GB/10GB']]);
    assert.equal(guard().observe({ system }, 60000), null);
    system.push(...guardedLogs([[61, 'Status: Downloaded newer image']]));
    assert.equal(guard().observe({ system }, 65000), null);
    const container = guardedLogs([[0, 'boot-models: GET unet/model.bin <- https://example.com/model (10.0GB, ranges=True)'], [30, 'boot-models: ... unet/model.bin 8.5GB @ 1MB/s'], [60, 'boot-models: ... unet/model.bin 8.6GB @ 1MB/s']]);
    assert.equal(guard().observe({ container }, 60000), null);
});

test('READY and OK stop model judgments before app startup and hashing delays', () => {
    const container = guardedLogs([[0, 'boot-models: GET unet/model.bin <- https://example.com/model (10.0GB, ranges=True)'], [30, 'boot-models: ... unet/model.bin 1.0GB @ 33MB/s'], [60, 'boot-models: ... unet/model.bin 2.0GB @ 33MB/s'], [61, 'boot-models: READY - handing over to ComfyUI']]);
    assert.equal(guard().observe({ container }, 65000), null);
    assert.equal(guard().observe({ container: container.slice(0, -1).concat(guardedLogs([[61, 'boot-models: OK unet/model.bin (10.0GB in 61s)']])) }, 65000), null);
});

test('missing and stale progress does not invent a stalled download', () => {
    assert.equal(guard().observe({ container: guardedLogs([[0, 'model-manager: listening on :8189']]) }, 65000), null);
    const system = guardedLogs([[0, '012345abcdef Downloading [] 0GB/10GB'], [30, '012345abcdef Downloading [] 0.3GB/10GB'], [60, '012345abcdef Downloading [] 0.6GB/10GB']]);
    assert.equal(guard().observe({ system }, 100000), null);
});

test('model retry resets the speed window instead of treating a counter reset as slow', () => {
    const container = guardedLogs([[0, 'boot-models: GET unet/model.bin <- https://example.com/model (10.0GB, ranges=True)'], [30, 'boot-models: ... unet/model.bin 4.0GB @ 133MB/s'], [60, 'boot-models: attempt 1/3 failed for unet/model.bin: timeout'], [70, 'boot-models: GET unet/model.bin <- https://example.com/model (10.0GB, ranges=True)'], [80, 'boot-models: ... unet/model.bin 1.0GB @ 100MB/s']]);
    assert.equal(guard().observe({ container }, 80000), null);
});

test('cached model files do not count as bytes received', () => {
    const g = new BootGuard({ created: 0 }, [{ dest: 'unet/model.bin', size: 10e9 }, { dest: 'vae/cached.bin', size: 2e9 }], guardOptions);
    const container = guardedLogs([[0, 'boot-models: GET unet/model.bin <- https://example.com/model (10.0GB, ranges=True)'], [30, 'boot-models: ... unet/model.bin 1.0GB @ 33MB/s'], [40, 'boot-models: SKIP vae/cached.bin'], [60, 'boot-models: ... unet/model.bin 2.0GB @ 33MB/s']]);
    assert.match(g.observe({ container }, 60000), /model download 33.3 MB\/s/);
    assert.ok(Math.abs(g.modelRate - 33.3333) < 0.01);
});

test('failed replacement creation keeps the old Pod and attempts no deletion', async () => {
    const { manager, requests } = bootFixture();
    const create = manager.createPodWithRetries.bind(manager);
    let calls = 0;
    manager.createPodWithRetries = async (...args) => {
        if (++calls > 1) throw new Error('replacement unavailable');
        return create(...args);
    };
    const ready = manager.upstreamReady.bind(manager);
    let polls = 0;
    manager.upstreamReady = async id => ++polls > 20 || ready(id);
    assert.equal(await manager.ensurePod(), 'pod-1');
    assert.equal(calls, 2);
    assert.equal(requests.some(r => r.method === 'DELETE'), false);
});

test('old-Pod deletion failure cleans up the replacement and keeps the tracked Pod', async () => {
    const { manager, requests } = bootFixture();
    const terminate = manager.terminate.bind(manager);
    manager.terminate = async id => {
        if (id === 'pod-1') throw new Error('delete unavailable');
        return terminate(id);
    };
    const ready = manager.upstreamReady.bind(manager);
    let polls = 0;
    manager.upstreamReady = async id => ++polls > 20 || ready(id);
    assert.equal(await manager.ensurePod(), 'pod-1');
    assert.ok(requests.some(r => r.method === 'DELETE' && r.url.endsWith('/pod-2')));
    assert.equal(manager.state.podId, 'pod-1');
});

test('coarse received-byte logs still detect a slow model stream with samples over 30s apart', () => {
    const container = guardedLogs([[0, 'boot-models: GET unet/model.bin <- https://example.com/model (10.0GB, ranges=True)'], [31, 'boot-models: ... unet/model.bin 1.0GB @ 32MB/s'], [62, 'boot-models: ... unet/model.bin 2.0GB @ 32MB/s']]);
    assert.match(guard().observe({ container }, 62000), /model download 32.3 MB\/s/);
});

test('Docker resumed-range counters remain monotonic and do not label a fast retry slow', () => {
    const system = guardedLogs([
        ...Array.from({ length: 7 }, (_, i) => [i * 10, `012345abcdef Downloading [] ${i * 1000}MB/10.0GB`]),
        [61, '012345abcdef Retrying in 1 seconds'],
        ...Array.from({ length: 5 }, (_, i) => [64 + i * 4, `012345abcdef Downloading [] ${100 + i * 400}MB/4.0GB`]),
    ]);
    const g = guard();
    assert.equal(g.observe({ system }, 80000), null);
    assert.ok(g.pullRate > 95 && g.pullRate < 100);
});

test('pull throughput summary stops at the final received bytes before extraction', () => {
    const system = guardedLogs([[0, '012345abcdef Downloading [] 0GB/10GB'], [50, '012345abcdef Downloading [] 10GB/10GB'], [60, '012345abcdef Extracting [] 1GB/10GB'], [120, '012345abcdef Pull complete'], [121, 'Status: Downloaded newer image'], [122, 'start container begin']]);
    const g = guard();
    assert.equal(g.observe({ system }, 122000), null);
    assert.equal(g.pullRate, 200);
});

test('same-second container start logs survive local millisecond timestamps', () => {
    const g = new BootGuard({ created: 999 }, [], guardOptions);
    assert.equal(g.observe({ system: guardedLogs([[0, 'Status: Image is up to date'], [0, 'start container begin']]) }, 900000), null);
    assert.equal(g.containerSeconds, 0);
});

test('alternate RunPod no-capacity message moves on to the next GPU type at any status', async () => {
    const gpus = [];
    const manager = new RunpodManager({ env: { RUNPOD_KEY: 'test-key' }, sleep: async () => assert.fail('no-capacity must not back off on the same GPU type'), fetchImpl: async (url, options) => {
        gpus.push(JSON.parse(options.body).gpu.id);
        return gpus.length === 1 ? response({ error: 'create pod: There are no instances currently available' }, 500) : response({ id: 'pod-1', gpu: { id: 'NVIDIA A40', count: 1 } });
    } });
    manager.log = () => {};
    assert.deepEqual(await manager.createPodWithRetries([], 0), ['pod-1', 'NVIDIA A40']);
    assert.deepEqual(gpus, [GPU_4090, 'NVIDIA A40']);
});

test('exhausted transient retries advance datacenter plans without dropping the GPU type', async () => {
    const bodies = [];
    const manager = new RunpodManager({ env: { RUNPOD_KEY: 'test-key', RUNPOD_DATACENTERS: 'region' }, sleep: async () => {}, fetchImpl: async (url, options) => {
        bodies.push(JSON.parse(options.body));
        return bodies.length <= 6 ? response({ detail: 'gateway failed' }, 503) : response({ id: 'pod-1', gpu: { id: GPU_4090, count: 1 } });
    } });
    manager.log = () => {};
    await manager.createPodWithRetries([], 0);
    assert.equal(bodies.length, 7);
    assert.ok(bodies.every(body => body.gpu.id === GPU_4090));
    assert.deepEqual(bodies[5].dataCenterIds, ['region']);
    assert.equal(bodies[6].dataCenterIds, undefined);
});

test('429 that outlasts api() retries retries the same GPU type and permanent failure sets red', async () => {
    const gpus = [];
    const manager = new RunpodManager({ env: { RUNPOD_KEY: 'test-key', RUNPOD_RATE_LIMIT_RETRIES: '1' }, sleep: async () => {}, fetchImpl: async (url, options) => {
        gpus.push(JSON.parse(options.body).gpu.id);
        return response({ detail: 'rate limited' }, 429);
    } });
    manager.log = () => {};
    await assert.rejects(manager.createPodWithRetries([], 0), /could not create pod:.*429/);
    assert.equal(gpus.length, 18, '3 rounds x 3 create attempts x (1 + 1 api() retry)');
    assert.ok(gpus.every(gpu => gpu === GPU_4090));
    assert.equal(manager.state.phase, 'red');
});

test('successful termination discards creation metadata', async () => {
    const manager = new RunpodManager({ env: { RUNPOD_KEY: 'test-key' }, fetchImpl: async () => response(null, 204) });
    manager.log = () => {};
    manager.pods.set('pod-1', { created: 0 });
    await manager.terminate('pod-1');
    assert.equal(manager.pods.has('pod-1'), false);
});

test('synced catalog survives a server restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runpod-catalog-'));
    try {
        const catalogFile = path.join(dir, 'nested', 'runpod-catalog.json');
        const first = new RunpodManager({ env: { RUNPOD_KEY: 'test-key' }, catalogFile });
        first.log = () => {};
        first.setCatalog({
            active: ['model'],
            models: [{ value: 'model', files: [{ dest: 'checkpoints/model.safetensors', url: 'https://example.com/model' }] }],
            gpu_profile: 'a5000',
        });

        const restarted = new RunpodManager({ env: { RUNPOD_KEY: 'test-key' }, catalogFile });
        restarted.log = () => {};
        restarted.loadCatalog();
        assert.deepEqual(restarted.activeValues(), ['model']);
        assert.deepEqual(restarted.neededFiles(restarted.activeValues()), [{ dest: 'checkpoints/model.safetensors', url: 'https://example.com/model' }]);
        assert.equal(restarted.catalog.gpuProfile, 'a5000');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('warmup without synced catalog files refuses instead of booting the legacy model set', () => {
    const manager = new RunpodManager({ env: { RUNPOD_KEY: 'test-key' }, fetchImpl: async () => assert.fail('no RunPod call without a catalog') });
    manager.log = () => {};
    assert.throws(() => manager.warmup(), error => error.status === 409);
    manager.setCatalog({ active: ['model'], models: [{ value: 'model', files: [] }] });
    assert.throws(() => manager.warmup(), error => error.status === 409);
    assert.equal(manager.state.ensurePromise, null);
    assert.equal(manager.state.phase, 'red');
});

test('background prefetch logs a failed request and retries it once', async () => {
    const logs = [];
    let ensures = 0;
    const manager = new RunpodManager({ env: { RUNPOD_KEY: 'test-key' }, sleep: async () => {}, fetchImpl: async url => {
        assert.match(url, /-8189\.proxy\.runpod\.net\/ensure$/);
        ensures++;
        return ensures === 1 ? response({ error: 'busy' }, 502) : response({ queued: ['checkpoints/b'] });
    } });
    manager.log = (...args) => logs.push(args.join(' '));
    manager.setCatalog({ models: [{ value: 'b', files: [{ dest: 'checkpoints/b', url: 'https://example.com/b' }] }] });
    manager.state.podId = 'pod-1';

    await manager.prefetchRest('pod-1');
    assert.equal(ensures, 2);
    assert.ok(logs.some(line => /background prefetch attempt 1 failed: model manager returned 502/.test(line)));
    assert.ok(logs.some(line => line === 'background prefetch queued: checkpoints/b'));
});

test('background prefetch does not retry for a Pod that is no longer tracked', async () => {
    let ensures = 0;
    const manager = new RunpodManager({ env: { RUNPOD_KEY: 'test-key' }, sleep: async () => assert.fail('no retry delay'), fetchImpl: async () => {
        ensures++;
        return response({ error: 'gone' }, 404);
    } });
    manager.log = () => {};
    manager.setCatalog({ models: [{ value: 'b', files: [{ dest: 'checkpoints/b', url: 'https://example.com/b' }] }] });
    manager.state.podId = 'pod-2';

    await manager.prefetchRest('pod-1');
    assert.equal(ensures, 1);
});
