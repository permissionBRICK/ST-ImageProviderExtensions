// Connection profile fields that decide where a request goes or how its prompt is built.
// A profile that leaves a field out keeps the active value when it is applied.
export const PROMPT_CACHE_PROFILE_FIELDS = Object.freeze([
    'api', 'api-url', 'model', 'preset', 'proxy', 'secret-id', 'prompt-post-processing',
    'sysprompt', 'sysprompt-state', 'instruct', 'instruct-state', 'context', 'regex-preset',
]);

/**
 * Whether a request through the image-prompt profile can reuse the chat's prompt cache:
 * the same model and endpoint with the same prompt shaping as the chat's active profile.
 * Without a profile switch (no image-prompt profile, no active profile, the same profile, or
 * an image-prompt profile that no longer exists) the request goes to the chat's model.
 * @param {string} targetProfileId Image-prompt profile id ('' = none).
 * @param {string|undefined} currentProfileId The chat's active profile id.
 * @param {object[]} profiles Connection Manager profiles.
 * @returns {boolean}
 */
export function sharesChatPromptCache(targetProfileId, currentProfileId, profiles) {
    if (!targetProfileId || !currentProfileId || targetProfileId === currentProfileId) {
        return true;
    }
    const list = Array.isArray(profiles) ? profiles : [];
    const target = list.find(profile => profile?.id === targetProfileId);
    const current = list.find(profile => profile?.id === currentProfileId);
    if (!target) {
        return true;
    }
    if (!current) {
        return false;
    }
    return PROMPT_CACHE_PROFILE_FIELDS.every(field => target[field] === undefined || target[field] === current[field]);
}

/**
 * Where the chat history starts when a request carries only recent messages. It keeps
 * `batch` to `2 * batch - 1` messages: the start moves forward `batch` messages at a time,
 * so the requests in between share their prefix in the provider's prompt cache.
 * @param {number} length Messages in the prompt's chat history.
 * @param {number} batch Fewest messages to keep (0 or less: the whole chat).
 * @returns {number} Index of the first message to keep.
 */
export function historyStart(length, batch) {
    const size = Math.floor(Number(batch));
    if (!(size > 0) || length < 2 * size) {
        return 0;
    }
    return (Math.floor(length / size) - 1) * size;
}
