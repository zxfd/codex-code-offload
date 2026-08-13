import { runDeepSeekExpert } from '../deepseek-expert-browser.mjs';

export async function run({ provider, tab, promptPath, timeoutMs, continuation }) {
  const result = await runDeepSeekExpert({ tab, promptPath, timeoutMs, continuation });
  if (result.mode !== provider.target.mode) {
    throw new Error(`DeepSeek mode mismatch: expected ${provider.target.mode}, got ${result.mode}`);
  }
  return result;
}
