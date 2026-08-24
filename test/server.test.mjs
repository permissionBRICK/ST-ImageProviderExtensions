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
    CLIPLoader: { input: { required: { clip_name: [['clip_l.safetensors']] } } },
    DualCLIPLoaderGGUF: { input: { required: { clip_name1: ['COMBO', { options: ['t5xxl.gguf'] }], clip_name2: [['clip_l.safetensors']] } } },
    CLIPVisionLoader: { input: { required: { clip_name: [['vision_encoder.safetensors']] } } },
};

let server;
let baseUrl;
let objectInfoRequests = 0;
let customObjectInfoRequests = 0;

before(async () => {
    server = http.createServer((request, response) => {
        response.setHeader('content-type', 'application/json');
        if (request.url === '/comfy/system_stats') {
            return response.end('{}');
        }
        if (request.url === '/comfy/object_info') {
            objectInfoRequests++;
            return response.end(JSON.stringify(objectInfo));
        }
        if (request.url === '/custom/object_info') {
            customObjectInfoRequests++;
            return setTimeout(() => response.end(JSON.stringify({
                    CustomSamplerNode: { input: { required: { sampler_name: [['custom_sampler']], scheduler: [['custom_scheduler']] } } },
                    CustomVaeNode: { input: { required: { vae_name: [['custom_vae.safetensors']] } } },
                    CustomLoraNode: { input: { required: { lora_name: [['custom_lora.safetensors']] } } },
                    CustomCheckpointNode: { input: { required: { ckpt_name: [['custom_model.safetensors']] } } },
                    CustomTextEncoderLoader: { input: { required: { text_encoder_name: ['COMBO', { options: ['custom_encoder.safetensors'] }] } } },
                })), 20);
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
    assert.deepEqual(await readComfyMetadata('text_encoders', baseUrl), ['clip_l.safetensors', 't5xxl.gguf']);
    assert.deepEqual(await readComfyMetadata('models', baseUrl), [
        { value: 'base_model.safetensors', text: 'base model' },
        { value: 'flux_dev.safetensors', text: 'UNet: flux dev' },
        { value: 'flux_q4.gguf', text: 'GGUF: flux q4' },
    ]);
    assert.equal(objectInfoRequests, 1, 'all metadata kinds reuse one object_info response');
});

test('coalesces concurrent object_info requests and discovers custom loader nodes', async () => {
    const customUrl = `${baseUrl.replace(/\/comfy$/, '')}/custom`;
    const [samplers, schedulers, vaes, loras, models, encoders] = await Promise.all([
        readComfyMetadata('samplers', customUrl),
        readComfyMetadata('schedulers', customUrl),
        readComfyMetadata('vaes', customUrl),
        readComfyMetadata('loras', customUrl),
        readComfyMetadata('models', customUrl),
        readComfyMetadata('text_encoders', customUrl),
    ]);
    assert.deepEqual(samplers, ['custom_sampler']);
    assert.deepEqual(schedulers, ['custom_scheduler']);
    assert.deepEqual(vaes, ['custom_vae.safetensors']);
    assert.deepEqual(loras, ['custom_lora.safetensors']);
    assert.deepEqual(models, [{ value: 'custom_model.safetensors', text: 'custom model' }]);
    assert.deepEqual(encoders, ['custom_encoder.safetensors']);
    assert.equal(customObjectInfoRequests, 1, 'concurrent metadata loads coalesce into one request');
});

test('rejects unsupported metadata kinds and protocols', async () => {
    await assert.rejects(() => readComfyMetadata('unknown', baseUrl), /Unsupported/);
    await assert.rejects(() => readComfyMetadata('ping', 'file:///tmp/comfy'), /HTTP or HTTPS/);
});
