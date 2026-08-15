import test from 'node:test';
import assert from 'node:assert/strict';

import { parseStructuredAssistantResponse } from '../structured-response.mjs';

const requestUrl = 'https://example.test/article';

function validPayload(overrides = {}) {
  return {
    source_url: requestUrl,
    extraction_summary: '提取稳定度字段',
    data: { target: '稳定度', selector: 'article[data-task-section] .stability' },
    verification: 'selector matched',
    ...overrides,
  };
}

function json(overrides = {}) {
  return JSON.stringify(validPayload(overrides));
}

test('parses a new assistant JSON response with markdown fence, link, and explanation', () => {
  const answer = `结果如下：\n\n[查看来源](${requestUrl})\n\n\`\`\`json\n${json()}\n\`\`\`\n以上为当前页面提取结果。`;
  assert.deepEqual(parseStructuredAssistantResponse(answer, { requestUrl }), validPayload());
});

test('accepts only a complete structured JSON object', () => {
  assert.equal(parseStructuredAssistantResponse(json(), { requestUrl }).data.target, '稳定度');
  for (const answer of [
    '{"source_url":"https://example.test/article","data":{"target":"稳定度","selector":"x"}',
    '这是一段普通说明，没有结构化结果。',
    JSON.stringify({ status: 'blocked', reason: 'insufficient context' }),
  ]) {
    assert.throws(() => parseStructuredAssistantResponse(answer, { requestUrl }), /structured response invalid/u);
  }
});

test('rejects source mismatch and missing required targets', () => {
  assert.throws(
    () => parseStructuredAssistantResponse(json({ source_url: 'https://other.test/article' }), { requestUrl }),
    /source_url_mismatch/u,
  );
  assert.throws(
    () => parseStructuredAssistantResponse(json({ data: { target: '稳定度' } }), { requestUrl }),
    /data_selector_missing/u,
  );
  assert.throws(
    () => parseStructuredAssistantResponse(json({ data: { selector: 'x' } }), { requestUrl }),
    /data_target_missing/u,
  );
});

test('does not treat a truncated response as a valid structured result', () => {
  let error;
  try {
    parseStructuredAssistantResponse(`${json().slice(0, -2)}\n[External analysis truncated at 8,000 characters.]`, { requestUrl });
  } catch (caught) {
    error = caught;
  }
  assert.match(error.message, /truncated_json/u);
  assert.equal(error.formatRetryable, true);
});

test('accepts BOM and whitespace without rewriting JSON', () => {
  assert.deepEqual(parseStructuredAssistantResponse(`\uFEFF \n${json()} \n`, { requestUrl }), validPayload());
});

test('does not locally repair an unescaped JSON string', () => {
  let error;
  try {
    parseStructuredAssistantResponse('{"source_url":"https://example.test/article","extraction_summary":"bad "quote"","data":{"target":"稳定度","selector":"x"}}', { requestUrl });
  } catch (caught) {
    error = caught;
  }
  assert.match(error.message, /not_a_complete_json_object/u);
  assert.equal(error.formatRetryable, true);
});
