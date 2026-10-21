import assert from 'node:assert/strict';
import test from 'node:test';
import { historyStart, sharesChatPromptCache } from '../prompt-history.js';

const profile = (id, fields = {}) => ({ id, name: id, mode: 'cc', api: 'openrouter', model: `model-${id}`, preset: 'Default', ...fields });

test('keeps the whole chat while it is shorter than two batches', () => {
    for (const length of [0, 1, 9, 10, 15, 19]) {
        assert.equal(historyStart(length, 10), 0, `length ${length}`);
    }
});

test('moves the cut forward one batch at a time, keeping a batch to two batches minus one', () => {
    const starts = [];
    for (let length = 20; length < 50; length++) {
        const start = historyStart(length, 10);
        const kept = length - start;
        assert.ok(kept >= 10 && kept <= 19, `length ${length} keeps ${kept}`);
        starts.push(start);
    }
    assert.deepEqual([...new Set(starts)], [10, 20, 30]);
    assert.equal(starts.filter(start => start === 10).length, 10, 'the same cut for ten messages in a row');
    assert.equal(historyStart(29, 10), 10);
    assert.equal(historyStart(30, 10), 20);
});

test('keeps the whole chat without a usable batch size', () => {
    for (const batch of [0, -5, NaN, undefined, '']) {
        assert.equal(historyStart(500, batch), 0, `batch ${batch}`);
    }
    assert.equal(historyStart(35, '10'), 20);
    assert.equal(historyStart(35, 10.7), 20);
});

test('shares the chat cache when the request stays on the chat model', () => {
    const profiles = [profile('chat'), profile('image')];
    assert.equal(sharesChatPromptCache('', 'chat', profiles), true, 'no image-prompt profile');
    assert.equal(sharesChatPromptCache('image', undefined, profiles), true, 'no active profile, no switch');
    assert.equal(sharesChatPromptCache('chat', 'chat', profiles), true, 'the chat profile itself');
    assert.equal(sharesChatPromptCache('gone', 'chat', profiles), true, 'a deleted image-prompt profile, no switch');
});

test('tells another model, preset or endpoint from a twin of the chat profile', () => {
    const chat = profile('chat');
    const twin = { ...chat, id: 'twin', name: 'twin', 'start-reply-with': 'Sure,' };
    const inherits = { id: 'inherits', name: 'inherits', mode: 'cc', model: chat.model };
    const profiles = [
        chat,
        twin,
        inherits,
        profile('image'),
        { ...chat, id: 'preset', preset: 'Short' },
        { ...chat, id: 'url', 'api-url': 'http://elsewhere/v1' },
        { ...chat, id: 'post', 'prompt-post-processing': 'semi' },
    ];
    assert.equal(sharesChatPromptCache('twin', 'chat', profiles), true, 'same prompt and endpoint');
    assert.equal(sharesChatPromptCache('inherits', 'chat', profiles), true, 'fields left out keep the chat values');
    for (const id of ['image', 'preset', 'url', 'post']) {
        assert.equal(sharesChatPromptCache(id, 'chat', profiles), false, id);
    }
    assert.equal(sharesChatPromptCache('image', 'missing', profiles), false, 'an unknown chat profile is compared as different');
});
