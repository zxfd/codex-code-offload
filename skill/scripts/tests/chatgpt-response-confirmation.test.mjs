import test from 'node:test';
import assert from 'node:assert/strict';

import {
  locateNewAssistantAnswer,
  waitForNextAssistantAnswer,
} from '../providers/chatgpt-web.mjs';
import { isCoolingDown } from '../web-provider-runner.mjs';

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
