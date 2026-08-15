const TRUNCATION_MARKER = /\[External analysis truncated at [\d,]+ characters\.\]/u;

function fail(reason, { formatRetryable = false } = {}) {
  const error = new Error(`structured response invalid: ${reason}`);
  error.code = 'STRUCTURED_RESPONSE_INVALID';
  error.failureClass = 'structured_response_invalid';
  error.structuredReason = reason;
  error.formatRetryable = formatRetryable;
  error.cacheFailure = false;
  error.sendStarted = true;
  throw error;
}

function scanJsonObjects(text) {
  const candidates = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (start >= 0 && inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"' && start >= 0) {
      inString = true;
      continue;
    }
    if (character === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0) {
        candidates.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return { candidates, truncated: start >= 0 || depth !== 0 || inString };
}

function parseCandidates(answer) {
  const text = String(answer || '').trim();
  if (!text) fail('empty_answer');
  if (TRUNCATION_MARKER.test(text)) fail('truncated_json', { formatRetryable: true });
  const { candidates, truncated } = scanJsonObjects(text);
  const parsed = [];
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === 'object' && !Array.isArray(value)) parsed.push(value);
    } catch {
      // Explanatory text can contain brace-like fragments. Only complete JSON
      // objects are candidates; malformed candidates are ignored below.
    }
  }
  if (parsed.length === 0) {
    fail(truncated ? 'truncated_json' : 'not_a_complete_json_object', { formatRetryable: true });
  }
  if (parsed.length > 1) fail('multiple_json_objects_are_ambiguous', { formatRetryable: true });
  return parsed[0];
}

export function parseStructuredAssistantResponse(answer, { requestUrl } = {}) {
  if (typeof requestUrl !== 'string' || !requestUrl.trim()) fail('request_url_missing');
  const payload = parseCandidates(answer);
  if (payload.status === 'blocked') fail('blocked');
  if (typeof payload.source_url !== 'string' || payload.source_url !== requestUrl) {
    fail('source_url_mismatch');
  }
  if (typeof payload.extraction_summary !== 'string' || !payload.extraction_summary.trim()) {
    fail('extraction_summary_missing');
  }
  if (!payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) {
    fail('data_missing');
  }
  if (typeof payload.data.target !== 'string' || !payload.data.target.trim()) {
    fail('data_target_missing');
  }
  if (typeof payload.data.selector !== 'string' || !payload.data.selector.trim()) {
    fail('data_selector_missing');
  }
  return payload;
}
