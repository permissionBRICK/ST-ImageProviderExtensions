# ST-ImageProviderFallback

A drop-in replacement for SillyTavern’s built-in Image Generation extension with an ordered provider fallback chain.

Save complete image-provider configurations—OpenRouter, xAI, OpenAI, ComfyUI, Stable Diffusion WebUI, and the other providers supported by SillyTavern—then order them from preferred to last resort. If one request is unavailable, rejected by provider guidelines, or otherwise fails, the same prompt is tried against the next entry. Live settings are restored after every chain run.

## Install

1. In **Extensions → Manage extensions**, disable the built-in **Image Generation** extension. This replacement owns the same `/imagine` commands and UI, so both must not be active together.
2. Open **Extensions → Install extension** and enter:

```text
https://github.com/permissionBRICK/ST-ImageProviderFallback
```

3. Restart/reload SillyTavern, configure one provider at a time, and click **Add current settings** to build the chain.

Existing `extension_settings.sd` settings are reused. Legacy Primary/Secondary fallback settings are migrated automatically.

## Optional companion

[ST-ImagePromptProfiles](https://github.com/permissionBRICK/ST-ImagePromptProfiles) can route the LLM step that writes the image prompt through a cheaper Connection Manager profile. This replacement exposes a narrow hook for that companion; no other core patch is required.

## Compatibility and provenance

Requires SillyTavern 1.18.0+. This repository derives from SillyTavern’s AGPL-licensed Image Generation extension and retains its provider support. API keys remain in SillyTavern’s server-side secrets store; saved chain entries contain provider settings but no keys.

```bash
npm test
```

Licensed under AGPL-3.0. See [LICENSE](LICENSE).
