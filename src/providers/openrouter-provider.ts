import { OPENROUTER_DEFAULT_BASE_URL } from "../constants";
import { OpenAIProvider, type OpenAIProviderDeps } from "./openai-provider";

/** OpenRouter's Chat Completions endpoint follows the OpenAI API format. */
export class OpenRouterProvider extends OpenAIProvider {
  constructor(deps: OpenAIProviderDeps) {
    super({
      ...deps,
      providerId: "openrouter",
      displayName: "OpenRouter",
      defaultBaseUrl: OPENROUTER_DEFAULT_BASE_URL,
    });
  }
}
