import type { AgentEvent, AppConfig, CustomProvider, Provider } from '../types'
import { mockProvider } from './mock'
import { anthropicProvider, makeAnthropicProvider } from './anthropic'

// The default AnyCode vendor — the price source + backend the user intends to
// run later. STUBBED for now (per "我会作为供应商，但现在先不接入"): it calls nothing and
// just explains itself. Cost accounting elsewhere still uses official rates
// (see lib/pricing), so the price source is likewise a stub until wired.
const STUB_MSG =
  '⚠️  The default AnyCode provider is a stub — not connected yet. Use `/provider anthropic` ' +
  'with an `ANTHROPIC_API_KEY`, add a custom Anthropic-protocol provider, or `/provider mock` for the offline demo.'

const defaultProvider: Provider = {
  id: 'default',
  label: 'AnyCode (default vendor — not connected)',
  async *stream(): AsyncGenerator<string, void, unknown> { yield STUB_MSG },
  async *agent(): AsyncGenerator<AgentEvent, void, unknown> { yield { type: 'text', text: STUB_MSG } },
}

// Built-in providers, always available regardless of config.
const BUILTINS: Record<string, Provider> = {
  mock: mockProvider,
  anthropic: anthropicProvider,
  default: defaultProvider,
}

// Back-compat static map (used where a config isn't threaded through). Prefer
// buildProviders(config)/getProvider(config) so custom providers are included.
export const providers: Record<string, Provider> = BUILTINS

// A user-defined Anthropic-protocol provider → a live Provider. Billed at
// official rates regardless of the real vendor (see lib/pricing).
function fromCustom(c: CustomProvider): Provider {
  return makeAnthropicProvider({ id: c.id, label: c.label || c.id, baseUrl: c.baseUrl, apiKeyEnv: c.apiKeyEnv })
}

// Full provider registry for a config: built-ins + any custom providers. A
// custom provider may not shadow a built-in id.
export function buildProviders(config: AppConfig): Record<string, Provider> {
  const map: Record<string, Provider> = { ...BUILTINS }
  for (const c of config.customProviders ?? []) {
    if (!c?.id || map[c.id]) continue
    map[c.id] = fromCustom(c)
  }
  return map
}

export function getProvider(config: AppConfig): Provider {
  return buildProviders(config)[config.provider] ?? mockProvider
}

/** All selectable provider ids for a config (built-ins first, then custom). */
export function providerIds(config: AppConfig): string[] {
  return Object.keys(buildProviders(config))
}
