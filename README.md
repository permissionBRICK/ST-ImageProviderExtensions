# ST-ImageProviderExtensions

A drop-in replacement for SillyTavern’s built-in Image Generation extension. It preserves the full permissionBRICK image-generation feature set while packaging it as a normally installed extension.

Included features:

- Ordered provider fallback across every image backend supported by SillyTavern.
- RunPod on-demand pod status, warm-up, shutdown, copy-URL, model catalog, and chat-bar status control.
- Cold RunPod presets expose canonical ComfyUI sampler and scheduler choices without starting the pod; saved custom values remain available.
- Tagged reference-image library with automatic LLM selection and `%reference_image%` ComfyUI workflow injection.
- Editable generated-image prompts: edit the image message, then swipe right to generate from the revised prompt.
- Per-workflow model, text-encoder, VAE, and LoRA selection plus configurable LoRA strength. ComfyUI workflows can use `%text_encoder%`, with the workflow editor visibly reporting whether the placeholder is present.
- Custom image-wand entries and the extended image-generation settings UI.
- Integrated Connection Manager profile selection for routing image-prompt generation through a cheaper LLM while preserving full chat context, then restoring the chat profile.
- Bundled server plugin for bounded ComfyUI discovery (models, text encoders, samplers, schedulers, VAEs, and LoRAs), so no SillyTavern source patch is required. Discovery coalesces simultaneous option loads into one cached `/object_info` request, allows 15 seconds for large custom-node installations, and recognizes compatible custom loader nodes by their input types.
- Optional RunPod lazy-proxy backend published separately as [`ST-RunPodProxy`](https://github.com/permissionBRICK/ST-RunPodProxy).

Save complete image-provider configurations—OpenRouter, xAI, OpenAI, ComfyUI, Stable Diffusion WebUI, and the other providers supported by SillyTavern—then order them from preferred to last resort. If one request is unavailable, rejected by provider guidelines, or otherwise fails, the same prompt is tried against the next entry. Live settings are restored after every chain run.

## Install

1. In **Extensions → Manage extensions**, disable the built-in **Image Generation** extension. This replacement owns the same `/imagine` commands and UI, so both must not be active together.
2. Open **Extensions → Install extension** and enter:

```text
https://github.com/permissionBRICK/ST-ImageProviderExtensions
```

3. Enable server plugins in `config.yaml`:

   ```yaml
   enableServerPlugins: true
   ```

4. From the SillyTavern directory, install this same repository as the server companion and restart SillyTavern:

   ```bash
   node plugins.js install https://github.com/permissionBRICK/ST-ImageProviderExtensions
   ```

5. Reload SillyTavern. Configure providers under **Image Generation**, and use **Add current settings** to build a fallback chain if desired.

Existing `extension_settings.sd` settings are reused. Legacy Primary/Secondary fallback settings are migrated automatically.

If `ST-ImagePromptProfiles` was previously installed, its selected profile is migrated automatically. Disable or uninstall that extension after updating to 2.0.0; it is no longer needed.

The same repository is installed in both supported SillyTavern locations: the browser extension supplies the UI/generation logic, and the server plugin supplies bounded ComfyUI metadata and LoRA discovery. The extension does not patch SillyTavern source files.

## RunPod lazy proxy

Install [`permissionBRICK/ST-RunPodProxy`](https://github.com/permissionBRICK/ST-RunPodProxy) for the on-demand backend used by the extension's warm-up, shutdown, model-catalog, heartbeat, and provider-fallback controls. It ships a Docker image and Unraid template for normal automatic updates. RunPod, Hugging Face, Civitai, and GitHub tokens stay in the proxy service environment; they are never committed or stored in browser extension settings.

## Image-prompt cost routing

Choose **Prompt generation connection profile** inside Image Generation to use a less expensive LLM for the text-to-image prompt step. The request still uses SillyTavern's chat-aware generation pipeline and full context. The extension temporarily activates that profile, waits for it to connect, generates the prompt, and restores the chat's prior profile. Leave the selector empty to use the active chat model.

## Compatibility and provenance

Requires SillyTavern 1.18.0+. This repository derives from SillyTavern’s AGPL-licensed Image Generation extension and retains its provider support. API keys remain in SillyTavern’s server-side secrets store; saved chain entries and RunPod settings contain configuration and URLs but no API keys.

```bash
npm test
```

Licensed under AGPL-3.0. See [LICENSE](LICENSE).
