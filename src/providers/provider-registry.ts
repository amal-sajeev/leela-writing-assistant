import { PROVIDER_DISPLAY_NAMES } from "../constants";
import type { ProviderId } from "../types";
import type { AIProvider } from "./provider";
import { ProviderError } from "./provider-errors";

/**
 * Holds the available provider implementations and resolves the active one
 * (specification sections 62 and 70). Knows nothing about vendor request shapes.
 */
export class ProviderRegistry {
  private readonly providers = new Map<ProviderId, AIProvider>();

  constructor(private readonly getActiveId: () => ProviderId) {}

  register(provider: AIProvider): void {
    this.providers.set(provider.id, provider);
  }

  has(id: ProviderId): boolean {
    return this.providers.has(id);
  }

  get(id: ProviderId): AIProvider | undefined {
    return this.providers.get(id);
  }

  list(): AIProvider[] {
    return [...this.providers.values()];
  }

  /** Throws a normalized ProviderError when the requested provider is unavailable. */
  require(id: ProviderId): AIProvider {
    const provider = this.providers.get(id);
    if (!provider) {
      throw new ProviderError(
        "provider_error",
        `${PROVIDER_DISPLAY_NAMES[id]} is not available in this build.`,
        false,
      );
    }
    return provider;
  }

  active(): AIProvider {
    return this.require(this.getActiveId());
  }

  clear(): void {
    this.providers.clear();
  }
}
