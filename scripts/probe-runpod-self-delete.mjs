#!/usr/bin/env node
/** Prove whether an injected or explicitly supplied key can delete its own Pod.
 *
 * RUNPOD_PROBE_KEY_MODE=injected (default) tests RunPod's automatic Pod key.
 * RUNPOD_PROBE_KEY_MODE=management passes RUNPOD_KEY to the disposable Pod as
 * RUNPOD_TERMINATE_API_KEY. The key itself is never printed.
 */
const API = 'https://rest.runpod.io/v1';
const key = process.env.RUNPOD_KEY ?? '';
const image = process.env.RUNPOD_PROBE_IMAGE ?? 'ghcr.io/permissionbrick/comfyui-runpod-worker:latest';
const keyMode = process.env.RUNPOD_PROBE_KEY_MODE ?? 'injected';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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

const python = String.raw`
import json, os, urllib.error, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def reply(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def do_GET(self):
        pod_id = os.environ.get('RUNPOD_POD_ID', '')
        key_mode = os.environ.get('RUNPOD_PROBE_KEY_MODE', 'injected')
        injected_key = os.environ.get('RUNPOD_API_KEY', '')
        management_key = os.environ.get('RUNPOD_TERMINATE_API_KEY', '')
        api_key = management_key if key_mode == 'management' else injected_key
        if self.path == '/status':
            return self.reply(200, {
                'key_mode': key_mode,
                'pod_id_present': bool(pod_id),
                'injected_key_present': bool(injected_key),
                'management_key_present': bool(management_key),
                'selected_key_present': bool(api_key),
            })
        if self.path != '/delete': return self.reply(404, {'error': 'not found'})
        if not pod_id or not api_key: return self.reply(503, {'error': 'selected credentials missing'})
        request = urllib.request.Request(
            'https://rest.runpod.io/v1/pods/' + pod_id,
            headers={'Authorization': 'Bearer ' + api_key}, method='DELETE')
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                response.read()
                return self.reply(200, {'delete_status': response.status})
        except urllib.error.HTTPError as error:
            return self.reply(error.code, {'delete_status': error.code, 'detail': error.read().decode(errors='replace')[:300]})
        except Exception as error:
            return self.reply(502, {'error': type(error).__name__, 'detail': str(error)[:300]})

ThreadingHTTPServer(('0.0.0.0', 8189), Handler).serve_forever()
`;

async function main() {
    if (!key) throw new Error('RUNPOD_KEY is required');
    if (!['injected', 'management'].includes(keyMode)) throw new Error('RUNPOD_PROBE_KEY_MODE must be injected or management');
    let podId;
    let deleted = false;
    try {
        const podEnv = { RUNPOD_PROBE_KEY_MODE: keyMode };
        if (keyMode === 'management') podEnv.RUNPOD_TERMINATE_API_KEY = key;
        const pod = await api('POST', '/pods', {
            name: `pod-${keyMode}-key-delete-proof-${Date.now()}`,
            imageName: image,
            gpuTypeIds: ['NVIDIA A40'], gpuTypePriority: 'custom', gpuCount: 1,
            cloudType: 'SECURE', containerDiskInGb: 50, volumeInGb: 0,
            allowedCudaVersions: ['13.0'], ports: ['8189/http'],
            env: podEnv,
            dockerStartCmd: ['python3', '-c', python],
        });
        podId = pod.id;
        console.log(JSON.stringify({ event: 'created', key_mode: keyMode, pod_id: podId, gpu: pod.machine?.gpuTypeId, cost_per_hour: pod.costPerHr }));
        const base = `https://${podId}-8189.proxy.runpod.net`;
        let status;
        for (let attempt = 0; attempt < 90; attempt++) {
            try {
                const response = await fetch(`${base}/status`, { signal: AbortSignal.timeout(10_000) });
                if (response.ok) { status = await response.json(); break; }
            } catch { /* image still starting */ }
            await sleep(10_000);
        }
        if (!status) throw new Error('diagnostic endpoint did not start within 15 minutes');
        console.log(JSON.stringify({ event: 'injected_credentials', ...status }));
        let deleteResponse;
        try {
            const response = await fetch(`${base}/delete`, { signal: AbortSignal.timeout(70_000) });
            deleteResponse = { status: response.status, body: await response.text() };
        } catch (error) {
            deleteResponse = { connection_ended: true, detail: String(error.message ?? error) };
        }
        console.log(JSON.stringify({ event: 'pod_delete_request', ...deleteResponse }));
        for (let attempt = 0; attempt < 30; attempt++) {
            const response = await fetch(`${API}/pods/${podId}`, { headers: { Authorization: `Bearer ${key}` } });
            if (response.status === 404) { deleted = true; break; }
            await sleep(2_000);
        }
        console.log(JSON.stringify({ event: 'account_verification', deleted }));
        if (!deleted) process.exitCode = 2;
    } finally {
        if (podId && !deleted) {
            try { await api('DELETE', `/pods/${podId}`); console.log(JSON.stringify({ event: 'account_cleanup', deleted: true })); }
            catch (error) { console.error(JSON.stringify({ event: 'account_cleanup', deleted: false, error: error.message })); }
        }
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
