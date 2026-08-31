# ST-ImageProviderExtensions

A complete Image Generation extension and server companion for SillyTavern. It replaces the built-in Image Generation extension with provider orchestration, richer ComfyUI workflows, reference-image tools, prompt routing, and a fully managed on-demand RunPod backend.

Despite the historical repository name, this is no longer only an “ordered providers” add-on. The browser extension owns the Image Generation UI and commands; its server plugin owns ComfyUI discovery and the optional RunPod lifecycle. No SillyTavern source patch or separate proxy service is required.

## Features

- Ordered fallback across every image backend supported by SillyTavern. Save complete provider configurations, order them from preferred to last resort, and automatically retry the same prompt when a provider is unavailable or rejects a request.
- Managed RunPod Pods: explicit warm-up, model prefetch, readiness/status controls, generation proxying, immediate shutdown, existing-pod adoption, and automatic idle termination—all inside the SillyTavern server plugin.
- Server-owned RunPod cleanup terminates idle Pods after 15 minutes by default. Compatible worker images can also run an optional delayed self-reaper when given a dedicated restricted Pod-management key.
- A model catalog for cold RunPod Pods, including model, LoRA, text-encoder, and VAE downloads. Changing settings or attempting generation never starts a stopped Pod.
- Tagged reference-image library with automatic LLM selection and `%reference_image%` ComfyUI workflow injection.
- Editable generated-image prompts: edit the image message, then swipe right to generate from the revised prompt.
- Per-workflow model, text-encoder, VAE, and LoRA selections, configurable LoRA strength, custom placeholders, and an integrated workflow editor.
- Connection Manager profile selection for routing the image-prompt step through a cheaper LLM while preserving full chat context and restoring the previous chat profile afterward.
- Custom image-wand entries and the extended Image Generation settings UI.
- Bounded and cached ComfyUI discovery for models, text encoders, samplers, schedulers, VAEs, and LoRAs, including compatible custom loader nodes.

## Install

1. In **Extensions → Manage extensions**, disable the built-in **Image Generation** extension. Both extensions own the same `/imagine` commands and UI, so they must not be active together.
2. Install the browser extension from **Extensions → Install extension**:

   ```text
   https://github.com/permissionBRICK/ST-ImageProviderExtensions
   ```

3. Enable server plugins in SillyTavern's `config.yaml`:

   ```yaml
   enableServerPlugins: true
   ```

4. From the SillyTavern directory, install the same repository as the server companion and restart SillyTavern:

   ```bash
   node plugins.js install https://github.com/permissionBRICK/ST-ImageProviderExtensions
   ```

5. Reload SillyTavern and configure providers under **Image Generation**. Use **Add current settings** to build an optional fallback chain.

The extension reuses existing `extension_settings.sd` settings. Legacy Primary/Secondary fallback slots become an ordered chain automatically. Existing configurations that used `ST-RunPodProxy` are migrated from a standard ComfyUI URL to the integrated **Managed RunPod Pod** server type. The old proxy container can be removed after the SillyTavern server environment is configured and the migration is verified.

If `ST-ImagePromptProfiles` was previously installed, its selected profile is imported automatically. That extension can then be disabled or uninstalled.

## Managed RunPod configuration

Set the following environment variables on the SillyTavern server/container, then restart it:

| Variable | Default | Purpose |
|---|---:|---|
| `RUNPOD_KEY` | — | RunPod account API key. Required to enable managed Pods. It remains server-side and is never sent to the browser or worker. |
| `RUNPOD_POD_TERMINATE_KEY` | empty | Optional separate Restricted API key with Pod-management access, passed to the worker only for emergency self-termination. Never reuse `RUNPOD_KEY` here. |
| `HF_TOKEN` | empty | Optional Hugging Face download token passed to the worker. |
| `CIVITAI_TOKEN` | empty | Optional Civitai download token passed to the worker. |
| `GITHUB_TOKEN` | empty | Optional GitHub token passed to the worker for gated/private assets. |
| `RUNPOD_IDLE_SECONDS` | `900` | Server-side idle timeout before full Pod termination. |
| `RUNPOD_FRONTEND_LEASE_SECONDS` | `300` | Grace period for sleeping/throttled browser tabs. |
| `RUNPOD_KEEPALIVE_SECONDS` | `60` | Server-to-worker activity heartbeat interval. |
| `RUNPOD_SELF_REAP_SECONDS` | `1200` | Pod-local idle timeout when `RUNPOD_POD_TERMINATE_KEY` is configured; otherwise forced to `0`. Deliberately longer than the server timeout. |
| `RUNPOD_SELF_REAP_BOOT_GRACE_SECONDS` | `2400` | Maximum initial boot/model-download grace before the self-reaper arms. |
| `RUNPOD_IMAGE` | `ghcr.io/permissionbrick/comfyui-runpod-worker:latest` | Worker image. Pod-local reaping requires a compatible image. |
| `RUNPOD_GPU_A5000_TYPE` | `NVIDIA RTX A5000` | RunPod GPU ID behind the default **RTX A5000 — Value** profile. |
| `RUNPOD_GPU_5090_TYPE` | `NVIDIA GeForce RTX 5090` | RunPod GPU ID behind the **RTX 5090 — Fast** profile. |
| `RUNPOD_CUDA_VERSIONS` | `13.0` | Comma-separated allowed CUDA versions. |
| `RUNPOD_CLOUD_TYPE` | `SECURE` | RunPod cloud type. |
| `RUNPOD_DATACENTERS` | empty | Optional comma-separated datacenter restriction. |
| `RUNPOD_START_TIMEOUT` | `1500` | Seconds allowed for Pod boot and model preparation. |

Select **ComfyUI → Managed RunPod Pod** in Image Generation. The Pod starts only when **Warm up** is pressed. Image requests never implicitly provision a stopped Pod, allowing the fallback chain to continue instead. A green status dot means ready, orange means provisioning/downloading, and red means off.

Choose **RTX A5000 — Value** (the default) or **RTX 5090 — Fast** in the RunPod section. Warm-up requests that exact Secure Cloud card; it does not silently substitute another GPU. Changing the selection only updates configuration. Press Warm up to apply it, or shut down the current Pod first when using the chat-bar toggle.

RunPod injects a Pod ID and a Pod-scoped API key into each Pod, but a live API test confirmed that the injected key receives HTTP 404 when it tries to delete its own Pod. The worker therefore ignores that key. Pod-local reaping is enabled only with `RUNPOD_POD_TERMINATE_KEY`, which should be a separate [Restricted API key](https://docs.runpod.io/get-started/api-keys) granting only the minimum Pod access. Without it, the server-side watchdog remains fully functional and authoritative.

## Krea 2 Turbo example

[`examples/Krea2_Turbo_Managed_RunPod.json`](examples/Krea2_Turbo_Managed_RunPod.json) is a known-working ComfyUI API workflow mirrored from the Krea 2 configuration used in production. It uses the extension placeholders for prompt, negative prompt, model, text encoder, VAE, LoRA, LoRA strength, sampler, scheduler, seed, dimensions, steps, CFG, and denoise. The default worker image includes the tooling nodes used by its optional-LoRA switch.

The setup helper installs the workflow, adds/updates both catalog entries below, and creates a **Managed RunPod — Krea 2 Turbo** preset. It backs up `settings.json` first and is safe to run repeatedly:

```bash
node scripts/setup-krea2.mjs --data-dir /path/to/SillyTavern/data/default-user --activate
```

Omit `--activate` to add the preset without replacing the live provider selection. For the standard SillyTavern Docker layout used by the NAS installation:

```bash
docker exec sillytavern node \
  /home/node/app/plugins/ST-ImageProviderExtensions/scripts/setup-krea2.mjs \
  --data-dir /home/node/app/data/default-user \
  --activate
docker restart sillytavern
```

The script configures these exact worker destinations:

| Selection | Worker destination | Download source |
|---|---|---|
| LUSTIFY v10 Krea 2 checkpoint | `checkpoints/lustifyNSFWCheckpoint_v10Krea2.safetensors` | `https://civitai.com/api/download/models/3112728?fileId=2996235` |
| Krea 2 text encoder | `text_encoders/qwen3vl_4b_bf16.safetensors` | `Comfy-Org/Krea-2` on Hugging Face |
| Krea 2 VAE | `vae/qwen_image_vae.safetensors` | `Comfy-Org/Krea-2` on Hugging Face |
| Krea 2 Turbo four-step LoRA | `loras/krea2_turbo_4step_rank_64_lora_latest.safetensors` | `lvladikov/Krea2-Turbo-Distill-4step-LoRA` on Hugging Face |

The preset uses Euler/Simple, 4 steps, CFG 1, LoRA strength 1, and 1920×1088 output. Configure `RUNPOD_KEY` plus `CIVITAI_TOKEN` and, when required by the repositories, `HF_TOKEN` on the SillyTavern server before warming the Pod. The helper deliberately does not read or write secrets.

For manual setup, copy the example JSON into `<user-data>/user/workflows/`, choose **ComfyUI → Managed RunPod Pod**, enter the four destination/URL pairs above in the RunPod model catalog, and select the same values shown in the preset. Press **Warm up** to create the Pod and download the active files.

## Image-prompt cost routing

Choose **Prompt generation connection profile** to use another LLM for the text-to-image prompt step. The extension still uses SillyTavern's chat-aware generation pipeline and full context. It temporarily activates the selected profile, waits for it to connect, generates the prompt, and restores the prior profile. Leave the selector empty to use the active chat model.

## Compatibility and development

Requires SillyTavern 1.18.0+. This repository derives from SillyTavern's AGPL-licensed Image Generation extension and retains its provider support. Provider API keys remain in SillyTavern's server-side secrets store; browser settings and fallback presets contain configuration, not secrets.

```bash
npm install
npm test
```

Licensed under AGPL-3.0. See [LICENSE](LICENSE).
