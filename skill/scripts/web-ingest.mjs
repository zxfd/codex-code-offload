import { runProviderFallback } from './web-provider-runner.mjs';
import {
  DEFAULT_PROCESSING_POLICY,
  captureVisualArtifacts,
  classifyModality,
  collectSignalsFromTab,
  ingestSingleUrlWithLocalContext as ingestCanonical,
  isNeedMoreContext,
} from '../../skills/web-ingest/scripts/web-ingest.mjs';

export {
  DEFAULT_PROCESSING_POLICY,
  captureVisualArtifacts,
  classifyModality,
  collectSignalsFromTab,
  isNeedMoreContext,
};

// Keep the historical agentchat entry compatible without making the standalone
// implementation depend on a concrete Provider runner.
export async function ingestSingleUrlWithLocalContext(options = {}) {
  return ingestCanonical({
    ...options,
    runProvider: options.runProvider === undefined ? runProviderFallback : options.runProvider,
  });
}
