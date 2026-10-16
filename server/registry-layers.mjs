// Compressed layer sizes from an image's registry manifest. RunPod's system
// log shows Docker pull states per layer but no byte counts; the 12-hex layer
// ID in those lines is the start of the layer's compressed blob digest.
const ACCEPT = [
    'application/vnd.docker.distribution.manifest.v2+json',
    'application/vnd.oci.image.manifest.v1+json',
    'application/vnd.docker.distribution.manifest.list.v2+json',
    'application/vnd.oci.image.index.v1+json',
].join(', ');
const DOCKER_HUB = new Set(['docker.io', 'index.docker.io', 'registry-1.docker.io']);
const TIMEOUT_MS = 10000;

/** Split `[registry/]repository[:tag|@digest]` the way Docker does. */
export function parseImageRef(ref) {
    let rest = String(ref ?? '').trim();
    let registry = 'docker.io';
    const slash = rest.indexOf('/');
    if (slash > 0) {
        const first = rest.slice(0, slash);
        if (/[.:]/.test(first) || first === 'localhost') {
            registry = first;
            rest = rest.slice(slash + 1);
        }
    }
    let reference = 'latest';
    const at = rest.indexOf('@');
    if (at >= 0) {
        reference = rest.slice(at + 1);
        rest = rest.slice(0, at);
    } else {
        const colon = rest.lastIndexOf(':');
        if (colon > rest.lastIndexOf('/')) {
            reference = rest.slice(colon + 1);
            rest = rest.slice(0, colon);
        }
    }
    if (!rest) throw new Error(`invalid image reference: ${ref}`);
    if (DOCKER_HUB.has(registry)) {
        registry = 'docker.io';
        if (!rest.includes('/')) rest = `library/${rest}`;
    }
    return { registry, repository: rest, reference };
}

function registryBase(registry) {
    return registry === 'docker.io' ? 'https://registry-1.docker.io' : `https://${registry}`;
}

async function getJson(fetchImpl, url, headers = {}) {
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) throw new Error(`${url} returned ${response.status}`);
    return response.json();
}

function bearerChallenge(header) {
    const match = String(header ?? '').match(/^\s*Bearer\s+(.*)$/i);
    if (!match) return null;
    const params = Object.fromEntries([...match[1].matchAll(/(\w+)="([^"]*)"/g)].map(([, key, value]) => [key.toLowerCase(), value]));
    return params.realm ? params : null;
}

async function pullToken(fetchImpl, registry, repository) {
    const scope = `repository:${repository}:pull`;
    let url;
    if (registry === 'ghcr.io') url = `https://ghcr.io/token?scope=${scope}`;
    else if (registry === 'docker.io') url = `https://auth.docker.io/token?service=registry.docker.io&scope=${scope}`;
    else {
        const probe = await fetchImpl(`${registryBase(registry)}/v2/`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (probe.ok) return null; // anonymous access without a token
        const challenge = probe.status === 401 ? bearerChallenge(probe.headers?.get?.('www-authenticate')) : null;
        if (!challenge) throw new Error(`${registry} offers no anonymous Bearer token (HTTP ${probe.status})`);
        const query = new URLSearchParams({ ...(challenge.service ? { service: challenge.service } : {}), scope });
        url = `${challenge.realm}${challenge.realm.includes('?') ? '&' : '?'}${query}`;
    }
    const body = await getJson(fetchImpl, url);
    const token = body.token ?? body.access_token;
    if (!token) throw new Error(`${registry} token response has no token`);
    return token;
}

/** Fetch the linux/amd64 manifest and return Map(12-hex digest prefix -> compressed size). */
export async function fetchImageLayers(image, fetchImpl) {
    const { registry, repository, reference } = parseImageRef(image);
    const token = await pullToken(fetchImpl, registry, repository);
    const headers = { Accept: ACCEPT, ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    const manifestUrl = ref => `${registryBase(registry)}/v2/${repository}/manifests/${ref}`;
    let manifest = await getJson(fetchImpl, manifestUrl(reference), headers);
    if (Array.isArray(manifest.manifests)) {
        const amd64 = manifest.manifests.filter(entry => entry?.platform?.os === 'linux' && entry.platform.architecture === 'amd64');
        const pick = amd64.find(entry => !entry.platform.variant) ?? amd64[0];
        if (!pick?.digest) throw new Error(`${image} has no linux/amd64 manifest`);
        manifest = await getJson(fetchImpl, manifestUrl(pick.digest), headers);
    }
    if (!Array.isArray(manifest.layers) || !manifest.layers.length) throw new Error(`${image} manifest lists no layers`);
    const layers = new Map();
    for (const layer of manifest.layers) {
        const hex = String(layer?.digest ?? '').split(':')[1];
        const size = Number(layer?.size);
        if (!hex || !(size >= 0)) throw new Error(`${image} manifest has an invalid layer entry`);
        layers.set(hex.slice(0, 12), size);
    }
    return { layers, total: [...layers.values()].reduce((sum, size) => sum + size, 0) };
}

/** Per-image cache. lookup() never blocks: it returns the cached sizes, null when unavailable, or undefined while loading. */
export class RegistryLayerCache {
    constructor({ fetchImpl, now = () => Date.now(), log = () => {}, ttlMs = 3600_000, failureTtlMs = 300_000 } = {}) {
        this.fetch = fetchImpl;
        this.now = now;
        this.log = log;
        this.ttlMs = ttlMs;
        this.failureTtlMs = failureTtlMs;
        this.entries = new Map();
    }

    lookup(image) {
        const entry = this.entries.get(image);
        if (entry && (entry.promise || this.now() < entry.expires)) return entry.value;
        const promise = fetchImageLayers(image, this.fetch).then(value => {
            this.entries.set(image, { value, expires: this.now() + this.ttlMs });
            return value;
        }, error => {
            this.log(`registry layer sizes for ${image} unavailable; pull-bound check disabled for ${Math.round(this.failureTtlMs / 1000)}s:`, error.message);
            this.entries.set(image, { value: null, expires: this.now() + this.failureTtlMs });
            return null;
        });
        // A refresh keeps serving the previous sizes until it settles.
        this.entries.set(image, { value: entry?.value ?? undefined, promise });
        return entry?.value ?? undefined;
    }

    async load(image) {
        this.lookup(image);
        const entry = this.entries.get(image);
        return entry.promise ? entry.promise : entry.value;
    }
}
