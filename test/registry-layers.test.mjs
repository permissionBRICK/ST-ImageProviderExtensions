import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RegistryLayerCache, fetchImageLayers, parseImageRef } from '../server/registry-layers.mjs';

function response(body, status = 200, headers = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: name => headers[name.toLowerCase()] ?? null },
        json: async () => body,
    };
}
const digest = (prefix, fill = '0') => `sha256:${prefix}${fill.repeat(64 - prefix.length)}`;
const manifest = layers => ({
    schemaVersion: 2,
    mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
    config: { digest: digest('cfg'), size: 7000 },
    layers: layers.map(([prefix, size]) => ({ digest: digest(prefix, 'e'), size })),
});

function registry(routes) {
    const requests = [];
    const fetchImpl = async (url, options = {}) => {
        requests.push({ url, headers: options.headers ?? {} });
        const route = routes[url];
        if (!route) throw new Error(`unexpected URL ${url}`);
        return typeof route === 'function' ? route(options) : response(route);
    };
    return { requests, fetchImpl };
}

test('image references resolve registry, repository, and tag like Docker', () => {
    assert.deepEqual(parseImageRef('ghcr.io/owner/repo:tag'), { registry: 'ghcr.io', repository: 'owner/repo', reference: 'tag' });
    assert.deepEqual(parseImageRef('docker.io/owner/repo:tag'), { registry: 'docker.io', repository: 'owner/repo', reference: 'tag' });
    assert.deepEqual(parseImageRef('owner/repo:tag'), { registry: 'docker.io', repository: 'owner/repo', reference: 'tag' });
    assert.deepEqual(parseImageRef('ubuntu'), { registry: 'docker.io', repository: 'library/ubuntu', reference: 'latest' });
    assert.deepEqual(parseImageRef('registry.example.com:5000/team/app'), { registry: 'registry.example.com:5000', repository: 'team/app', reference: 'latest' });
    assert.deepEqual(parseImageRef(`repo@${digest('ab')}`), { registry: 'docker.io', repository: 'library/repo', reference: digest('ab') });
});

test('ghcr manifests map 12-hex blob prefixes to compressed sizes', async () => {
    const { requests, fetchImpl } = registry({
        'https://ghcr.io/token?scope=repository:owner/repo:pull': { token: 'ghcr-anon' },
        'https://ghcr.io/v2/owner/repo/manifests/latest': manifest([['f4d2483a1161', 2874255856], ['91033c7f60cb', 703485424], ['b9c4a5bd6ace', 68684114]]),
    });
    const result = await fetchImageLayers('ghcr.io/owner/repo:latest', fetchImpl);
    assert.deepEqual([...result.layers], [['f4d2483a1161', 2874255856], ['91033c7f60cb', 703485424], ['b9c4a5bd6ace', 68684114]]);
    assert.equal(result.total, 2874255856 + 703485424 + 68684114);
    assert.equal(requests[1].headers.Authorization, 'Bearer ghcr-anon');
    assert.match(requests[1].headers.Accept, /manifest\.v2\+json.*oci\.image\.manifest\.v1\+json.*manifest\.list\.v2\+json.*oci\.image\.index\.v1\+json/);
});

test('Docker Hub indexes resolve to the linux/amd64 manifest', async () => {
    const amd64 = digest('a3d64');
    const { requests, fetchImpl } = registry({
        'https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/ubuntu:pull': { token: 'hub', access_token: 'hub' },
        'https://registry-1.docker.io/v2/library/ubuntu/manifests/24.04': {
            schemaVersion: 2,
            mediaType: 'application/vnd.oci.image.index.v1+json',
            manifests: [
                { digest: digest('a7a64'), platform: { os: 'linux', architecture: 'arm64', variant: 'v8' } },
                { digest: digest('0a77e'), platform: { os: 'unknown', architecture: 'unknown' } },
                { digest: amd64, platform: { os: 'linux', architecture: 'amd64' } },
            ],
        },
        [`https://registry-1.docker.io/v2/library/ubuntu/manifests/${amd64}`]: manifest([['123456789abc', 29_000_000]]),
    });
    const result = await fetchImageLayers('ubuntu:24.04', fetchImpl);
    assert.deepEqual([...result.layers], [['123456789abc', 29_000_000]]);
    assert.equal(requests.length, 3);
    assert.equal(requests[2].headers.Authorization, 'Bearer hub');
});

test('other registries use the WWW-Authenticate Bearer realm, else give up', async () => {
    const { requests, fetchImpl } = registry({
        'https://quay.example/v2/': () => response({}, 401, { 'www-authenticate': 'Bearer realm="https://quay.example/v2/auth",service="quay.example"' }),
        'https://quay.example/v2/auth?service=quay.example&scope=repository%3Ateam%2Fapp%3Apull': { token: 'quay' },
        'https://quay.example/v2/team/app/manifests/v1': manifest([['abcdef012345', 5]]),
    });
    assert.equal((await fetchImageLayers('quay.example/team/app:v1', fetchImpl)).total, 5);
    assert.equal(requests[2].headers.Authorization, 'Bearer quay');

    const basic = registry({ 'https://private.example/v2/': () => response({}, 401, { 'www-authenticate': 'Basic realm="private"' }) });
    await assert.rejects(fetchImageLayers('private.example/app', basic.fetchImpl), /no anonymous Bearer token/);
});

test('layer sizes are cached per image for an hour', async () => {
    let now = 0;
    const { requests, fetchImpl } = registry({
        'https://ghcr.io/token?scope=repository:owner/repo:pull': { token: 't' },
        'https://ghcr.io/v2/owner/repo/manifests/latest': manifest([['f4d2483a1161', 10]]),
    });
    const cache = new RegistryLayerCache({ fetchImpl, now: () => now });
    assert.equal(cache.lookup('ghcr.io/owner/repo'), undefined, 'lookup never blocks');
    assert.equal((await cache.load('ghcr.io/owner/repo')).total, 10);
    assert.equal(cache.lookup('ghcr.io/owner/repo').layers.get('f4d2483a1161'), 10);
    now += 3599_000;
    cache.lookup('ghcr.io/owner/repo');
    assert.equal(requests.length, 2);
    now += 2000;
    assert.equal(cache.lookup('ghcr.io/owner/repo').total, 10, 'stale sizes are served while refreshing');
    await cache.load('ghcr.io/owner/repo');
    assert.equal(requests.length, 4);
});

test('a registry failure disables the rule, logs once, and retries after a few minutes', async () => {
    let now = 0;
    let calls = 0;
    const logs = [];
    const cache = new RegistryLayerCache({
        fetchImpl: async () => { calls++; return response({ errors: [{ code: 'DENIED' }] }, 403); },
        now: () => now,
        log: (...args) => logs.push(args.join(' ')),
    });
    assert.equal(await cache.load('ghcr.io/owner/private'), null);
    assert.equal(cache.lookup('ghcr.io/owner/private'), null);
    assert.equal(await cache.load('ghcr.io/owner/private'), null);
    assert.equal(calls, 1);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /registry layer sizes for ghcr\.io\/owner\/private unavailable; pull-bound check disabled for 300s: .*403/);
    now += 300_000;
    await cache.load('ghcr.io/owner/private');
    assert.equal(calls, 2);
});
