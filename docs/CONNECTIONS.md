# Connect models through Pi

Bastion uses the installed Pi model registry, agent sessions, and provider adapters. Connection selection never grants tools: every agent tool remains routed through Bastion's policy gateway and sandbox.

## In the console

1. Open Console and connect with your operator token. This authenticates to Bastion; it is separate from provider credentials.
2. Open **Connections**. Enter a connection name.
3. Choose **Continue with ChatGPT** when local sign-in is configured. Follow **Open ChatGPT sign-in**, authorize in your browser, return to Bastion, select an available account model, and save. Only account-visible models supported by the installed Pi Responses adapter are offered.
4. Alternatively, expand **Connect with an API key**, choose a provider and model, paste that provider's API key, and save. OpenAI API, Anthropic/Claude API, and DeepSeek use their provider-issued API keys. A Claude Code subscription is not an Anthropic Console API key. The catalog reflects installed adapter metadata, not a guarantee of account access or quota.
5. **Use controller model** explicitly saves the controller's existing API-key connection, including an administrator-configured custom provider such as OrcaRouter. The key is never returned to the browser.
6. Select or create a project, then choose its **Project model**. New tasks use this choice for planning and for every generated agent.
7. Describe the task and start it. No per-agent configuration is required. To use several providers, select a saved workflow under Advanced, expand **Optional agent models**, choose overrides, and save. This creates an immutable workflow version. Existing runs keep their original assignments.

Changing a project model affects newly saved workflows, not existing saved workflows. A missing, disabled, or foreign connection fails closed; it is not silently replaced by another account. Older workflows without connection metadata retain the legacy controller configuration, which is clearly labelled as not historical model evidence in exports.

Disabling a connection erases its stored secret and blocks future use in Bastion. It does not cancel requests already sent or revoke authorization at the provider. For ChatGPT, use **Sign in again** on the saved connection to reauthorize its registered account. Provider-side access can also be removed in that provider's account settings.

## Controller configuration

Set `PROVIDER_CREDENTIAL_KEY` to 32 cryptographically random bytes encoded as 64 hexadecimal characters. Generate it with Node's `crypto.randomBytes(32).toString("hex")` and save it directly in the controller's private environment. Never commit it, expose it as a Vite variable, or put it in a workflow. Back it up separately from the database. Credentials are AES-256-GCM encrypted and bound to the owning operator and connection ID.

ChatGPT sign-in is optional and uses the official open-source dynamic registration flow. Set `CHATGPT_OAUTH_CONFIG` to a JSON object containing all these fields, with no defaults:

| Field | Value / source |
| --- | --- |
| `issuer` | `https://auth.openai.com` |
| `authorizeUrl` | `https://auth.openai.com/api/accounts/authorize` |
| `tokenUrl` | `https://auth.openai.com/api/accounts/oauth/token` |
| `jwksUrl` | `https://auth.openai.com/.well-known/jwks.json` |
| `resource` | `https://api.openai.com/v1` |
| `redirectUri` | HTTP loopback URL on `127.0.0.1`, the configured `API_PORT`, and path `/auth/chatgpt/callback` |
| `hostId` | A UUIDv4 prefixed with `urn:uuid:`, persisted for this controller installation (a bare UUID is rejected) |
| `attemptTtlMs` | Positive sign-in expiry interval in milliseconds |
| `maxPending` | Positive maximum simultaneous pending sign-ins |

Open sign-in on the controller's computer. A remote hosted controller needs a different registered web sign-in integration; changing the loopback callback hostname is not a substitute. The API must already be listening before starting sign-in. Configuration errors stop startup.

The implementation validates state, PKCE, signed ID-token identity, nonce, issuer, audience, expiration, and granted plan-use scope. Auth codes are single-use, callback request logging is disabled, and token responses are not logged or returned to the UI. Account models are requested with the same access token used by Pi for inference. Pi's Responses adapter sends `stream: true` and `store: false`.

This is a single-controller deployment: pending sign-ins and refresh serialization are process-local. Restarting the controller discards pending sign-ins; saved encrypted connections survive. Multiple controller processes sharing the same accounts require a distributed refresh lock and shared authorization-attempt storage before deployment.

## Validation boundaries

Automated tests exercise encryption, cross-operator isolation, immutable assignments, signed OAuth responses, missing grants, nonce/audience mismatch, callback replay, refresh, and disabled connections. Test providers exist only in automated tests. A real ChatGPT consent flow still requires the user's account, and API-key model access is confirmed only by a real request. Saving a key does not spend model credits or claim available quota.

Official references: [ChatGPT registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference), [accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions), [Claude account login guidance](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account).


### Account models newer than Pi's bundled catalog

ChatGPT model choices come from the signed-in account's live model discovery response. For models absent from Pi's catalog, set `CHATGPT_MODEL_CONFIG` to an explicit custom-model JSON profile with `api: "openai-responses"`, input modalities, reasoning support, context and output budgets, and accounting costs. Bastion persists that profile with the chosen connection and registers the exact account-returned model ID in Pi. It never substitutes a different model or endpoint. Hidden models are excluded and arbitrary model IDs cannot be submitted by the client.

The profile's limits are operator-selected runtime budgets, not advertised model capacity. Zero accounting costs indicate no separately tracked per-token API charge for the subscription connection; they do not mean the subscription is free or unlimited. Use only capabilities supported by the selected account models. The local development profile uses text input with reasoning disabled and conservative context/output budgets. Successful sign-in and model registration do not themselves verify inference or account quota.
