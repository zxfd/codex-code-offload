const NEW_ASSISTANT_CONFIRMATION = 'new_assistant_message';

export function confirmedAssistantResponseMetadata({ structuredJsonAvailable = false } = {}) {
  const structured = structuredJsonAvailable === true;
  return {
    responseConfirmed: true,
    response_confirmed: true,
    response_is_new: true,
    responseConfirmation: NEW_ASSISTANT_CONFIRMATION,
    response_confirmation: NEW_ASSISTANT_CONFIRMATION,
    responseComplete: true,
    response_complete: true,
    generationComplete: true,
    generation_complete: true,
    structuredJsonAvailable: structured,
    structured_json_available: structured,
  };
}

export class ProviderResponseContractError extends Error {
  constructor(reason, metadata = {}) {
    super(`provider response contract failed: ${reason}`);
    this.name = 'ProviderResponseContractError';
    this.code = 'PROVIDER_RESPONSE_CONTRACT_INVALID';
    this.cacheFailure = false;
    this.sendStarted = true;
    this.failureClass = 'provider_response_contract_invalid';
    Object.assign(this, metadata);
  }
}

export function assertConfirmedAssistantResponse(result) {
  const responseConfirmed = result?.responseConfirmed === true && result?.response_confirmed === true;
  const responseIsNew = result?.response_is_new === true;
  const confirmation = result?.responseConfirmation === NEW_ASSISTANT_CONFIRMATION
    || result?.response_confirmation === NEW_ASSISTANT_CONFIRMATION;
  const responseComplete = result?.responseComplete === true && result?.response_complete === true;
  const generationComplete = result?.generationComplete === true && result?.generation_complete === true;
  const structuredFlagPresent = typeof result?.structuredJsonAvailable === 'boolean'
    && typeof result?.structured_json_available === 'boolean'
    && result.structuredJsonAvailable === result.structured_json_available;

  if (!responseConfirmed || !responseIsNew || !confirmation) {
    throw new ProviderResponseContractError('response_is_not_request_scoped_new_assistant');
  }
  if (!responseComplete) {
    throw new ProviderResponseContractError('response_is_not_complete');
  }
  if (!generationComplete) {
    throw new ProviderResponseContractError('generation_is_not_complete');
  }
  if (!structuredFlagPresent) {
    throw new ProviderResponseContractError('structured_json_availability_is_missing_or_inconsistent');
  }
  if (typeof result?.answer !== 'string' || !result.answer.trim()) {
    throw new ProviderResponseContractError('assistant_answer_is_empty');
  }
  return {
    responseConfirmed: true,
    response_confirmed: true,
    response_is_new: true,
    responseComplete: true,
    response_complete: true,
    generationComplete: true,
    generation_complete: true,
    structuredJsonAvailable: result.structuredJsonAvailable,
    structured_json_available: result.structured_json_available,
  };
}

export function markStructuredJsonAvailable(result, structuredResult) {
  if (!structuredResult || typeof structuredResult !== 'object' || Array.isArray(structuredResult)) {
    throw new ProviderResponseContractError('structured_result_is_not_an_object');
  }
  return {
    ...result,
    ...confirmedAssistantResponseMetadata({ structuredJsonAvailable: true }),
    structuredResult,
  };
}
