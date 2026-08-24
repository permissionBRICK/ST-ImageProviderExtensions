# ST-ImageProviderFallback

A drop-in replacement for SillyTavern’s built-in Image Generation extension. It preserves the full permissionBRICK image-generation feature set while packaging it as a normally installed extension.

Included features:

- Ordered provider fallback across every image backend supported by SillyTavern.
- RunPod on-demand pod status, warm-up, shutdown, copy-URL, model catalog, and chat-bar status control.
- Tagged reference-image library with automatic LLM selection and `%reference_image%` ComfyUI workflow injection.
- Per-workflow model, VAE, and LoRA memory plus configurable LoRA strength.
- Custom image-wand entries and the extended image-generation settings UI.
- Companion hook for routing image-prompt generation through ST-ImagePromptProfiles.

Save complete image-provider configurations—OpenRouter, xAI, OpenAI, ComfyUI, Stable Diffusion WebUI, and the other providers supported by SillyTavern—then order them from preferred to last resort. If one request is unavailable, rejected by provider guidelines, or otherwise fails, the same prompt is tried against the next entry. Live settings are restored after every chain run.

## Install

1. In **Extensions → Manage extensions**, disable the built-in **Image Generation** extension. This replacement owns the same `/imagine` commands and UI, so both must not be active together.
2. Open **Extensions → Install extension** and enter:

```text
https://github.com/permissionBRICK/ST-ImageProviderFallback
```

3. Restart/reload SillyTavern. Configure providers under **Image Generation**, and use **Add current settings** to build a fallback chain if desired.

Existing `extension_settings.sd` settings are reused. Legacy Primary/Secondary fallback settings are migrated automatically.

## Optional companion

[ST-ImagePromptProfiles](https://github.com/permissionBRICK/ST-ImagePromptProfiles) can route the LLM step that writes the image prompt through a cheaper Connection Manager profile. This replacement exposes a narrow hook for that companion; no other core patch is required.

## Compatibility and provenance

Requires SillyTavern 1.18.0+. This repository derives from SillyTavern’s AGPL-licensed Image Generation extension and retains its provider support. API keys remain in SillyTavern’s server-side secrets store; saved chain entries and RunPod settings contain configuration and URLs but no API keys.

```bash
npm test
```

Licensed under AGPL-3.0. See [LICENSE](LICENSE).
