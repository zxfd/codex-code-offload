import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  archiveConversation,
  isChatGptAnswerGenerating,
  locateNewAssistantAnswer,
  pasteSystemClipboardText,
  waitForCurrentAllowedSelection,
  waitForNextAssistantAnswer,
} from '../providers/chatgpt-web.mjs';
import { assertChromeBrowser, isCoolingDown } from '../web-provider-runner.mjs';

function makeAnswer(text) {
  return {
    async count() { return 1; },
    first() { return this; },
    async isVisible() { return true; },
    async innerText() { return text; },
  };
}

function makeTab(counts, answer = makeAnswer('PROVIDER_OK:ChatGPT')) {
  let reads = 0;
  const groups = {
    async count() {
      const index = Math.min(reads++, counts.length - 1);
      return counts[index];
    },
    nth() { return answer; },
  };
  return {
    playwright: {
      locator() { return groups; },
      getByRole() {
        return { count: async () => 0 };
      },
      async waitForTimeout() {},
    },
  };
}

function makeArchiveTab({ listed = false, dismissibleRateLimit = false, unresolvedRateLimit = false } = {}) {
  const events = [];
  let archiveMenuVisible = false;
  let dialogVisible = dismissibleRateLimit || unresolvedRateLimit;
  const locator = ({ visible = true, onClick = async () => {}, href = null } = {}) => {
    const isVisible = () => typeof visible === 'function' ? visible() : visible;
    return {
    async count() { return isVisible() ? 1 : 0; },
    first() { return this; },
    nth() { return this; },
    async isVisible() { return isVisible(); },
    async click() { events.push('click'); await onClick(); },
    async getAttribute(name) { return name === 'href' ? href : null; },
    };
  };
  const tab = {
    events,
    reloads: 0,
    async url() { return 'https://chatgpt.com/c/test-conversation'; },
    async reload() { this.reloads += 1; events.push('reload'); },
    playwright: {
      getByRole(role, options = {}) {
        if (role === 'button' && options.name === '更多') {
          return locator({
            visible: () => !dialogVisible,
            onClick: async () => { archiveMenuVisible = true; },
          });
        }
        if (role === 'menuitem' && options.name === '归档') {
          return locator({
            visible: () => archiveMenuVisible,
            onClick: async () => { archiveMenuVisible = false; },
          });
        }
        if (role === 'dialog' && dialogVisible) {
          return {
            ...locator({ visible: () => dialogVisible }),
            getByRole(dialogRole, dialogOptions = {}) {
              const isAcknowledgement = dialogRole === 'button'
                && ['好', '明白了', '确定', 'OK'].includes(dialogOptions.name);
              return locator({
                visible: () => isAcknowledgement && dismissibleRateLimit && dialogVisible,
                onClick: async () => { dialogVisible = false; },
              });
            },
          };
        }
        if (role === 'dialog') return locator({ visible: false });
        return locator({ visible: false });
      },
      locator(selector) {
        if (selector === 'a' && listed) return locator({ href: '/c/test-conversation' });
        return locator({ visible: false });
      },
      async waitForTimeout() {},
      async waitForLoadState() {},
    },
  };
  return tab;
}

test('ChatGPT response confirmation rejects an old assistant message', async () => {
  const tab = makeTab([1, 1, 1]);
  await assert.rejects(
    locateNewAssistantAnswer({ tab, previousGroupCount: 1, timeoutMs: 5, pollMs: 1 }),
    /did not create a new assistant message/,
  );
});

test('ChatGPT response confirmation accepts only a newly created assistant message', async () => {
  const tab = makeTab([1, 1, 2]);
  const answer = await waitForNextAssistantAnswer({
    tab,
    previousGroupCount: 1,
    timeoutMs: 5_000,
    checkInterrupted: async () => {},
  });
  assert.equal(answer, 'PROVIDER_OK:ChatGPT');
});

test('ChatGPT waits for a temporarily missing current reasoning-strength control', async () => {
  let probes = 0;
  const tab = {
    playwright: {
      getByRole() {
        return { async count() { return 0; } };
      },
      async evaluate() {
        probes += 1;
        return probes >= 3 ? '极高' : null;
      },
      async waitForTimeout() {},
    },
  };
  const selection = await waitForCurrentAllowedSelection({
    tab,
    provider: { target: { reasoning_tiers: ['最高', '极高', '高', '中'] } },
    retryMs: 1_000,
  });
  assert.equal(probes, 3);
  assert.deepEqual(selection, {
    tier: '极高',
    label: '极高',
    unavailableTiers: [],
    selectionSource: 'current',
    modelVerified: false,
  });
});

test('legacy negative health entries do not suppress ChatGPT', () => {
  const now = Date.now();
  const targetSignature = 'same-target';
  assert.equal(isCoolingDown({
    status: 'unavailable',
    last_failure: new Date(now - 1_000).toISOString(),
    target_signature: targetSignature,
    current_target_signature: targetSignature,
  }, 300_000, now), false);
  assert.equal(isCoolingDown({
    status: 'unavailable',
    failure_protocol_version: 2,
    last_failure: new Date(now - 1_000).toISOString(),
    target_signature: targetSignature,
    current_target_signature: targetSignature,
  }, 300_000, now), true);
});

test('ChatGPT archives the conversation without refreshing before cleanup completes', async () => {
  const tab = makeArchiveTab();
  const cleanup = await archiveConversation({
    tab,
    provider: { target: { model: 'GPT-5.6 Sol' } },
  });
  assert.deepEqual(cleanup, {
    action: 'archive',
    confirmed: true,
    verification: 'sidebar_link_absent_without_reload',
  });
  assert.equal(tab.reloads, 0);
  assert.deepEqual(tab.events, ['click', 'click']);
});

test('ChatGPT archive cleanup accepts the closed menu without refreshing', async () => {
  const cleanup = await archiveConversation({
    tab: makeArchiveTab({ listed: true }),
    provider: { target: { model: 'GPT-5.6 Sol' } },
  });
  assert.equal(cleanup.verification, 'archive_menu_closed_without_reload');
});

test('ChatGPT archive cleanup dismisses a rate-limit dialog and retries', async () => {
  const tab = makeArchiveTab({ dismissibleRateLimit: true });
  const cleanup = await archiveConversation({
    tab,
    provider: { target: { model: 'GPT-5.6 Sol' } },
  });
  assert.equal(cleanup.confirmed, true);
  assert.equal(tab.reloads, 0);
  assert.deepEqual(tab.events, ['click', 'click', 'click']);
});

test('ChatGPT archive cleanup fails closed when the rate-limit dialog cannot close', async () => {
  await assert.rejects(
    archiveConversation({
      tab: makeArchiveTab({ unresolvedRateLimit: true }),
      provider: { target: { model: 'GPT-5.6 Sol' } },
    }),
    /conversation archive failed: conversation_more_control_not_found/,
  );
});

test('ChatGPT generation detection follows stop-generation button visibility', async () => {
  const makeTab = visibleByName => ({
    playwright: {
      getByRole(_role, options = {}) {
        const visible = Boolean(visibleByName[options.name]);
        return {
          async count() { return visible ? 1 : 0; },
          first() { return { async isVisible() { return visible; } }; },
        };
      },
    },
  });

  assert.equal(await isChatGptAnswerGenerating({
    tab: makeTab({
      '停止回答': true,
      'Stop generating': false,
      'Stop generating response': false,
    }),
  }), true);
  assert.equal(await isChatGptAnswerGenerating({
    tab: makeTab({
      '停止回答': false,
      'Stop generating': false,
      'Stop generating response': false,
    }),
  }), false);
});

test('Web-LLM runner accepts only the user Chrome browser', () => {
  assert.doesNotThrow(() => assertChromeBrowser({ tabs: { new: async () => {} } }, 'chrome'));
  assert.throws(
    () => assertChromeBrowser({ tabs: { new: async () => {} } }, 'iab'),
    /requires the user Chrome extension browser/,
  );
  assert.throws(
    () => assertChromeBrowser({ tabs: { new: async () => {} } }),
    /requires the user Chrome extension browser/,
  );
});

function makeClipboardPasteFixture({ systemText, pastedText = null, pressError = false, wrapPastedText = false }) {
  const state = { composerText: 'stale', virtualClipboardText: '', events: [] };
  const composer = {
    async fill(value) { state.events.push(`fill:${value.length}`); state.composerText = value; },
    async click() { state.events.push('click'); },
    async press(key) {
      state.events.push(`press:${key}`);
      if (pressError) throw new Error('virtual clipboard paste failed');
      if (key === 'ControlOrMeta+V') {
        const value = pastedText ?? state.virtualClipboardText;
        state.composerText = wrapPastedText ? `\n${value}\n` : value;
      }
    },
    async evaluate() { return state.composerText; },
  };
  const tab = {
    playwright: { async waitForTimeout() {} },
    clipboard: {
      async writeText(value) {
        state.events.push(`clipboard:${value.length}`);
        state.virtualClipboardText = value;
      },
    },
  };
  return { state, composer, tab, readSystemClipboardText: () => systemText };
}

test('ChatGPT system clipboard transport verifies the receipt and performs ControlOrMeta+V', async () => {
  const text = '<section>空投奖励 USDT</section>';
  const fixture = makeClipboardPasteFixture({ systemText: text });
  const result = await pasteSystemClipboardText({
    tab: fixture.tab,
    composer: fixture.composer,
    expectedBytes: Buffer.byteLength(text),
    expectedSha256: createHash('sha256').update(text).digest('hex'),
    readSystemClipboardText: fixture.readSystemClipboardText,
  });
  assert.equal(result.clipboardPasteConfirmed, true);
  assert.equal(result.clipboardSha256Confirmed, true);
  assert.equal(result.clipboardInsertionMethod, 'virtual_clipboard_paste');
  assert.equal(result.clipboardFillFallbackUsed, false);
  assert.deepEqual(fixture.state.events, [
    'fill:0',
    'click',
    `clipboard:${text.length}`,
    'press:ControlOrMeta+V',
    'clipboard:0',
  ]);
});

test('ChatGPT system clipboard verification ignores composer boundary whitespace', async () => {
  const text = '<section>空投奖励 USDT</section>';
  const fixture = makeClipboardPasteFixture({ systemText: text, wrapPastedText: true });
  const result = await pasteSystemClipboardText({
    tab: fixture.tab,
    composer: fixture.composer,
    expectedBytes: Buffer.byteLength(text),
    expectedSha256: createHash('sha256').update(text).digest('hex'),
    readSystemClipboardText: fixture.readSystemClipboardText,
  });
  assert.equal(result.clipboardPasteConfirmed, true);
  assert.equal(result.clipboardSha256Confirmed, true);
});

test('ChatGPT system clipboard transport fills only after an empty swallowed paste', async () => {
  const text = '<section>空投奖励 USDT</section>';
  const fixture = makeClipboardPasteFixture({ systemText: text, pastedText: '' });
  const result = await pasteSystemClipboardText({
    tab: fixture.tab,
    composer: fixture.composer,
    expectedBytes: Buffer.byteLength(text),
    expectedSha256: createHash('sha256').update(text).digest('hex'),
    timeoutMs: 100,
    swallowedPasteGraceMs: 0,
    readSystemClipboardText: fixture.readSystemClipboardText,
  });
  assert.equal(result.clipboardPasteConfirmed, true);
  assert.equal(result.clipboardSha256Confirmed, true);
  assert.equal(result.clipboardInsertionMethod, 'verified_fill_after_swallowed_paste');
  assert.equal(result.clipboardFillFallbackUsed, true);
  assert.deepEqual(fixture.state.events, [
    'fill:0',
    'click',
    `clipboard:${text.length}`,
    'press:ControlOrMeta+V',
    `fill:${text.length}`,
    'clipboard:0',
  ]);
});

test('ChatGPT system clipboard transport fails after paste when the composer digest mismatches', async () => {
  const text = '<section>expected</section>';
  const fixture = makeClipboardPasteFixture({ systemText: text, pastedText: '<section>wrong</section>' });
  await assert.rejects(
    pasteSystemClipboardText({
      tab: fixture.tab,
      composer: fixture.composer,
      expectedBytes: Buffer.byteLength(text),
      expectedSha256: createHash('sha256').update(text).digest('hex'),
      timeoutMs: 1,
      swallowedPasteGraceMs: 0,
      readSystemClipboardText: fixture.readSystemClipboardText,
    }),
    /paste could not be confirmed/u,
  );
  assert.deepEqual(fixture.state.events, [
    'fill:0',
    'click',
    `clipboard:${text.length}`,
    'press:ControlOrMeta+V',
    'clipboard:0',
  ]);
});

test('ChatGPT system clipboard transport rejects a changed system clipboard before paste', async () => {
  const expected = '<section>expected</section>';
  const fixture = makeClipboardPasteFixture({ systemText: '<section>changed</section>' });
  await assert.rejects(
    pasteSystemClipboardText({
      tab: fixture.tab,
      composer: fixture.composer,
      expectedBytes: Buffer.byteLength(expected),
      expectedSha256: createHash('sha256').update(expected).digest('hex'),
      readSystemClipboardText: fixture.readSystemClipboardText,
    }),
    /system clipboard receipt mismatch/u,
  );
  assert.deepEqual(fixture.state.events, []);
});

test('ChatGPT system clipboard bridge failures do not poison Provider health', async () => {
  const text = '<section>expected</section>';
  const fixture = makeClipboardPasteFixture({ systemText: text, pressError: true });
  await assert.rejects(
    pasteSystemClipboardText({
      tab: fixture.tab,
      composer: fixture.composer,
      expectedBytes: Buffer.byteLength(text),
      expectedSha256: createHash('sha256').update(text).digest('hex'),
      readSystemClipboardText: fixture.readSystemClipboardText,
    }),
    error => error?.failureClass === 'clipboard_transport_failed' && error?.cacheFailure === false,
  );
  assert.deepEqual(fixture.state.events, [
    'fill:0',
    'click',
    `clipboard:${text.length}`,
    'press:ControlOrMeta+V',
    'clipboard:0',
  ]);
});
