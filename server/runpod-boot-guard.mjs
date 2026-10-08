// Download counters come from Docker and boot-models' received-chunk logs.
// File sizes and the worker's static /status percentages are not progress.
const units = { '': 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12 };

function lines(entries, since) {
    return (entries ?? []).flatMap(line => {
        const match = String(line).match(/^(\d{4}-\d\d-\d\dT\S+)\s+(.*)$/);
        const time = match ? Date.parse(match[1]) : NaN;
        return Number.isFinite(time) && time >= since ? [{ time, text: match[2] }] : [];
    }).sort((a, b) => a.time - b.time);
}

function rate(series, after, window) {
    if (series.length < 2) return null;
    const [time, bytes] = series.at(-1);
    const span = time - series[0][0];
    window = Math.min(window, span);
    if (span < after || window <= 0) return null;
    const boundary = time - window;
    const before = series.findLast(([t]) => t <= boundary);
    const next = series.find(([t]) => t > boundary);
    if (!before || !next || time - before[0] < window / 2) return null;
    // boot-models reports every GB. Interpolate the window boundary between
    // received-byte samples so a 31s sample interval doesn't hide a slow host.
    const baseline = before[1] + (next[1] - before[1]) * (boundary - before[0]) / (next[0] - before[0]);
    return (bytes - baseline) / window / 1000; // milliseconds -> decimal MB/s
}

export class BootGuard {
    constructor(meta, files, options) {
        this.meta = meta;
        this.files = new Map(files.map(file => [file.dest.replace(/^\/+/, ''), Number(file.size) || 0]));
        this.options = options;
        this.containerSeconds = null;
        this.pullRate = null;
        this.modelRate = null;
        this.quiet = false;
        this.nextLogsAt = 0;
        this.nextReportAt = 0;
    }

    describe() {
        const m = this.meta;
        return `tier=${m.tier ?? 'any'} machineId=${m.machineId ?? '?'} dataCenter=${m.dataCenter ?? '?'} uplink=${m.uplink ?? '?'}Mbps container=${this.containerSeconds ?? '?'}s pull=${this.pullRate?.toFixed(1) ?? '?'}MB/s models=${this.modelRate?.toFixed(1) ?? '?'}MB/s`;
    }

    observe(logs, now, up = false) {
        const o = this.options;
        // Pod logs can have whole-second timestamps or a slightly skewed clock.
        const system = lines(logs?.system, this.meta.created - 60000);
        const container = lines(logs?.container, this.meta.created - 60000);
        const layers = new Map();
        const pull = [];
        let lastIncrease = 0;
        let pulled = false;
        let started = null;
        for (const { time, text } of system) {
            const progress = text.match(/\b([0-9a-f]{12})\b.*?Downloading\D*?([\d.]+)\s*([kKMGT]?)i?B\s*\/\s*([\d.]+)\s*([kKMGT]?)i?B/);
            const done = text.match(/\b([0-9a-f]{12})\b.*?(Download complete|Verifying Checksum|Extracting|Pull complete)/);
            if (progress) {
                const bytes = Number(progress[2]) * units[progress[3]];
                const total = Number(progress[4]) * units[progress[5]];
                const previous = layers.get(progress[1]);
                let offset = previous?.offset ?? 0;
                // Docker resumes a Range retry with a new remaining-byte total.
                // Count the bytes already received before that resumed request.
                if (previous && bytes < previous.rawDone) offset = previous.done;
                layers.set(progress[1], { rawDone: bytes, offset, done: offset + bytes, total: offset + total });
            }
            else if (done && layers.has(done[1])) layers.get(done[1]).done = layers.get(done[1]).total;
            else {
                if (/^Status: .*image/i.test(text)) pulled = true;
                if (pulled && /start container/i.test(text)) started ??= time;
                continue;
            }
            const bytes = [...layers.values()].reduce((sum, layer) => sum + layer.done, 0);
            if (!pull.length || bytes > pull.at(-1)[1]) lastIncrease = pull.length;
            pull.push([time, bytes]);
        }
        started ??= container[0]?.time ?? (up ? now : null);
        if (this.containerSeconds === null && started !== null) this.containerSeconds = Math.max(0, (started - this.meta.created) / 1000);
        // Flat extraction/Pull complete samples must not dilute download speed.
        this.pullRate = rate(pull.slice(0, lastIncrease + 1), 0, Number.MAX_SAFE_INTEGER);
        const pullRate = rate(pull, o.pullAfterMs, o.windowMs);
        if (!this.quiet && this.containerSeconds === null && !pulled && pullRate !== null) {
            const total = [...layers.values()].reduce((sum, layer) => sum + layer.total, 0);
            const bytes = pull.at(-1)[1];
            // Stale/truncated log feeds are not evidence of a stalled download.
            if (now - pull.at(-1)[0] <= o.windowMs && bytes < o.doneFraction * total && pullRate < o.pullMin) {
                return `image pull ${pullRate.toFixed(1)} MB/s (<${o.pullMin}) after ${((pull.at(-1)[0] - pull[0][0]) / 1000).toFixed(0)}s, ${(bytes / 1e9).toFixed(2)}/${(total / 1e9).toFixed(2)}GB`;
            }
        }
        if (!this.quiet && this.containerSeconds === null && now - this.meta.created > o.containerDeadlineMs) {
            return `container not up after ${((now - this.meta.created) / 1000).toFixed(0)}s (deadline ${o.containerDeadlineMs / 1000}s)`;
        }

        // Rebuild aggregate received bytes from per-file counters. A retry resets
        // the window; OK/SKIP finish a file; READY ends the download phase.
        const received = new Map();
        const cached = new Set();
        const sizes = new Map(this.files);
        let samples = [];
        const active = new Set();
        for (const { time, text } of container) {
            const get = text.match(/boot-models: GET (\S+) <- .* \(([\d.]+)GB, ranges=/);
            const progress = text.match(/boot-models: \.\.\. (\S+) ([\d.]+)GB @/);
            const ok = text.match(/boot-models: OK (\S+) \(([\d.]+)GB in/);
            const skip = text.match(/boot-models: SKIP (\S+)/);
            if (/boot-models: READY/.test(text)) { active.clear(); continue; }
            if (/boot-models: attempt .* failed/.test(text)) { samples = []; continue; }
            const dest = (get ?? progress ?? ok ?? skip)?.[1];
            if (!dest || (this.files.size && !this.files.has(dest))) continue;
            if (get) {
                if (received.has(dest)) samples = [];
                received.set(dest, 0);
                if (!sizes.get(dest)) sizes.set(dest, Number(get[2]) * 1e9);
                active.add(dest);
            } else if (progress) {
                const bytes = Number(progress[2]) * 1e9;
                if (bytes < (received.get(dest) ?? 0)) samples = [];
                received.set(dest, bytes);
                active.add(dest);
            } else {
                active.delete(dest);
                if (skip) cached.add(dest);
                received.set(dest, skip ? 0 : sizes.get(dest) || Number(ok?.[2] ?? 0) * 1e9);
            }
            samples.push([time, [...received.values()].reduce((sum, bytes) => sum + bytes, 0)]);
        }
        this.modelRate = rate(samples, 0, Number.MAX_SAFE_INTEGER);
        const modelRate = rate(samples, o.modelAfterMs, o.windowMs);
        const total = [...sizes.values()].reduce((sum, bytes) => sum + bytes, 0);
        const known = sizes.size && [...sizes.values()].every(bytes => bytes > 0);
        const last = samples.at(-1);
        const completed = (last?.[1] ?? 0) + [...cached].reduce((sum, dest) => sum + (sizes.get(dest) ?? 0), 0);
        if (!this.quiet && active.size && known && modelRate !== null && now - last[0] <= o.windowMs && completed < total * o.doneFraction && modelRate < o.modelMin) {
            return `model download ${modelRate.toFixed(1)} MB/s (<${o.modelMin}) after ${((last[0] - samples[0][0]) / 1000).toFixed(0)}s, ${(last[1] / 1e9).toFixed(2)}/${(total / 1e9).toFixed(2)}GB`;
        }
        return null;
    }
}
