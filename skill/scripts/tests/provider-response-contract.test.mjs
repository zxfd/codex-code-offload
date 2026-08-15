import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertConfirmedAssistantResponse,
  confirmedAssistantResponseMetadata,
  markStructuredJsonAvailable,
} from '../provider-response.mjs';

function result(overrides = {}) {
  return {
    answer: '当前 assistant 响应',
    ...confirmedAssistantResponseMetadata(),
    ...overrides,
  };
}

test('response metadata exposes consistent camelCase and snake_case fields', () => {
  const metadata = confirmedAssistantResponseMetadata();
  assert.equal(metadata.responseConfirmed, true);
  assert.equal(metadata.response_confirmed, true);
  assert.equal(metadata.response_is_new, true);
  assert.equal(metadata.responseComplete, true);
  assert.equal(metadata.response_complete, true);
  assert.equal(metadata.generationComplete, true);
  assert.equal(metadata.generation_complete, true);
  assert.equal(metadata.structuredJsonAvailable, false);
  assert.equal(metadata.structured_json_available, false);
  assert.deepEqual(assertConfirmedAssistantResponse(result()), {
    responseConfirmed: true,
    response_confirmed: true,
    response_is_new: true,
    responseComplete: true,
    response_complete: true,
    generationComplete: true,
    generation_complete: true,
    structuredJsonAvailable: false,
    structured_json_available: false,
  });
});

test('missing or old assistant confirmation cannot pass the response contract', () => {
  assert.throws(() => assertConfirmedAssistantResponse({ answer: 'old' }), /provider response contract failed/u);
  assert.throws(() => assertConfirmedAssistantResponse(result({ response_is_new: false })), /request_scoped_new_assistant/u);
  assert.throws(() => assertConfirmedAssistantResponse(result({ generationComplete: false })), /generation_is_not_complete/u);
  assert.throws(() => assertConfirmedAssistantResponse(result({ structured_json_available: true })), /missing_or_inconsistent/u);
});

test('structured validation flips availability only after a structured object exists', () => {
  const structured = markStructuredJsonAvailable(result(), { source_url: 'https://example.test', data: {} });
  assert.equal(structured.structuredJsonAvailable, true);
  assert.equal(structured.structured_json_available, true);
  assert.equal(assertConfirmedAssistantResponse(structured).structuredJsonAvailable, true);
  assert.throws(() => markStructuredJsonAvailable(result(), null), /structured_result_is_not_an_object/u);
});
