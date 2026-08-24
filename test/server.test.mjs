import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { readComfyMetadata } from '../server/index.mjs';

const objectInfo = {
    KSampler: { input: { required: { sampler_name: [['euler']], scheduler: [['normal']] } } },
    CheckpointLoaderSimple: { input: { required: { ckpt_name: [['base_model.safetensors']] } } },
    UNETLoader: { input: { required: { unet_name: [['flux_dev.safetensors']] } } },
    UnetLoaderGGUF: { input: { required: { unet_name: [['flux_q4.gguf']] } } },
    VAELoader: { input: { required: { vae_name: [['ae.safetensors']] } } },
    LoraLoader: { input: { required: { lora_name: [['detail.safetensors']] } } },
};

let server;
let baseUrl;

before(async () => {
    server = http.createServer((request, response) => {
        response.setHeader('content-type', 'application/json');
        if (request.url === '/comfy/system_stats') {
            return response.end('{}');
        }
        if (request.url === '/comfy/object_info') {
            return response.end(JSON.stringify(objectInfo));
        }
        response.statusCode = 404;
        response.end('{}');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/comfy`;
});

after(async () => {
    await new Promise(resolve => server.close(resolve));
});

test('reads ComfyUI status and every metadata type', async () => {
    assert.equal(await readComfyMetadata('ping', baseUrl), true);
    assert.deepEqual(await readComfyMetadata('samplers', baseUrl), ['euler']);
    assert.deepEqual(await readComfyMetadata('schedulers', baseUrl), ['normal']);
    assert.deepEqual(await readComfyMetadata('vaes', baseUrl), ['ae.safetensors']);
    assert.deepEqual(await readComfyMetadata('loras', baseUrl), ['detail.safetensors']);
    assert.deepEqual(await readComfyMetadata('models', baseUrl), [
        { value: 'base_model.safetensors', text: 'base model' },
        { value: 'flux_dev.safetensors', text: 'UNet: flux dev' },
        { value: 'flux_q4.gguf', text: 'GGUF: flux q4' },
    ]);
});

test('rejects unsupported metadata kinds and protocols', async () => {
    await assert.rejects(() => readComfyMetadata('unknown', baseUrl), /Unsupported/);
    await assert.rejects(() => readComfyMetadata('ping', 'file:///tmp/comfy'), /HTTP or HTTPS/);
});
