import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunpodManager } from '../server/runpod-manager.mjs';

function response(body = {}, status = 200) {
    const text = body === null ? '' : JSON.stringify(body);
    return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => text,
        json: async () => body ?? {},
        arrayBuffer: async () => Buffer.from(text),
    };
}

test('managed Pod creation passes worker tokens and self-reaper settings, but not the account key', async () => {
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
            return response({ id: 'pod-123', machine: { gpuTypeId: 'A40' }, costPerHr: 0.5 });
        },
    });
    manager.setCatalog({
        active: ['model.gguf'],
        models: [{ value: 'model.gguf', files: [{ dest: 'unet/model.gguf', url: 'https://example/model' }] }],
    });

    assert.deepEqual(await manager.createPod(manager.activeValues()), ['pod-123', 'A40']);
    const request = requests[0];
    const body = JSON.parse(request.options.body);
    assert.equal(request.url, 'https://rest.runpod.io/v1/pods');
    assert.equal(request.options.headers.Authorization, 'Bearer account-secret');
    assert.equal(body.env.HF_TOKEN, 'hf-secret');
    assert.equal(body.env.RUNPOD_SELF_REAP_SECONDS, '1200');
    assert.equal(body.env.RUNPOD_SELF_REAP_BOOT_GRACE_SECONDS, '2400');
    assert.equal(body.env.RUNPOD_KEY, undefined);
    assert.equal(body.env.RUNPOD_API_KEY, undefined, 'RunPod injects the pod-scoped key itself');
    assert.deepEqual(body.gpuTypeIds, ['NVIDIA RTX A5000']);
    assert.equal(body.gpuTypePriority, 'custom', 'RunPod must honor the benchmarked preference order');
    assert.equal(body.env.REQUESTED_GPU_TYPE, 'NVIDIA RTX A5000');
    assert.match(body.dockerStartCmd[2], /self-reaper\.py/);
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
    assert.equal(requests[0].url, 'https://rest.runpod.io/v1/pods/pod-idle');
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
            return response({ id: 'pod-5090', machine: { gpuTypeId: 'NVIDIA GeForce RTX 5090' } });
        },
    });
    manager.setCatalog({ gpu_profile: 'rtx5090' });
    await manager.createPod([]);
    const body = JSON.parse(requests[0].options.body);
    assert.deepEqual(body.gpuTypeIds, ['NVIDIA GeForce RTX 5090']);
    assert.equal(body.env.REQUESTED_GPU_TYPE, 'NVIDIA GeForce RTX 5090');
    assert.throws(() => manager.setCatalog({ gpu_profile: 'h100' }), error => error.status === 400);
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
    assert.equal(requests.some(request => request.url === 'https://rest.runpod.io/v1/pods'), false);

    Object.assign(manager.state, { podId: 'pod-ready', phase: 'green' });
    assert.deepEqual(await manager.generate('{"prompt":{"1":{}}}'), {
        format: 'webp',
        data: Buffer.from('image-bytes').toString('base64'),
    });
    const promptRequest = requests.find(request => request.url.endsWith('/prompt'));
    assert.equal(promptRequest.options.body, '{"prompt":{"1":{}}}');
    assert.equal(manager.state.activeRequests, 0);
});
