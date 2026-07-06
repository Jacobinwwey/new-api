# 2026-07-05 v0.1 - OpenCode Remote Browser Authorization Implementation Plan

## English

### Scope

This document records the implementation plan and current engineering progress for adding an OpenCode account connector to New API. The target workflow is:

1. A root user opens New API Admin Web.
2. New API starts an isolated browser session on the remote server.
3. The operator signs in through the official OpenCode authorization entrypoint.
4. New API extracts the OpenCode account material required by the OpenCode Go upstream integration.
5. New API stores sensitive material encrypted and activates a selected New API channel.

The official authorization entrypoint validated during investigation is:

```text
https://opencode.ai/auth
```

The observed unauthenticated redirect chain is:

```text
https://opencode.ai/auth
  -> /auth/authorize
  -> https://auth.opencode.ai/authorize?client_id=app&redirect_uri=https%3A%2F%2Fopencode.ai%2Fauth%2Fcallback&response_type=code&state=...
```

The page exposes official Google and GitHub authorization links. New API must not collect Google passwords or emulate Google password login.

### Privacy and Repository Hygiene

This plan intentionally excludes all operator-specific or deployment-specific secrets:

- No API keys.
- No cookies.
- No workspace IDs.
- No account emails.
- No local browser profile paths.
- No remote database contents.
- No private Tailscale host details.

Implementation must preserve this boundary. Runtime extraction output belongs in encrypted database rows and runtime logs must never contain raw OpenCode API keys, cookies, workspace IDs, or authorization payloads.

### Current Code Architecture Assessment

The fork's current `main` already provides several useful extension points:

- Backend follows `router -> controller -> service -> model`.
- Root-only API groups already exist, for example `/api/option`, `/api/performance`, `/api/custom-oauth-provider`, and `/api/system-task`.
- Channel management is mature and permission-gated through `router/channel-router.go` and `service/authz`.
- Channel secrets already live in `model.Channel.Key`, but current channel APIs are built around manual key entry.
- Codex OAuth refresh exists in `service/codex_credential_refresh.go`, proving the codebase already accepts provider credentials stored as structured JSON in channel keys when a provider requires it.
- The frontend uses TanStack file routes and feature directories under `web/default/src/features`, which is suitable for an isolated `opencode-accounts` feature module.

The current `main` is missing the pieces required by the requested OpenCode connector:

- No `opencode_accounts` model.
- No root-only OpenCode account API group.
- No reversible encryption helper for stored provider secrets. `common/crypto.go` currently provides HMAC and bcrypt only; HMAC is not decryptable and cannot store API keys or cookies.
- No remote isolated browser session manager.
- No CDP screenshot/click bridge or noVNC bridge.
- No frontend account-switching window.
- No extractor for OpenCode cookies, local storage, session storage, or authenticated API probes.
- No audited activation flow that updates a New API channel from a selected OpenCode account.

### Prior Requirement Comparison

| Requirement | Current fork `main` state | Gap | Direction |
|---|---|---|---|
| Use New API, not opencode-go or opencode-cc directly | New API has channel abstraction and relay flow | Need OpenCode account material to feed existing channels | Build account connector inside New API |
| Remote Web authorization, not local CLI | No remote browser subsystem exists | Need remote browser lifecycle, viewport bridge, extraction API | Add Root-only CDP-backed isolated browser sessions |
| Google login supported | Current New API OAuth is for New API users, not OpenCode account import | Must not collect Google password | Let operator log in on official OpenCode/Google pages |
| Multi-account switching | Channels support multiple keys/channels manually | No account inventory or activate action | Add account table and bind accounts to channels |
| Maximize cache-hit accounting for `glm-5.2` | Relay usage conversion now preserves cached-token details across Chat-style and Responses-style fields, and channel-affinity usage stats record cache-hit counters | Real warm-cache behavior still needs live OpenCode credentials and repeated `glm-5.2` calls | Keep the compatibility tests in-repo, then verify live cache-hit accounting after account import and activation |
| Robust secret handling | RootAuth and secure verification patterns exist | No reversible encryption for imported provider secrets | Add AES-GCM secret encryption using stable `CRYPTO_SECRET` |
| No clipboard limit change | Unrelated to this connector | No action required | Preserve existing Deskflow-related choice outside this repository |

### Cache-Related Work Status

The current fork now represents the Responses usage compatibility fix that previously existed only in the remote work stream:

- `UsageFromChatUsage` preserves cache details in both `PromptTokensDetails` and `InputTokensDetails`.
- Channel-affinity usage-cache stats record cached-token and prompt-cache-hit counters with relay-format-aware rate modes.
- Tests cover both the compatibility conversion and usage-cache observation paths. The channel-affinity usage-cache tests now allocate deterministic per-test cache keys, so repeated fast runs cannot merge counters through coarse clock resolution.
- The default Codex channel-affinity rule now includes `glm-*` models as well as `gpt-*`, so `glm-5.2` requests on `/v1/responses` can use the same `prompt_cache_key` affinity and Codex header pass-through path.
- The default Codex channel-affinity rule now falls back to the `Session_id` request header when the request body does not carry `prompt_cache_key`. The body key remains first priority, and the fallback value is hashed before it enters the affinity cache key.
- The default Codex channel-affinity param-override template now runs `sync_fields` between `header:session_id` and `json:prompt_cache_key` before passing Codex headers upstream. This keeps New API routing affinity and the upstream prompt-cache key aligned when a Codex-compatible client supplies only one side of the pair.
- `scripts/glm-cache-smoke.mjs` now provides a repeatable, secret-redacted cache-hit smoke runner for the live E2E phase. It reads relay/admin credentials only from environment variables, sends repeated `/v1/responses` calls with a stable `prompt_cache_key`/`Session_id`, and optionally queries `/api/log/channel_affinity_usage_cache` by the non-secret key fingerprint. Its default input is now a deterministic long cache-probe prefix instead of a one-line prompt, while `--input`/`GLM_CACHE_SMOKE_INPUT` can still override it. When admin stats are available, the runner can execute explicit warm-up requests before the baseline snapshot, then records baseline and final usage-cache snapshots and reports a per-run `stats.delta`. Optional thresholds (`--require-stats`, `--min-request-hit-rate`, `--min-stats-hit-rate`, `--min-cache-signal-tokens`) produce a `checks` summary and make the CLI exit non-zero when the measured cache-hit evidence is below target. Failure output now redacts the configured base URL, origin, host, hostname, and configured input prompt in raw, JSON-escaped, and truncated-prefix forms in addition to relay/admin/cache secrets. This keeps too-short prompt false negatives, historical accumulated counters, cold-start misses, deployment-detail leakage, prompt leakage, and manual JSON-reading mistakes from being mistaken for steady-state cache-hit evidence.
- Channel-affinity cache keys now store a stable hash of the affinity value instead of the raw `prompt_cache_key` or request-header value. This preserves routing affinity while avoiding raw session/cache identifiers in Redis keys or cache error logs.

The remaining cache question is not a repository representation issue; it is a live upstream behavior question. Real `glm-5.2` warm-cache verification still requires an imported OpenCode subscription account and repeated calls through New API. Request-body replay/cache-key stability should still be validated during the live E2E instead of assumed complete.

### Recommended Architecture

Use a New API native connector rather than a separate local CLI:

```text
New API Admin Web
  -> OpenCode Accounts feature
  -> Root-only OpenCode account API
  -> Isolated remote Chromium session
  -> Official OpenCode authorization flow
  -> Extractor with confidence-ranked candidates
  -> Encrypted account storage
  -> Atomic channel activation
  -> Existing relay and billing pipeline
```

The browser bridge should start with Chrome DevTools Protocol instead of noVNC:

- The remote environment already has Node.js, Chromium, Xvfb, and dbus.
- A noVNC stack would add system dependencies and a larger exposed surface.
- CDP screenshot/click/key events are sufficient for account authorization.
- noVNC can remain a later fallback if complex manual browser interaction becomes necessary.

### Backend Plan

Add a model with sanitized public response fields and encrypted private fields:

```text
opencode_accounts
  id
  label
  email_ciphertext
  workspace_id_ciphertext
  api_key_ciphertext
  cookie_ciphertext
  channel_id
  quota_raw
  quota_limit
  quota_used
  login_status
  active
  last_extracted_at
  last_quota_checked_at
  created_at
  updated_at
```

Public API responses must mask sensitive values. A root user can see whether a value exists and when it was refreshed, not the raw secret.

Add a Root-only route group:

```text
GET    /api/opencode/accounts
POST   /api/opencode/accounts
PUT    /api/opencode/accounts/:id
DELETE /api/opencode/accounts/:id

POST   /api/opencode/accounts/:id/login/start
GET    /api/opencode/accounts/:id/login/status
GET    /api/opencode/accounts/:id/login/screenshot
POST   /api/opencode/accounts/:id/login/click
POST   /api/opencode/accounts/:id/login/key
POST   /api/opencode/accounts/:id/login/extract
POST   /api/opencode/accounts/:id/login/stop

POST   /api/opencode/accounts/:id/quota/refresh
POST   /api/opencode/accounts/:id/activate
```

The account service should own the complete operation:

- Validate account labels and channel bindings at the API edge.
- Allocate one browser session per account.
- Keep browser process state out of the database.
- Store only durable account metadata and encrypted extracted material.
- Activate an account by updating the bound New API channel in one transaction and refreshing channel runtime cache after commit.

### Secret Encryption Plan

Add reversible encryption in `common` using AES-GCM:

- Key source: `common.CryptoSecret`.
- Ciphertext format: versioned string, for example `v1:<base64 nonce+ciphertext>`.
- Empty plaintext remains empty to simplify optional fields.
- Decryption must fail closed.

Deployment must use a stable `CRYPTO_SECRET`. Falling back to a generated session secret is acceptable for sessions but not acceptable for durable encrypted provider credentials.

### Extractor Plan

The extractor should be candidate-based, not hard-coded to one browser storage key:

1. Read cookies for the OpenCode authorization domains.
2. Read local storage and session storage for the current OpenCode pages.
3. Scan JSON-like values recursively for likely account fields.
4. Optionally perform same-origin authenticated probes from inside the browser session.
5. Rank candidates for API key, workspace ID, quota, and account identity.
6. Persist only confirmed or high-confidence values.

This avoids brittle coupling to OpenCode's current frontend implementation.

### Frontend Plan

Add a feature module:

```text
web/default/src/features/opencode-accounts
web/default/src/routes/_authenticated/opencode-accounts/index.tsx
```

The page should provide:

- Account list.
- Login session status.
- Remote browser viewport.
- Login, extract, refresh quota, activate, stop, and delete actions.
- Masked secret indicators.
- Channel binding selector.

This should be a work-focused admin surface, not a landing page. Use existing table, dialog, toast, and loading patterns.

### Testing Plan

Backend tests:

- AES-GCM round-trip and wrong-key failure.
- Account create/update validation.
- Sensitive fields omitted from public response.
- Activate updates only the intended channel and refreshes channel cache after commit.
- Extractor candidate ranking with fixture browser-state JSON.
- Responses usage conversion preserves cached token fields for accounting.

Frontend checks:

- Typecheck.
- Component-level happy path for account list and session controls where local test infrastructure allows.
- Manual browser-session smoke test on a non-secret test account.

End-to-end verification:

- Start New API.
- Start remote browser session.
- Complete official OpenCode login manually.
- Extract account material.
- Activate a bound channel.
- Run repeated `glm-5.2` calls through New API.
- Confirm cache-hit accounting remains visible in New API logs.

### Progress

| Area | Status | Notes |
|---|---|---|
| Authorization URL validation | Done | Public redirect chain validated. |
| Fork `main` inspection | Done | Current extension points and gaps identified. |
| Privacy boundary | Done | This document contains no secrets or deployment-specific account material. |
| Cache accounting parity in fork | Implemented | `UsageFromChatUsage` now preserves cached-token details in both Chat-style and Responses-style accounting fields. |
| Cache accounting test isolation | Implemented locally | Channel-affinity usage-cache tests now use deterministic per-test cache keys instead of wall-clock nanosecond keys. This removes cross-test counter bleed in fast repeated runs and makes cache-hit accounting verification stronger before real `glm-5.2` E2E. |
| `glm-5.2` Codex affinity coverage | Implemented locally | The default Codex channel-affinity rule now matches both `gpt-*` and `glm-*` models on `/v1/responses`, using `prompt_cache_key` as the key source and the same Codex header pass-through template. This fixes a concrete cache-hit path gap where `glm-5.2` would skip affinity despite carrying a stable prompt cache key. |
| Codex `Session_id` affinity fallback | Implemented locally | The default Codex channel-affinity rule now tries `request_header:Session_id` after `gjson:prompt_cache_key`. This covers Codex-compatible clients that preserve the session header but omit `prompt_cache_key` in the body, while keeping body `prompt_cache_key` as the stronger first source. Backend and frontend templates are synchronized, and regression coverage proves `glm-5.2` can hit affinity through the fallback. |
| Codex session/cache-key synchronization | Implemented locally | The default Codex param-override template now performs `sync_fields` from `header:session_id` to `json:prompt_cache_key` and the reverse direction when only the body key exists, then passes the Codex headers upstream. Regression coverage proves a `glm-5.2` request with only `Session_id` reaches the upstream JSON body with a stable `prompt_cache_key`. This improves upstream cache-key stability but still does not prove live OpenCode/GLM warm-cache behavior. |
| `glm-5.2` cache-hit smoke runner | Implemented locally | Added `scripts/glm-cache-smoke.mjs` plus Node tests. The runner keeps API key, optional admin token/cookie, optional cache key, and optional custom input in environment variables or CLI arguments; output includes only the model, rule/group, warm-up/request counters, usage totals, channel-affinity stats, threshold `checks`, and the 8-character `key_fp`. If Admin auth is missing, relay calls still run and stats are marked skipped unless `--require-stats` is configured. HTTP 200 business failures with `success:false` are treated as failures and redacted before reporting, so auth/config failures are not miscounted as cache misses. Admin stats now support a deterministic long default cache-probe prompt, explicit warm-up requests before baseline, then baseline/final snapshots plus `stats.delta` for the current measured run, with non-negative clamping and `reset_detected` when counters rotate or reset. Configured checks make the CLI exit non-zero when request usage or stats deltas miss the target. Failure output also redacts the configured base URL, origin, host, hostname, and input prompt in raw, JSON-escaped, and truncated-prefix forms, so deployment details and workload text are not printed during failed live smoke attempts. This makes the future live E2E repeatable and CI-friendly without committing or printing real credentials, deployment-specific endpoints, or prompt content. |
| OpenCode E2E preflight runner | Implemented locally | Added `scripts/opencode-e2e-preflight.mjs` plus Node tests. The runner performs non-mutating GET checks for `/api/status`, root-only OpenCode diagnostics, OpenCode account readiness summary, and the channel-affinity usage stats endpoint required by the later cache smoke. It reads root auth only from environment variables, emits only endpoint status, credential key-source class, account counts, credential-integrity counts, missing-field category counts, and the count of accounts that are both active and activation-ready. It exits non-zero when required root auth, stable credential key, affinity stats readability, minimum activation-ready account counts, minimum active account counts, or minimum active-ready account counts are not satisfied. The active-ready gate prevents a false pass where one account is active while a different account is activation-ready. It also redacts the configured deployment URL from endpoint errors. This turns the first post-rollout verification step into a machine gate without printing root tokens, cookies, raw emails, workspace IDs, raw missing-field names, account secrets, deployment URLs, or local deployment paths. |
| Channel-affinity raw key privacy | Implemented locally | Channel-affinity cache suffixes now use a stable SHA1-derived key part for the affinity value rather than embedding raw `prompt_cache_key` or request-header values. Regression coverage proves the cache suffix keeps rule/model/group context while omitting the original affinity value. This intentionally invalidates old in-memory/Redis affinity entries, which is acceptable because the cache is opportunistic and will re-warm. |
| Channel-affinity cache-stats UI quality gate | Implemented locally | The cache-stats dialog row-building logic is now a pure helper with regression tests for hit-rate, cached-token, target fallback, and empty-state rows. The dialog no longer depends on a promise chain or nested ternary rendering, and the full `src/features/system-settings/general/channel-affinity` frontend directory now passes targeted oxlint. This improves cache observability quality before real `glm-5.2` E2E, but it does not replace live upstream cache-hit verification. |
| OpenCode account model | Implemented | Added `opencode_accounts` model, migration registration, validation, encrypted secret storage, and masked public view. |
| Reversible encryption helper | Implemented | Added AES-GCM `EncryptSecret` / `DecryptSecret` using `CRYPTO_SECRET`-derived key and versioned ciphertext. |
| Root-only OpenCode account API | Implemented | Added CRUD, login-session, extract, quota refresh, and activate routes under `/api/opencode/accounts`. Quota refresh now accepts quota-only browser payloads and updates structured `quota_limit` / `quota_used` fields. |
| Quota candidate classification | Implemented | Quota limit and raw display detection now exclude used/usage/consumed keys, preventing `quota.used` values from being recorded as quota limits or quota raw display values when browser payload traversal order varies. |
| Remote browser sidecar | Implemented and smoke-tested on the remote host without credentials | Added Node CDP + Xvfb sidecar with start/status/screenshot/click/key/extract/stop actions. Remote smoke tests covered `about:blank` and the official OpenCode authorization entrypoint without logging in. Extract now probes likely OpenCode same-site JSON resources loaded by the page, excluding static assets and OAuth payload URLs, so API-key/workspace/quota candidates are not limited to browser storage. |
| Sensitive browser input transport | Implemented | `login/key` now sends typed text to the Node sidecar through stdin instead of argv, so Google/OpenCode login text does not appear in process command lines. The sidecar rejects legacy `--text` input. |
| Login status URL sanitization | Implemented | Status responses now strip query strings and fragments from HTTP(S) browser URLs before returning them through New API, preventing OAuth `state`, `code`, or similar authorization payloads from reaching the Admin UI/API response. |
| Login status idempotency | Implemented | `login/status` now returns a successful `stopped` status when no sidecar state file exists, so frontend polling and page refreshes do not surface false failures before a login session has started. |
| Login-session ownership guard | Implemented locally | Login start/status/screenshot/click/key/stop controller actions now confirm the durable OpenCode account row exists before invoking the sidecar. Missing account IDs return the same sanitized account-not-found business failure and do not create or touch browser artifacts. |
| Browser startup diagnostics | Implemented | The sidecar now watches Chromium and Xvfb `error`/early-`exit` events during startup and returns structured JSON failures, avoiding opaque CDP timeouts when browser dependencies are missing or misconfigured. |
| Sidecar path resolution | Implemented and remotely verified | The Go service now resolves the sidecar script from both the process working directory and the running executable directory, walking upward from each. This keeps remote browser operations stable when systemd working directory and clean artifact directory differ; the pushed `main` artifact verified this path through remote build, focused tests, restart, HTTP smoke, and sidecar empty-state status. |
| Stale browser state handling | Implemented | `login/start` now reuses an existing browser only when the recorded PID is alive and the CDP endpoint is reachable; stale PID/state combinations fall through to a fresh browser startup. |
| Stop lifecycle cleanup | Implemented | `login/stop` now waits for recorded browser/Xvfb processes to exit after SIGTERM and falls back to a force kill, reducing stale browser process leakage before returning `stopped`. |
| Delete lifecycle cleanup | Implemented locally | Deleting an OpenCode account now purges the account's browser session artifacts before deleting the database row: the sidecar stops recorded processes and removes the account state file plus browser profile directory. If purge fails, the account is preserved so the operator can retry cleanup instead of losing the durable handle while browser artifacts may still exist. |
| Delete missing-account guard | Implemented locally | Delete now confirms the durable OpenCode account row exists before invoking sidecar purge. Missing account IDs return the same sanitized business error used by update/extract/quota flows and do not trigger browser artifact cleanup for an unowned account ID. |
| Sidecar state corruption handling | Implemented locally | Missing state remains an idempotent `stopped` session, but unreadable or invalid state now returns a structured sidecar failure. Start/status/stop/purge no longer treat corrupt state as "no session", so account deletion fails closed instead of deleting the durable row while an orphaned browser profile or process may remain. |
| Screenshot transient retry | Implemented | `login/screenshot` now retries transient browser/CDP screenshot failures for this read-only action, matching the remote smoke finding where an immediate retry succeeded after one screenshot failure. |
| Sidecar symlinked artifact entrypoint | Implemented and locally verified | The sidecar CLI now resolves `process.argv[1]` through realpath before comparing it with `import.meta.url`, so executing the script through the `new-api-current` symlink still runs `main()`. This closes a deployment-only false-smoke risk where direct release paths worked but symlinked artifact paths produced no output. |
| Extractor | Implemented | Candidate-based scanner covers OpenCode-domain cookies, local/session storage, and JSON responses; tests cover ranking and empty-state rejection. |
| OAuth token candidate filtering | Implemented and locally verified | The extractor no longer treats generic `*token` fields as OpenCode API keys and explicitly rejects OAuth `access_token`, `id_token`, and `refresh_token` fields as API-key candidates. This prevents authorization artifacts from being stored as provider API keys. |
| Partial extract merge safety | Implemented | `login/extract` now merges non-empty extracted fields into existing encrypted account material instead of overwriting previously stored API key, workspace ID, email, or cookie with empty partial candidates. |
| Partial extract quota preservation | Implemented locally | `login/extract` now updates the stored quota tuple only when the browser extraction actually contains quota evidence. Cookie/API-key-only partial extracts no longer clear existing `quota_raw`, `quota_limit`, or `quota_used`; when quota evidence is present, the tuple is updated as one complete observation. |
| Channel binding validation | Implemented and locally verified | OpenCode account create/update now rejects both missing channel IDs and non-existent bound channel rows at the model boundary, preventing ghost bindings from entering persistent storage. Channel enabled/disabled state remains owned by channel management; if a bound channel is deleted after import, readiness reports `channel_id` as missing and activation fails closed without exposing storage-layer `record not found`. |
| Credential readiness diagnostics | Implemented | Public OpenCode account responses now expose masked `credential_integrity`, `activation_ready`, and `missing_activation_fields` signals, so operators can distinguish missing account material from decrypt failures without seeing raw secrets. |
| Credential key-source diagnostics | Implemented and remotely verified | Public OpenCode account responses now include non-sensitive `credential_key_source`, and startup logs warn when existing OpenCode accounts are encrypted under the session-secret fallback instead of a dedicated crypto secret. This makes the strongest remaining deployment footgun visible before real account import/cache E2E. |
| Credential diagnostics endpoint | Implemented and locally verified; pending remote rollout | Added root-only `GET /api/opencode/accounts/diagnostics`, exposing only `credential_key_source` and `uses_fallback_credential_key`. This lets the Admin UI warn before any OpenCode account exists, without exposing secret values, ciphertext, cookies, workspace IDs, account emails, OAuth payloads, or local deployment paths. Handler-level tests now assert the JSON contract and verify the configured crypto secret is not emitted in the response. |
| Frontend key-source warning | Implemented and locally verified | The OpenCode account page now consumes the diagnostics endpoint and shows a page-level fallback-key warning before production account import. The warning and main workspace now live in an explicit fixed-content `auto + minmax(0,1fr)` grid so the browser panel remains bounded when the warning is visible. The account table still marks imported accounts using the fallback credential key source with a compact `Fallback key` badge, and the page refresh action refetches accounts, channels, and diagnostics together. Helper-level tests now cover the refresh fan-out, refresh disabled state, and fixed-content grid row decision without introducing a new React DOM test stack. |
| Frontend account window | Implemented | Added Root-only admin route, sidebar entry, account list, enabled-channel selector with numeric ID fallback, remote screenshot controls, extract, quota refresh, activate, stop, and delete actions. The account list now has a fixed create/bind toolbar plus an independently scrollable table region, so importing many OpenCode accounts does not push the remote browser workspace out of the fixed admin surface. |
| Frontend delete confirmation | Implemented locally | Account deletion now uses the existing `ConfirmDialog` destructive flow instead of single-click deletion. The dialog names the selected account, disables duplicate confirmation while deletion is in flight, and only clears the remote browser panel when the deleted account was selected. Helper tests cover dialog-open and confirm-enabled decisions without adding a React DOM test stack. |
| Frontend business-error gating | Implemented locally | OpenCode account API wrappers now reject New API business failures (`success:false`) before React Query can run success handlers. This prevents purge/delete, extract, quota refresh, activation, or browser-session failures from showing success toasts or clearing UI state while the backend has intentionally preserved the account for retry. |
| Activation into existing channels | Implemented | Activation decrypts the selected account API key, updates the bound channel inside a transaction, marks the account active, and refreshes channel cache after commit. |
| Activation credential contract | Implemented and locally verified | Activation now builds channel credentials according to the bound channel type. Plain OpenCode API keys remain valid for non-Codex channels, while Codex channels require JSON material containing `access_token` and `account_id`. Public readiness diagnostics now mark Codex/plain-key bindings as not activation-ready before the operator clicks activate. |
| Activation error semantics | Implemented locally | Activation now returns the same sanitized account-not-found business failure for missing account IDs, and wraps missing bound channels as explicit channel-not-found failures instead of surfacing raw storage-layer `record not found` text. |
| Remote clean artifact deployment | Done | Built pushed `main` from an isolated clean checkout, produced self-contained binary-plus-sidecar artifacts, switched the remote service to those artifacts, preserved the existing runtime data path, and verified the service is active. |
| Last verified remote rollout | Done | Pushed `main` commit `e76a8063` is the last rollout verified on the remote service. HTTP smoke returned 200 after readiness polling, the service was active, executable-directory sidecar resolution returned successful empty-state `stopped`, remote default frontend typecheck/build passed, remote classic frontend build passed, remote Node sidecar tests passed, OpenCode key-source/readiness/extractor/quota/activation targeted Go tests passed, and the sidecar path-resolution regression test passed on the deployed source checkout. Changes after that point, including the local delete-purge hardening, still require remote rollout once the Tailscale peer is reachable again. |
| Real OpenCode login E2E | Pending | Requires an operator-controlled OpenCode subscription account. The repository contains no real account material. |
| Real `glm-5.2` cache-hit E2E | Pending | Should run only after a real OpenCode account has been imported and activated through New API. |

### Architecture Progress Update

The implementation now follows the planned native New API connector shape:

```text
Admin Web
  -> /opencode-accounts route
  -> Root-only /api/opencode/accounts API
  -> OpenCode account service and model
  -> encrypted durable account fields
  -> CDP sidecar for isolated remote authorization
  -> extractor
  -> atomic channel activation
  -> existing relay and cache accounting pipeline
```

The most important architectural decision that survived implementation is ownership: browser process state stays in the sidecar/session layer, durable account metadata stays in `model.OpenCodeAccount`, and channel mutation happens only through the activation service. That keeps callers from manually stitching together partial steps such as "extract, decrypt, update channel, refresh cache"; the service owns the complete operation.

The deliberate tradeoff is that the first browser bridge uses CDP screenshot/click/key primitives rather than noVNC. This is smaller, easier to permission-gate, and enough for OAuth authorization, but it is less comfortable than a full remote desktop if OpenCode or Google introduces complex browser UI. The fallback direction remains noVNC or Playwright-backed streaming only if CDP interaction becomes insufficient in real E2E.

The latest security refinement closes an argv exposure in the CDP key path. Browser text input, including anything typed on Google/OpenCode pages, is now supplied to the sidecar over stdin. This avoids leaking operator input through `ps`, service supervisors, shell history, or structured process telemetry. The tradeoff is that ad-hoc manual sidecar invocations can no longer pass `--text`; this is intentional because the web API should be the only supported input surface.

The status response now treats browser URL as sensitive metadata. OAuth redirect URLs can carry `state`, `code`, or provider-specific query payloads, so New API strips query strings and fragments before returning status to the Admin UI. The sidecar may still use the full URL internally for browser control, but the API contract exposes only the navigational location needed by the operator.

The status endpoint is now deliberately idempotent. A missing sidecar state file means "no login browser has been started for this account", not "the connector failed". Screenshot, click, key, and extract still fail without an existing session because those operations require a live browser target.

Login-session actions now validate durable account ownership before sidecar work. This keeps the idempotent stopped-state behavior scoped to real accounts while preventing stale UI/API calls with missing account IDs from creating, probing, typing into, clicking, stopping, or screenshotting account-numbered browser artifacts that New API no longer owns.

Browser startup failures now fail early and diagnostically. Before this refinement, an invalid Chromium binary or an early Xvfb/Chromium exit could collapse into an unstructured process error or a slow CDP timeout. The sidecar now races CDP readiness against process startup failure and emits a structured JSON error that the API layer can surface to the operator.

Sidecar script resolution no longer assumes the process working directory is the artifact root. The Go service now searches upward from both the current working directory and the running executable directory. This is a deployment hardening step: systemd working directories, clean artifact symlinks, and runtime data directories can legitimately diverge, while the sidecar script should remain discoverable next to the deployed binary.

The latest sidecar path-resolution hardening is deployed from pushed `main` commit `f17bf862`. The remote clean artifact build completed, both frontend builds completed, remote Node sidecar tests passed, sidecar path-resolution focused Go tests passed, broader OpenCode account/controller/router Go tests passed, the service restarted as active, HTTP smoke returned 200 after readiness polling, and sidecar `status` returned `success/stopped` with an empty state directory.

Existing browser reuse is now gated by CDP reachability, not by PID liveness alone. A process ID can remain alive or be reused while the recorded debugging port is dead; treating that as a reusable session makes the UI report a stopped session after a start request. The sidecar now continues into a fresh startup unless the existing session is actually reachable.

Stop now owns process cleanup more completely. It no longer returns immediately after sending SIGTERM; it waits for recorded browser/Xvfb processes to exit and uses a force-kill fallback when they do not. This makes lifecycle smoke tests and repeated login attempts less likely to accumulate stale headless browser processes.

Account deletion now participates in the same lifecycle boundary. The controller purges the account's browser session before deleting the durable row; the sidecar stops recorded processes and removes the account state file plus browser profile directory. If purge fails, deletion fails closed and leaves the account available for retry. The tradeoff is that a broken sidecar can temporarily block deletion, but that is safer than deleting the only durable account handle while remote browser artifacts may still exist.

Delete now validates ownership before side effects. A missing account ID is a durable-state problem, not a sidecar cleanup request, so the controller returns the sanitized account-not-found business failure before invoking purge. This keeps external browser cleanup scoped to accounts that New API still owns and makes stale UI/API calls retry-safe without deleting arbitrary account-numbered browser artifacts.

This delete-purge hardening is currently local and repository-verified only. It should not be treated as live on the remote service until the remote Tailscale peer key issue is resolved and a clean artifact rollout plus HTTP/sidecar smoke validation is repeated.

State corruption now has its own lifecycle semantics. A missing state file still means no login browser has been started and returns `stopped`; an unreadable or invalid state file is a real integrity failure. Start, status, stop, and purge now surface that failure instead of silently falling through. This deliberately favors a noisy, retryable operator state over deleting the persistent account while potentially leaving an untracked browser profile or process behind.

Screenshot capture now retries transient browser/CDP failures. This is intentionally scoped to screenshot because it is a read-only operation; click and key input remain single-shot to avoid repeating user actions. The change addresses the observed remote behavior where authorization-page screenshot failed once but succeeded immediately on retry.

The sidecar CLI entrypoint now treats symlinked artifact paths as first-class. Systemd and smoke scripts execute the sidecar through the `new-api-current` symlink, while Node reports `import.meta.url` for the resolved release path. The previous literal comparison meant `main()` could silently skip under symlink execution. The fix compares realpaths and falls back to the original path only when realpath resolution fails.

The latest activation credential contract and symlinked sidecar entrypoint fixes are deployed from pushed `main` commit `2e1687eb`. The remote clean artifact build completed, both frontend builds completed, remote Node sidecar tests passed, remote activation/readiness Go tests passed, the service restarted as active, HTTP smoke returned 200, and sidecar `status` executed through the symlinked artifact path returned `success/stopped`.

The latest sidecar lifecycle, status sanitization, partial-extract merge, channel-binding, frontend channel-selector, and screenshot retry fixes are now deployed from pushed `main` commit `c95d3c0d`. The remote service was switched to the new clean artifact, restarted, and verified through an HTTP smoke test plus sidecar checks. The official OpenCode authorization page was exercised without credentials through start, status, screenshot, and stop. The screenshot step reached the OpenCode authorization domain, stop returned `stopped`, and a browser-process-specific residue check found no Chromium/Xvfb process tied to the smoke session.

The sidecar extractor now closes a real implementation gap in the original plan. The backend extractor already accepted `json_responses`, but the browser sidecar previously returned an empty list, which meant account material available only through OpenCode page API responses could be missed during real login. Extract now evaluates an async browser-side probe that fetches recently loaded OpenCode same-site resources likely to be JSON account/quota/workspace endpoints. It intentionally rejects static assets and URLs carrying OAuth `code`, `state`, or token payloads. This improves extraction coverage without replaying authorization callbacks or touching non-OpenCode resources.

The extractor now also rejects OAuth token fields as API-key candidates. This is a stricter boundary than matching every key ending in `token`: OpenCode API keys remain discoverable through explicit API-key-shaped names such as `api_key`, `apiKey`, `api.key`, or `.key`, while `access_token`, `id_token`, and `refresh_token` are treated as authorization artifacts, not provider API keys. The tradeoff is deliberate: if a future upstream exposes only a generic bearer token field, the connector should fail extraction and require a targeted parser update rather than silently persisting the wrong credential class.

Quota parsing has also been tightened. A quota field name is no longer enough to classify a numeric value as a limit or raw display value when the key also says used, usage, or consumed. This removes order-dependent failure modes where `quota.used` could be stored as `quota_limit` or shown as the raw quota value, which would corrupt quota display and any downstream reasoning about account capacity.

The latest OAuth-token filtering and quota raw stabilization changes are deployed from pushed `main` commit `346dc24d`. The remote clean artifact build completed, both frontend builds completed, remote Node sidecar tests passed, extractor/quota tests passed with repeated runs to cover Go map traversal order, broader OpenCode Go tests passed, the service restarted as active, HTTP smoke returned 200, and sidecar `status` executed through the symlinked artifact path returned `success/stopped`.

Extraction now preserves durable account material when the browser only yields partial candidates. This matters because real auth pages can expose cookie/quota first and API key/workspace later, or expose different fields depending on navigation timing. The controller now merges non-empty extracted fields into the existing decrypted secret set and re-encrypts the result, instead of treating missing candidates as explicit deletion.

Quota persistence now follows the same partial-extract rule. A browser extraction that contains only cookie, workspace, or API-key material should not erase the last known quota snapshot. The controller updates `quota_raw`, `quota_limit`, and `quota_used` only when quota evidence is present, and then updates the three fields as one observation. This avoids UI capacity flicker after auth-page navigations that expose credentials before quota.

The latest partial-extract quota preservation change is deployed from pushed `main` commit `59645a65`. The remote clean artifact build completed, both frontend builds completed, remote Node sidecar tests passed, repeated extractor/quota tests passed, partial-extract controller tests passed, broader OpenCode Go tests passed, the service restarted as active, HTTP smoke returned 200, and sidecar `status` executed through the symlinked artifact path returned `success/stopped`.

Channel binding is now validated before an OpenCode account is persisted. The model rejects both missing channel IDs and non-existent bound channel rows, while deliberately leaving enabled/disabled state to channel management instead of coupling account import to routing status. The frontend also uses the existing channel list API to present enabled channels as selectable options while retaining a numeric ID fallback. If a channel is deleted after import, account readiness now reports the existing `channel_id` field as missing and activation fails closed without surfacing raw storage-layer errors.

Credential readiness is now an explicit API contract. Earlier public responses exposed only `has_*` flags, which can remain true even when stored ciphertext cannot be decrypted after an incorrect `CRYPTO_SECRET` change. The account response now separates ciphertext presence from credential integrity and activation readiness. The UI can show a masked credential-error state and disable activation before the operator reaches a failing channel update. The tradeoff is a small response-schema expansion, but it is limited to field names and booleans; no raw secret, cookie, workspace ID, account email, OAuth payload, or local deployment path is exposed.

Activation now has a channel credential contract instead of blindly copying extracted material into `channel.key`. This matters because Codex channels in this fork consume OAuth JSON and the relay layer requires both `access_token` and `account_id`; a plain OpenCode API key would make the admin UI report activation success while the first request fails in `SetupRequestHeader`. The service now rejects that mismatch transactionally, leaves the previous channel key untouched, and feeds the same diagnosis into account readiness so the frontend can disable the impossible activate path. The tradeoff is intentionally conservative: the connector does not infer `account_id` from `workspace_id` because those identifiers are not proven equivalent.

Activation error semantics now match the rest of the OpenCode account API. Missing account IDs are rejected at the controller boundary with the same sanitized account-not-found business response used by update/extract/quota/login flows, and a missing bound channel is reported as a channel ownership/configuration error rather than raw storage-layer `record not found` text. The activation service still owns the transaction and leaves channel/account state untouched on failure.

The biggest deployment pitfall is `CRYPTO_SECRET`: durable imported credentials require a stable value. If an operator runs with an auto-generated or rotated secret, stored OpenCode account material will fail closed on decrypt and must be re-imported.

That pitfall is now represented in code, not only in this plan. OpenCode account responses expose `credential_key_source` as either `crypto_secret` or `session_secret_fallback`, and startup emits a system warning when persisted OpenCode accounts exist while the process is using the fallback key source. The response remains non-sensitive: it discloses configuration class only, never the secret value, ciphertext, cookie, workspace ID, account email, OAuth payload, or local deployment path.

A root-only diagnostics endpoint now carries the instance-level form of the same signal. `GET /api/opencode/accounts/diagnostics` exposes only the key-source class and a fallback boolean, so the UI can warn before the first OpenCode account is imported. This is the right ownership split: account responses explain stored account state, while diagnostics explains whether the current New API process is configured safely enough to import durable production credentials.

The default frontend now consumes that diagnostic as a page-level warning. Accounts using the fallback key source still receive a compact `Fallback key` badge in the account table, but the high-value warning is no longer tied to selecting an existing account. The UI deliberately avoids a modal or blocking flow: activation readiness and backend validation still own hard correctness, while the warning makes the deployment tradeoff visible before account operation begins.

The warning is now part of the fixed-content layout contract, not an ad-hoc block above the workspace. The page uses an explicit `auto + minmax(0,1fr)` grid so the warning can appear without pushing the remote browser viewport outside the bounded admin surface. The refresh command also refetches account rows, channel options, and diagnostics together because those three datasets define the operator's current account-switching decision.

Account deletion now has a UI guard aligned with its backend semantics. Since delete purges browser state/profile artifacts before removing the durable account row, it is no longer a harmless row action. The default frontend now opens the existing destructive confirmation dialog, keeps the confirm button disabled while a delete request is running, and avoids clearing the current browser panel when the operator deletes a different account. This is intentionally a confirmation, not an extra backend mode: the server-side purge/fail-closed contract still owns correctness.

The frontend API boundary now rejects New API business failures instead of trusting HTTP 200 as success. This matters because `common.ApiError` returns `{success:false}` with status 200, and React Query would otherwise run success handlers for failed purge/delete, extract, quota refresh, activation, or browser-session operations. The wrapper keeps global error toast behavior intact but prevents false success toasts and state clearing when the backend deliberately keeps an account available for retry.

The credential key-source diagnostics are deployed from pushed `main` commit `e76a8063`. The remote clean artifact build completed, default frontend typecheck/build completed, classic frontend build completed, remote Node sidecar tests passed, OpenCode key-source/readiness/extractor/quota/activation Go tests passed, service restart completed, readiness-polled HTTP smoke returned 200, and sidecar `status` returned `success/stopped` with an empty state directory.

Remote deployment is now separated from the previous runtime worktree. The service runs from a clean artifact built from the pushed `main`, while the existing runtime data location is preserved explicitly. This avoids overwriting unrelated local cache/accounting work that still exists in the old runtime tree and keeps source, artifact, and runtime data as separate concerns.

### Verification Update

Validated successfully:

```text
go test ./common ./service/relayconvert -count=1
go test ./model -run TestCreateOpenCodeAccount -count=1
go test ./model -run 'TestCreateOpenCodeAccount' -count=1
go test ./model ./controller ./service -run 'TestCreateOpenCodeAccount|TestOpenCodeAccountPublicViewReportsCredentialDecryptFailure|TestOpenCodeAccountResponseDoesNotExposeSecrets|TestMergeExtractedOpenCodeSecretsPreservesExistingFields|TestExtractOpenCodeSecretsFromBrowserState|TestExtractOpenCodeQuotaFromBrowserState|TestActivateOpenCodeAccount|TestObserveChannelAffinityUsageCacheByRelayFormat_MixedMode' -count=1
go test ./controller -run TestOpenCodeAccountResponseDoesNotExposeSecrets -count=1
go test ./controller -run 'TestOpenCodeAccountResponseDoesNotExposeSecrets|TestMergeExtractedOpenCodeSecretsPreservesExistingFields' -count=1
go test ./controller -run "TestApplyExtractedOpenCodeAccount|TestMergeExtractedOpenCodeSecrets" -count=1
go test ./router -run TestOpenCodeAccountRoutesRegisterExpectedPaths -count=1
go test ./service -run 'TestExtractOpenCodeSecretsFromBrowserState|TestActivateOpenCodeAccount' -count=1
go test ./service -run "TestExtractOpenCodeSecretsFromBrowserState|TestExtractOpenCodeQuotaFromBrowserState" -count=20
go test ./service -run TestObserveChannelAffinityUsageCacheByRelayFormat_MixedMode -count=1
go test ./service -run 'TestExtractOpenCodeSecretsFromBrowserState|TestExtractOpenCodeQuotaFromBrowserState|TestActivateOpenCodeAccount|TestObserveChannelAffinityUsageCacheByRelayFormat_MixedMode' -count=1
go test ./service -run 'TestBuildOpenCodeAuthCommandSpecPassesKeyTextThroughStdin|TestExtractOpenCodeSecretsFromBrowserState|TestExtractOpenCodeQuotaFromBrowserState|TestActivateOpenCodeAccount|TestObserveChannelAffinityUsageCacheByRelayFormat_MixedMode' -count=1
go test ./service -run 'TestBuildOpenCodeAuthCommandSpecPassesKeyTextThroughStdin|TestOpenCodeAuthSidecarStatusTreatsMissingStateAsStopped|TestExtractOpenCodeSecretsFromBrowserState|TestExtractOpenCodeQuotaFromBrowserState|TestActivateOpenCodeAccount|TestObserveChannelAffinityUsageCacheByRelayFormat_MixedMode' -count=1
go test ./service -run 'TestOpenCodeAuthSidecarStartReportsInvalidChromiumBinary|TestOpenCodeAuthSidecarStatusTreatsMissingStateAsStopped|TestBuildOpenCodeAuthCommandSpecPassesKeyTextThroughStdin' -count=1
go test ./service -run "TestFindOpenCodeAuthSidecarPathSearchesExecutableDirectory|TestOpenCodeAuthSidecarStatusTreatsMissingStateAsStopped|TestBuildOpenCodeAuthCommandSpecPassesKeyTextThroughStdin" -count=1
go test ./service -run 'TestOpenCodeAuthSidecarStartReportsInvalidChromiumBinary|TestOpenCodeAuthSidecarStatusTreatsMissingStateAsStopped|TestBuildOpenCodeAuthCommandSpecPassesKeyTextThroughStdin|TestExtractOpenCodeSecretsFromBrowserState|TestExtractOpenCodeQuotaFromBrowserState|TestActivateOpenCodeAccount|TestObserveChannelAffinityUsageCacheByRelayFormat_MixedMode' -count=1
go test ./service -run 'TestOpenCodeAuthSidecarStartReportsInvalidChromiumBinary|TestOpenCodeAuthSidecarStartDoesNotReusePidWithoutCDP|TestOpenCodeAuthSidecarStatusTreatsMissingStateAsStopped|TestBuildOpenCodeAuthCommandSpecPassesKeyTextThroughStdin|TestExtractOpenCodeSecretsFromBrowserState|TestExtractOpenCodeQuotaFromBrowserState|TestActivateOpenCodeAccount|TestObserveChannelAffinityUsageCacheByRelayFormat_MixedMode' -count=1
go test ./service -run 'TestOpenCodeAuthSidecarStopWaitsForRecordedProcessExit|TestOpenCodeAuthSidecarStartReportsInvalidChromiumBinary|TestOpenCodeAuthSidecarStartDoesNotReusePidWithoutCDP|TestOpenCodeAuthSidecarStatusTreatsMissingStateAsStopped|TestBuildOpenCodeAuthCommandSpecPassesKeyTextThroughStdin|TestExtractOpenCodeSecretsFromBrowserState|TestExtractOpenCodeQuotaFromBrowserState|TestActivateOpenCodeAccount|TestObserveChannelAffinityUsageCacheByRelayFormat_MixedMode' -count=1
go test ./service -run 'TestSanitizeOpenCodeLoginSessionStatus|TestBuildOpenCodeAuthCommandSpecPassesKeyTextThroughStdin|TestOpenCodeAuthSidecarStatusTreatsMissingStateAsStopped|TestExtractOpenCodeSecretsFromBrowserState|TestExtractOpenCodeQuotaFromBrowserState|TestActivateOpenCodeAccount|TestObserveChannelAffinityUsageCacheByRelayFormat_MixedMode' -count=1
go test ./service ./controller -run "TestActivateOpenCodeAccount|TestOpenCodeAccountResponse" -count=1
go test ./controller -run "TestOpenCodeAccountDiagnosticsReportsCredentialKeySource|TestGetOpenCodeAccountDiagnosticsReturnsNonSecretPayload" -count=1
go test ./controller -run "TestDeleteOpenCodeAccountPurgesLoginSessionBeforeDeleting|TestDeleteOpenCodeAccountPreservesAccountWhenPurgeFails" -count=1
go test ./model ./controller ./service ./router -run "TestDeleteOpenCodeAccountPurgesLoginSessionBeforeDeleting|TestDeleteOpenCodeAccountPreservesAccountWhenPurgeFails|TestGetOpenCodeAccountDiagnosticsReturnsNonSecretPayload|TestOpenCodeAccountDiagnosticsReportsCredentialKeySource|TestCreateOpenCodeAccount|TestOpenCodeAccountPublicViewReportsCredentialDecryptFailure|TestOpenCodeAccountResponse|TestOpenCodeAccountPublicViewReportsCredentialKeySource|TestMergeExtractedOpenCodeSecrets|TestApplyExtractedOpenCodeAccount|TestExtractOpenCodeSecretsFromBrowserState|TestExtractOpenCodeQuotaFromBrowserState|TestActivateOpenCodeAccount|TestBuildOpenCodeAuthCommandSpecPassesKeyTextThroughStdin|TestFindOpenCodeAuthSidecarPathSearchesExecutableDirectory|TestOpenCodeAuthSidecarStatusTreatsMissingStateAsStopped|TestOpenCodeAccountRoutesRegisterExpectedPaths" -count=1
go test ./model ./controller ./service ./router -run "TestCreateOpenCodeAccount|TestOpenCodeAccountPublicViewReportsCredentialDecryptFailure|TestOpenCodeAccountResponse|TestMergeExtractedOpenCodeSecretsPreservesExistingFields|TestExtractOpenCodeSecretsFromBrowserState|TestExtractOpenCodeQuotaFromBrowserState|TestActivateOpenCodeAccount|TestBuildOpenCodeAuthCommandSpecPassesKeyTextThroughStdin|TestOpenCodeAuthSidecarStatusTreatsMissingStateAsStopped|TestOpenCodeAccountRoutesRegisterExpectedPaths" -count=1
go test ./model ./controller ./service ./router -run "TestOpenCodeAccountDiagnosticsReportsCredentialKeySource|TestCreateOpenCodeAccount|TestOpenCodeAccountPublicViewReportsCredentialDecryptFailure|TestOpenCodeAccountResponse|TestOpenCodeAccountPublicViewReportsCredentialKeySource|TestMergeExtractedOpenCodeSecrets|TestApplyExtractedOpenCodeAccount|TestExtractOpenCodeSecretsFromBrowserState|TestExtractOpenCodeQuotaFromBrowserState|TestActivateOpenCodeAccount|TestBuildOpenCodeAuthCommandSpecPassesKeyTextThroughStdin|TestFindOpenCodeAuthSidecarPathSearchesExecutableDirectory|TestOpenCodeAuthSidecarStatusTreatsMissingStateAsStopped|TestOpenCodeAccountRoutesRegisterExpectedPaths" -count=1
go test ./common ./model ./controller ./service ./router -run "TestOpenCodeAccountPublicViewReportsCredentialKeySource|TestCreateOpenCodeAccount|TestOpenCodeAccountPublicViewReportsCredentialDecryptFailure|TestOpenCodeAccountResponse|TestMergeExtractedOpenCodeSecrets|TestApplyExtractedOpenCodeAccount|TestExtractOpenCodeSecretsFromBrowserState|TestExtractOpenCodeQuotaFromBrowserState|TestActivateOpenCodeAccount|TestBuildOpenCodeAuthCommandSpecPassesKeyTextThroughStdin|TestFindOpenCodeAuthSidecarPathSearchesExecutableDirectory|TestOpenCodeAuthSidecarStatusTreatsMissingStateAsStopped|TestOpenCodeAccountRoutesRegisterExpectedPaths" -count=1
go test ./controller -run "TestDeleteOpenCodeAccountPurgesLoginSessionBeforeDeleting|TestDeleteOpenCodeAccountPreservesAccountWhenPurgeFails|TestDeleteOpenCodeAccountSkipsPurgeWhenAccountMissing|TestGetOpenCodeAccountDiagnosticsReturnsNonSecretPayload|TestOpenCodeAccountDiagnosticsReportsCredentialKeySource" -count=1
go test ./controller -run "TestOpenCodeLoginSessionActionsSkipSidecarWhenAccountMissing|TestDeleteOpenCodeAccountSkipsPurgeWhenAccountMissing|TestDeleteOpenCodeAccountPurgesLoginSessionBeforeDeleting|TestDeleteOpenCodeAccountPreservesAccountWhenPurgeFails" -count=1
go test ./controller ./service -run "TestActivateOpenCodeAccountReturnsNotFoundWhenAccountMissing|TestActivateOpenCodeAccountRequiresExistingChannel|TestActivateOpenCodeAccountRequiresAPIKey|TestActivateOpenCodeAccountRejectsPlainAPIKeyForCodexChannel|TestActivateOpenCodeAccountAcceptsCodexOAuthJSONKey|TestActivateOpenCodeAccountUpdatesBoundChannelKeyAndActiveAccount" -count=1
go test ./service -run "TestObserveChannelAffinityUsageCacheByRelayFormat" -count=20
go test ./model ./controller ./service -run "TestCreateOpenCodeAccount|TestUpdateOpenCodeAccountRejectsUnknownChannelBinding|TestOpenCodeAccountPublicView|TestOpenCodeAccountResponseMarks|TestActivateOpenCodeAccount" -count=1
go test ./service -run "TestChannelAffinityHitCodexTemplatePassHeadersEffective|TestGetPreferredChannelByAffinity_RequestHeaderKeySource|TestApplyChannelAffinityOverrideTemplate" -count=1
go test ./model ./controller ./service ./router ./service/relayconvert -run "TestActivateOpenCodeAccountReturnsNotFoundWhenAccountMissing|TestActivateOpenCodeAccountRequiresExistingChannel|TestOpenCodeLoginSessionActionsSkipSidecarWhenAccountMissing|TestDeleteOpenCodeAccountPurgesLoginSessionBeforeDeleting|TestDeleteOpenCodeAccountPreservesAccountWhenPurgeFails|TestDeleteOpenCodeAccountSkipsPurgeWhenAccountMissing|TestGetOpenCodeAccountDiagnosticsReturnsNonSecretPayload|TestOpenCodeAccountDiagnosticsReportsCredentialKeySource|TestCreateOpenCodeAccount|TestOpenCodeAccountPublicViewReportsCredentialDecryptFailure|TestOpenCodeAccountResponse|TestOpenCodeAccountPublicViewReportsCredentialKeySource|TestMergeExtractedOpenCodeSecrets|TestApplyExtractedOpenCodeAccount|TestExtractOpenCodeSecretsFromBrowserState|TestExtractOpenCodeQuotaFromBrowserState|TestActivateOpenCodeAccount|TestBuildOpenCodeAuthCommandSpecPassesKeyTextThroughStdin|TestFindOpenCodeAuthSidecarPathSearchesExecutableDirectory|TestOpenCodeAuthSidecarStatusTreatsMissingStateAsStopped|TestOpenCodeAccountRoutesRegisterExpectedPaths|TestUsageFromChatUsagePreservesCachedTokensForBothAccountingPaths|TestObserveChannelAffinityUsageCacheByRelayFormat" -count=1
bun run typecheck
bun test src/features/opencode-accounts/lib.test.ts
bunx oxlint -c .oxlintrc.json src/features/opencode-accounts src/routes/_authenticated/opencode-accounts src/hooks/use-sidebar-data.ts src/hooks/use-sidebar-config.ts
bun run build in web/default
bun run build in web/classic
go build .
node --test scripts/opencode-auth-session.test.mjs
node --check scripts/opencode-auth-session.mjs
node --test scripts/glm-cache-smoke.test.mjs
node --check scripts/glm-cache-smoke.mjs
git diff --check
diff secret-pattern scan
```

Additional remote smoke validation:

```text
Remote host dependency check:
  node v24.15.0
  chromium available
  Xvfb available
  dbus-daemon available
  git and bun available

Sidecar smoke:
  start/status/screenshot/extract/stop on about:blank
  start/status/screenshot/stop on https://opencode.ai/auth

Remote clean artifact rollout:
  clean checkout fixed to pushed main commit e76a8063
  web/default build completed on the remote host
  web/classic build completed on the remote host
  Go binary built into an isolated artifact with the OpenCode sidecar script
  artifact filename scan found no database, env, cookie, workspace, API-key, or token files
  system service switched to the clean artifact while preserving the existing runtime data path
  service active after restart
  local HTTP smoke returned 200
  artifact sidecar status smoke returned success/stopped with an empty state directory
  artifact sidecar invalid Chromium smoke returned a structured JSON failure
  official OpenCode auth page lifecycle smoke passed start/status/screenshot/stop without credentials
  post-stop browser residue check found no Chromium/Xvfb process for the smoke session
  remote targeted Go tests passed for login status URL sanitization and partial extract secret merge
  remote targeted Go tests passed for channel binding validation
  web/default typecheck and build completed with the channel selector UI
  remote Node sidecar retry tests passed
  latest screenshot retry artifact passed official OpenCode auth page lifecycle smoke
  latest credential readiness artifact deployed on the remote service
  HTTP smoke returned 200
  empty-state sidecar status returned successful stopped
  official OpenCode auth page lifecycle smoke passed without credentials and left no browser residue for the smoke session
  remote Node sidecar tests and OpenCode readiness targeted Go tests passed
  latest JSON probe extractor artifact deployed on the remote service
  remote Node sidecar tests and OpenCode extractor targeted Go tests passed
  official OpenCode auth page start/screenshot/extract/stop smoke passed without credentials and left no browser residue for the smoke session
  latest sidecar path-resolution artifact deployed on the remote service
  sidecar path-resolution focused Go tests passed on the remote source checkout
  readiness-polled HTTP smoke returned 200 after service restart
  empty-state sidecar status returned success/stopped from the deployed artifact
  latest credential key-source diagnostic artifact deployed on the remote service
  default frontend typecheck/build and classic frontend build passed on the remote host
  OpenCode key-source/readiness/extractor/quota/activation Go tests passed on the remote source checkout
```

The `web/classic` build failure was traced to `date-fns-tz@1.3.8` resolving its peer `date-fns` to the workspace-level `date-fns@4`. That package version blocks private subpath imports such as `date-fns/_lib/cloneObject/index.js`. The fix keeps `web/default` on `date-fns@4` and adds a classic-only Rsbuild alias so Semi UI's `date-fns-tz` resolves to Semi's nested `date-fns@2.30.0`.

Known verification limits:

- The channel-affinity frontend directory and OpenCode-related frontend paths pass targeted lint. Broad full-frontend lint is still treated as a separate historical quality gate and should not be used as evidence of live OpenCode account or `glm-5.2` cache-hit behavior.
- The broader `src/features/channels/components/dialogs/param-override-editor-dialog.tsx` file still exposes pre-existing oxlint style findings such as `curly`, `no-nested-ternary`, and `no-useless-spread`. This change only relies on that file for the Codex preset payload; typecheck, formatting, and default frontend build pass, but this is not claimed as a lint-clean file.
- `go test ./common ./model ./service ./controller ./router ./service/relayconvert -count=1` currently exposes pre-existing SQLite test setup failures such as missing `users`, `tasks`, and `system_tasks` tables in unrelated tests. The OpenCode-specific backend tests pass.
- The latest remote reachability check reports an expired Tailscale peer node key. Current changes are therefore locally verified gates and pushed source, not a new remote rollout or live subscription E2E result.
- Real OpenCode Google login, account extraction, channel activation against a live subscription account, and repeated `glm-5.2` cache-hit measurement still require operator-controlled credentials and must not be committed to the repository.

### Immediate Next Steps

1. Restore remote peer reachability first if the Tailscale peer still reports an expired node key, then roll out the current pushed `main` as a clean artifact before running credential E2E.
2. Run the non-mutating preflight gate against the deployed service before importing production account material:

```bash
NEW_API_BASE_URL=https://<deployed-new-api> \
NEW_API_ADMIN_TOKEN=<admin-access-token> \
NEW_API_ADMIN_USER_ID=<admin-user-id> \
node scripts/opencode-e2e-preflight.mjs
```

3. Open the deployed Admin Web and verify `/opencode-accounts` does not show the page-level fallback-key warning; if it does, configure a stable `CRYPTO_SECRET` before importing production account material.
4. Complete the official OpenCode/Google authorization in the remote browser session with an operator-controlled OpenCode subscription account.
5. Extract account material and verify only masked indicators are visible in the UI.
6. Activate the bound New API channel, confirm channel cache refresh, then rerun preflight with `--min-active-ready-accounts 1`. Keep `--min-activation-ready-accounts 1 --min-active-accounts 1` only as supplemental diagnostics; the live cache smoke gate should require a single account that satisfies both states.
7. Run repeated `glm-5.2` requests through New API with the secret-redacted smoke runner:

```bash
NEW_API_BASE_URL=https://<deployed-new-api> \
NEW_API_KEY=<relay-api-key> \
NEW_API_ADMIN_TOKEN=<admin-access-token> \
NEW_API_ADMIN_USER_ID=<admin-user-id> \
GLM_CACHE_SMOKE_KEY=<stable-session-key> \
node scripts/glm-cache-smoke.mjs \
  --warmup-requests 2 \
  --requests 6 \
  --delay-ms 1000 \
  --require-stats true \
  --min-request-hit-rate 0.8 \
  --min-stats-hit-rate 0.8 \
  --min-cache-signal-tokens 1
```

8. Compare warm-cache behavior through the runner summary, New API channel-affinity usage stats, and upstream/OpenCode quota/accounting. For this smoke, the default input is already a stable cache-probe prefix; pass `--input` only when intentionally testing a different workload. The runner redacts the configured input from failure output, including JSON-escaped and truncated-prefix echoes, but the safer default is still to use the deterministic probe unless the live workload itself is the variable under test. Treat `warmup` as cache priming, `stats.delta` as the measured-run evidence, `checks.status` as the machine gate, and `stats.data` as the final accumulated snapshot; if `reset_detected` is true, repeat the run after the cache window stabilizes. The runner proves request and stats plumbing; it does not by itself prove upstream prompt-cache billing correctness.
9. If CDP screenshot interaction proves insufficient for Google authorization, add a noVNC fallback without changing the account model or activation contract.

## 中文

### 范围

本文档记录在 New API 中加入 OpenCode 账号连接器的具体实施方案与当前工程进度。目标流程是：

1. root 用户打开 New API 管理后台。
2. New API 在远端服务器启动隔离浏览器会话。
3. 操作者通过官方 OpenCode 授权入口登录。
4. New API 提取 OpenCode Go 上游调用所需的账号材料。
5. New API 加密存储敏感材料，并激活指定 New API 渠道。

本次调研已验证的官方授权入口是：

```text
https://opencode.ai/auth
```

无登录态下观察到的跳转链路是：

```text
https://opencode.ai/auth
  -> /auth/authorize
  -> https://auth.opencode.ai/authorize?client_id=app&redirect_uri=https%3A%2F%2Fopencode.ai%2Fauth%2Fcallback&response_type=code&state=...
```

该页面暴露官方 Google 与 GitHub 授权入口。New API 不应采集 Google 密码，也不应模拟 Google 密码登录。

### 隐私与仓库卫生

本文档有意排除了所有操作者特定或部署特定的敏感信息：

- 不包含 API key。
- 不包含 cookie。
- 不包含 workspace ID。
- 不包含账号邮箱。
- 不包含本地浏览器 profile 路径。
- 不包含远端数据库内容。
- 不包含私有 Tailscale 主机细节。

后续实现必须保持这个边界。运行时提取结果只允许进入加密数据库字段，日志中不得出现 OpenCode API key、cookie、workspace ID 或授权载荷原文。

### 当前代码架构评估

当前 fork 的 `main` 已经具备几个有用的扩展点：

- 后端遵循 `router -> controller -> service -> model`。
- 已存在 Root-only API 分组，例如 `/api/option`、`/api/performance`、`/api/custom-oauth-provider`、`/api/system-task`。
- 渠道管理已经成熟，并通过 `router/channel-router.go` 与 `service/authz` 做权限控制。
- 渠道密钥当前存放在 `model.Channel.Key`，但现有渠道 API 偏向手动录入 key。
- `service/codex_credential_refresh.go` 已存在 Codex OAuth 刷新逻辑，说明代码库可以接受某些 provider 将结构化 JSON 凭证存入 channel key。
- 前端使用 TanStack file routes，并在 `web/default/src/features` 下按功能拆分，适合新增独立的 `opencode-accounts` 功能模块。

当前 `main` 还缺少本需求所需的关键部分：

- 没有 `opencode_accounts` model。
- 没有 Root-only OpenCode 账号 API 分组。
- 没有用于存储 provider secret 的可逆加密工具。`common/crypto.go` 当前只有 HMAC 与 bcrypt；HMAC 不可解密，不能用于保存 API key 或 cookie。
- 没有远端隔离浏览器会话管理器。
- 没有 CDP screenshot/click 桥，也没有 noVNC 桥。
- 没有前端账号快速切换窗口。
- 没有 OpenCode cookie、localStorage、sessionStorage 或登录态 API probe 的 extractor。
- 没有带审计语义的账号激活流程，用于从选定 OpenCode 账号更新 New API 渠道。

### 先前要求对比

| 要求 | 当前 fork `main` 状态 | 缺口 | 推进方向 |
|---|---|---|---|
| 使用 New API，不直接走 opencode-go 或 opencode-cc | New API 已有渠道抽象与 relay 流程 | 需要将 OpenCode 账号材料喂给现有渠道 | 在 New API 内部建设账号连接器 |
| 远端 Web 授权，不是本地 CLI | 当前没有远端浏览器子系统 | 需要浏览器生命周期、画面桥、提取 API | 新增 Root-only CDP 隔离浏览器会话 |
| 支持 Google 登录 | 当前 New API OAuth 用于 New API 用户，不用于导入 OpenCode 账号 | 不能采集 Google 密码 | 让操作者在官方 OpenCode/Google 页面完成登录 |
| 多账号快速切换 | 渠道支持多个 key/channel，但主要靠手工维护 | 没有账号库存和 activate 动作 | 增加账号表，并绑定账号到渠道 |
| 最大化 `glm-5.2` cache-hit 统计 | relay usage 转换现在会在 Chat 风格与 Responses 风格字段中同时保留 cached-token details，channel-affinity usage stats 也会记录 cache-hit 计数 | 真实 warm-cache 行为仍需要真实 OpenCode 凭证和多轮 `glm-5.2` 调用验证 | 保留仓库内兼容性测试，并在账号导入与激活后执行真实 cache-hit accounting 验证 |
| 稳健处理 secret | 已有 RootAuth 和安全验证模式 | 没有导入 provider secret 所需的可逆加密 | 基于稳定 `CRYPTO_SECRET` 增加 AES-GCM secret 加密 |
| 不限制 clipboardSharingSize | 与本连接器无关 | 不需要动作 | Deskflow 相关选择保留在本仓库之外 |

### Cache 相关工作状态

当前 fork 已经包含此前只在远端工作流中验证过的 Responses usage 兼容修复：

- `UsageFromChatUsage` 会在 `PromptTokensDetails` 与 `InputTokensDetails` 中同时保留 cache details。
- channel-affinity usage-cache stats 会按 relay format 记录 cached-token 与 prompt-cache-hit 计数。
- 仓库测试已经覆盖 compatibility conversion 与 usage-cache observation 路径。channel-affinity usage-cache 测试现在会分配确定性的 per-test cache key，因此快速重复运行不会因为时钟分辨率粗糙而把不同测试的计数合并。
- 默认 Codex channel-affinity 规则现在同时覆盖 `glm-*` 与 `gpt-*` 模型，因此 `/v1/responses` 下的 `glm-5.2` 请求可以走同一条 `prompt_cache_key` affinity 与 Codex header 透传路径。
- 默认 Codex channel-affinity 规则现在会在请求体没有 `prompt_cache_key` 时回退到 `Session_id` 请求头。body key 仍是第一优先级，fallback 值进入 affinity cache key 前同样会先做哈希。
- 默认 Codex channel-affinity param-override 模板现在会先在 `header:session_id` 与 `json:prompt_cache_key` 之间执行 `sync_fields`，再向上游透传 Codex headers。当 Codex-compatible 客户端只提供其中一侧时，New API 的路由 affinity 与上游 prompt-cache key 会保持一致。
- `scripts/glm-cache-smoke.mjs` 现在提供一个可重复、输出脱敏的 cache-hit smoke runner，用于真实 E2E 阶段。它只从环境变量读取 relay/admin 凭据，多轮调用 `/v1/responses` 时使用稳定的 `prompt_cache_key`/`Session_id`，并可按非敏感 key fingerprint 查询 `/api/log/channel_affinity_usage_cache`。默认输入现在是确定性的长 cache-probe prefix，而不是一句短 prompt；仍可用 `--input`/`GLM_CACHE_SMOKE_INPUT` 覆盖。当 admin stats 可用时，runner 可以先执行显式 warm-up 请求，再记录 baseline 与 final 两个 usage-cache 快照，并输出本轮 `stats.delta`。可选阈值（`--require-stats`、`--min-request-hit-rate`、`--min-stats-hit-rate`、`--min-cache-signal-tokens`）会生成 `checks` 摘要，并在实测缓存证据低于目标时让 CLI 非零退出。失败输出现在除了 relay/admin/cache secret 之外，也会脱敏已配置的 base URL、origin、host、hostname，以及 raw、JSON-escaped、truncated-prefix 形态的 input prompt。这样不会把过短 prompt 的假阴性、历史累计 counter、冷启动 miss、部署细节泄漏、prompt 泄漏或人工读 JSON 的误判当作稳定态 cache-hit 证据。
- channel-affinity cache key 现在存储 affinity value 的稳定哈希，而不是原始 `prompt_cache_key` 或请求头值。这样保留路由 affinity，同时避免 Redis key 或 cache 错误日志中出现原始会话/cache 标识。

剩余 cache 问题不再是“仓库是否已有代码表示”，而是真实上游行为验证问题。真实 `glm-5.2` warm-cache 验证仍需要导入 OpenCode 订阅账号，并通过 New API 多轮调用。request-body replay/cache-key 稳定性仍应在真实 E2E 中验证，而不是假定已经完成。

### 推荐架构

采用 New API 原生连接器，而不是独立本地 CLI：

```text
New API Admin Web
  -> OpenCode Accounts feature
  -> Root-only OpenCode account API
  -> Isolated remote Chromium session
  -> Official OpenCode authorization flow
  -> Extractor with confidence-ranked candidates
  -> Encrypted account storage
  -> Atomic channel activation
  -> Existing relay and billing pipeline
```

浏览器桥建议先使用 Chrome DevTools Protocol，而不是 noVNC：

- 远端环境已经具备 Node.js、Chromium、Xvfb 和 dbus。
- noVNC 会增加系统依赖和暴露面。
- CDP screenshot/click/key event 足以完成账号授权。
- 如果后续需要复杂人工浏览器操作，再把 noVNC 作为兜底升级。

### 后端方案

新增 model，公开响应字段脱敏，私有字段加密：

```text
opencode_accounts
  id
  label
  email_ciphertext
  workspace_id_ciphertext
  api_key_ciphertext
  cookie_ciphertext
  channel_id
  quota_raw
  quota_limit
  quota_used
  login_status
  active
  last_extracted_at
  last_quota_checked_at
  created_at
  updated_at
```

公开 API 响应必须 mask 敏感值。root 用户可以看到值是否存在、何时刷新，但不能直接看到 secret 原文。

新增 Root-only 路由组：

```text
GET    /api/opencode/accounts
POST   /api/opencode/accounts
PUT    /api/opencode/accounts/:id
DELETE /api/opencode/accounts/:id

POST   /api/opencode/accounts/:id/login/start
GET    /api/opencode/accounts/:id/login/status
GET    /api/opencode/accounts/:id/login/screenshot
POST   /api/opencode/accounts/:id/login/click
POST   /api/opencode/accounts/:id/login/key
POST   /api/opencode/accounts/:id/login/extract
POST   /api/opencode/accounts/:id/login/stop

POST   /api/opencode/accounts/:id/quota/refresh
POST   /api/opencode/accounts/:id/activate
```

账号 service 应拥有完整操作：

- 在 API 边界校验账号 label 与 channel binding。
- 每个账号分配一个浏览器会话。
- 浏览器进程状态不入库。
- 数据库只保存持久账号元数据与加密后的提取材料。
- 激活账号时在一个事务内更新绑定的 New API channel，并在 commit 后刷新 channel runtime cache。

### Secret 加密方案

在 `common` 增加 AES-GCM 可逆加密：

- key 来源：`common.CryptoSecret`。
- 密文格式：带版本前缀，例如 `v1:<base64 nonce+ciphertext>`。
- 空明文保持为空，简化可选字段处理。
- 解密失败必须 fail closed。

部署必须使用稳定的 `CRYPTO_SECRET`。回退到生成的 session secret 对会话可以接受，但对持久化 provider credentials 不可接受。

### Extractor 方案

Extractor 应采用候选值机制，而不是硬编码某一个浏览器 storage key：

1. 读取 OpenCode 授权域相关 cookies。
2. 读取当前 OpenCode 页面 localStorage 与 sessionStorage。
3. 对 JSON-like value 递归扫描疑似账号字段。
4. 必要时在浏览器会话内执行 same-origin 登录态 probe。
5. 对 API key、workspace ID、quota、账号身份候选值排序。
6. 只持久化已确认或高置信值。

这样可以降低对 OpenCode 当前前端实现细节的脆弱耦合。

### 前端方案

新增功能模块：

```text
web/default/src/features/opencode-accounts
web/default/src/routes/_authenticated/opencode-accounts/index.tsx
```

页面提供：

- 账号列表。
- 登录会话状态。
- 远端浏览器 viewport。
- Login、extract、refresh quota、activate、stop、delete 操作。
- 敏感字段 masked indicator。
- 渠道绑定选择器。

这应该是面向管理员的工作界面，不是 landing page。应复用现有 table、dialog、toast 和 loading 模式。

### 测试方案

后端测试：

- AES-GCM round-trip 与 wrong-key failure。
- 账号 create/update 校验。
- 公开响应不泄露敏感字段。
- activate 只更新目标 channel，并在 commit 后刷新 channel cache。
- extractor candidate ranking 使用浏览器状态 fixture。
- Responses usage conversion 保留 cached token 字段用于计费统计。

前端检查：

- Typecheck。
- 在本地测试基础设施允许时，覆盖账号列表与会话控制 happy path。
- 使用非敏感测试账号做手工 browser-session smoke test。

端到端验证：

- 启动 New API。
- 启动远端浏览器会话。
- 手工完成官方 OpenCode 登录。
- 提取账号材料。
- 激活绑定渠道。
- 通过 New API 多轮调用 `glm-5.2`。
- 确认 New API 日志中 cache-hit accounting 仍可见。

### 当前进度

| 模块 | 状态 | 说明 |
|---|---|---|
| 授权 URL 验证 | 已完成 | 已验证公开跳转链路。 |
| fork `main` 勘察 | 已完成 | 已识别当前扩展点与缺口。 |
| 隐私边界 | 已完成 | 本文档不包含 secret 或部署特定账号材料。 |
| fork 内 cache accounting parity | 已实现 | `UsageFromChatUsage` 现在同时保留 Chat 风格与 Responses 风格计费字段中的 cached-token details。 |
| Cache accounting 测试隔离 | 本地已实现 | channel-affinity usage-cache 测试现在使用确定性的 per-test cache key，不再依赖 wall-clock nanosecond key。这样快速重复运行时不会发生跨测试 counter 串扰，在真实 `glm-5.2` E2E 前提升 cache-hit accounting 验证可信度。 |
| `glm-5.2` Codex affinity 覆盖 | 本地已实现 | 默认 Codex channel-affinity 规则现在会在 `/v1/responses` 同时匹配 `gpt-*` 与 `glm-*` 模型，并继续使用 `prompt_cache_key` 作为 key source 与同一套 Codex header 透传模板。这修复了一个具体 cache-hit 链路缺口：`glm-5.2` 即使携带稳定 prompt cache key，先前也不会触发 affinity。 |
| Codex `Session_id` affinity fallback | 本地已实现 | 默认 Codex channel-affinity 规则现在会在 `gjson:prompt_cache_key` 之后尝试 `request_header:Session_id`。这覆盖保留 session header、但 body 中缺少 `prompt_cache_key` 的 Codex-compatible 客户端，同时仍把 body `prompt_cache_key` 作为更强的第一来源。后端默认配置与前端模板已同步，回归测试证明 `glm-5.2` 可以通过该 fallback 命中 affinity。 |
| Codex session/cache-key 同步 | 本地已实现 | 默认 Codex param-override 模板现在会在只存在 header 时把 `header:session_id` 同步到 `json:prompt_cache_key`，在只存在 body key 时也会反向补齐 header，然后再透传 Codex headers。回归测试证明只有 `Session_id` 的 `glm-5.2` 请求到达上游 JSON body 时会携带稳定 `prompt_cache_key`。这提升了上游 cache-key 稳定性，但仍不等价于已经证明真实 OpenCode/GLM warm-cache 行为。 |
| `glm-5.2` cache-hit smoke runner | 本地已实现 | 已新增 `scripts/glm-cache-smoke.mjs` 及 Node 测试。runner 会把 API key、可选 admin token/cookie、可选 cache key 与可选自定义 input 限定在环境变量或 CLI 参数中；输出只包含 model、rule/group、warm-up/request 计数、usage 汇总、channel-affinity stats、阈值 `checks` 与 8 位 `key_fp`。如果缺少 Admin auth，relay 请求仍会执行，除非配置了 `--require-stats`，否则 stats 会标记为 skipped。HTTP 200 但 `success:false` 的业务失败会被当作失败并先脱敏再报告，因此 auth/config 失败不会被误算成 cache miss。Admin stats 现在支持确定性的长默认 cache-probe prompt、baseline 前显式 warm-up 请求，再使用 baseline/final 快照与本轮测量 `stats.delta`，并对 counter 轮转或重置做非负钳制与 `reset_detected` 标记。配置 checks 后，如果 request usage 或 stats delta 未达标，CLI 会非零退出。失败输出还会脱敏已配置的 base URL、origin、host、hostname，以及 raw、JSON-escaped、truncated-prefix 形态的 input prompt，避免真实 smoke 失败时打印部署 endpoint 或 workload 文本。这样后续真实 E2E 可以重复执行并接入 CI，同时不提交或打印真实凭据、部署特定 endpoint 或 prompt 内容。 |
| OpenCode E2E preflight runner | 本地已实现 | 已新增 `scripts/opencode-e2e-preflight.mjs` 及 Node 测试。runner 会对 `/api/status`、root-only OpenCode diagnostics、OpenCode 账号 readiness 汇总，以及后续 cache smoke 依赖的 channel-affinity usage stats endpoint 执行非破坏性 GET 检查。它只从环境变量读取 root auth，输出只包含 endpoint 状态、credential key-source 类别、账号计数、credential-integrity 计数、missing-field 类别计数，以及同时处于 active 与 activation-ready 状态的账号数；当 root auth、稳定 credential key、affinity stats 可读性、最小 activation-ready 账号数、最小 active 账号数或最小 active-ready 账号数不满足要求时非零退出。active-ready gate 可避免一个账号 active、另一个账号 activation-ready 时误判为可执行真实 cache smoke。endpoint 错误中的部署 URL 也会被脱敏。这样远端 rollout 后的第一步验证可以变成机器门，同时不打印 root token、cookie、原始邮箱、workspace ID、原始 missing-field 名称、账号 secret、部署 URL 或本地部署路径。 |
| Channel-affinity 原始 key 隐私 | 本地已实现 | channel-affinity cache suffix 现在对 affinity value 使用稳定 SHA1 派生 key part，而不是嵌入原始 `prompt_cache_key` 或请求头值。回归测试证明 cache suffix 会保留 rule/model/group 上下文，同时不包含原始 affinity value。该变更会让旧的内存/Redis affinity entry 失效；这是可接受的，因为 affinity cache 是机会性缓存，会自动重新预热。 |
| Channel-affinity cache-stats UI 质量门 | 本地已实现 | cache-stats dialog 的行构造逻辑现在抽成纯 helper，并用回归测试覆盖命中率、cached-token、目标字段兜底与空状态行。dialog 不再依赖 promise chain 或嵌套三元渲染，完整 `src/features/system-settings/general/channel-affinity` 前端目录现在已通过 targeted oxlint。这提升了真实 `glm-5.2` E2E 前的 cache 可观察性质量，但不能替代真实上游 cache-hit 验证。 |
| OpenCode account model | 已实现 | 已增加 `opencode_accounts` model、迁移注册、校验、加密 secret 存储与 masked public view。 |
| 可逆加密 helper | 已实现 | 已增加 AES-GCM `EncryptSecret` / `DecryptSecret`，使用 `CRYPTO_SECRET` 派生 key，密文带版本前缀。 |
| Root-only OpenCode account API | 已实现 | `/api/opencode/accounts` 下已包含 CRUD、登录会话、提取、quota refresh 与 activate 路由。quota refresh 现在支持只包含 quota 的浏览器 payload，并会更新结构化 `quota_limit` / `quota_used` 字段。 |
| Quota 候选分类 | 已实现 | quota limit 与 raw display 检测现在会排除 used/usage/consumed 键，避免浏览器 payload 遍历顺序变化时把 `quota.used` 写入 quota limit 或 quota raw 展示值。 |
| 远端浏览器 sidecar | 已实现，并已在远端主机完成无凭证 smoke test | 已增加 Node CDP + Xvfb sidecar，支持 start/status/screenshot/click/key/extract/stop。远端 smoke 覆盖 `about:blank` 与官方 OpenCode 授权入口，未登录、未使用任何账号材料。extract 现在会 probe 页面已加载的疑似 OpenCode 同站 JSON 资源，并排除静态资源与 OAuth payload URL，因此 API key、workspace、quota 候选不再只依赖浏览器 storage。 |
| 敏感浏览器输入传输 | 已实现 | `login/key` 现在通过 stdin 向 Node sidecar 传递键入文本，不再放入 argv，因此 Google/OpenCode 登录页中的输入不会出现在进程命令行中。sidecar 会拒绝旧的 `--text` 输入。 |
| 登录状态 URL 脱敏 | 已实现 | status 响应现在会在经 New API 返回前移除 HTTP(S) 浏览器 URL 的 query string 与 fragment，避免 OAuth `state`、`code` 或类似授权载荷进入 Admin UI/API 响应。 |
| 登录状态幂等性 | 已实现 | 当 sidecar state 文件不存在时，`login/status` 现在返回成功的 `stopped` 状态，避免前端轮询或页面刷新在尚未启动登录会话前暴露伪失败。 |
| 登录会话所有权保护 | 本地已实现 | login start/status/screenshot/click/key/stop controller action 现在会先确认持久 OpenCode account 行存在，再调用 sidecar。缺失账号 ID 会返回同一脱敏的账号不存在业务失败，并且不会创建或触碰浏览器 artifact。 |
| 浏览器启动诊断 | 已实现 | sidecar 现在会在启动阶段监听 Chromium 与 Xvfb 的 `error` / early-`exit` 事件，并返回结构化 JSON 失败，避免浏览器依赖缺失或配置错误时退化为不透明的 CDP 超时。 |
| Sidecar path resolution | 已实现并完成远端验证 | Go 服务现在会从进程工作目录和当前可执行文件目录两个起点解析 sidecar 脚本，并分别向上查找。这样当 systemd working directory 与 clean artifact 目录不一致时，远端浏览器操作仍能稳定找到 sidecar；已推送的 `main` artifact 已通过远端构建、定向测试、服务重启、HTTP smoke 与 sidecar 空状态检查验证该路径。 |
| 陈旧浏览器状态处理 | 已实现 | `login/start` 现在只会在记录的 PID 存活且 CDP endpoint 可达时复用既有浏览器；陈旧 PID/state 组合会继续走新浏览器启动流程。 |
| Stop 生命周期清理 | 已实现 | `login/stop` 现在会在 SIGTERM 后等待记录的 browser/Xvfb 进程退出，并在未退出时使用强制清理兜底，减少返回 `stopped` 前遗留浏览器进程的概率。 |
| Delete 生命周期清理 | 本地已实现 | 删除 OpenCode 账号现在会先 purge 该账号的浏览器会话 artifact，再删除数据库记录：sidecar 会停止记录的进程，并删除账号 state 文件与浏览器 profile 目录。如果 purge 失败，账号会保留，操作者可以重试清理，避免在可能仍有浏览器 artifact 存在时丢失持久化操作句柄。 |
| 删除缺失账号保护 | 本地已实现 | delete 现在会先确认持久 OpenCode account 行存在，再调用 sidecar purge。缺失账号 ID 会返回与 update/extract/quota 流程一致的脱敏业务错误，并且不会为一个 New API 不再拥有的账号 ID 触发浏览器 artifact 清理。 |
| Sidecar state 损坏处理 | 本地已实现 | state 文件缺失仍然是幂等的 `stopped` 会话，但 state 不可读或 JSON 无效现在会返回结构化 sidecar 失败。start/status/stop/purge 不再把损坏 state 当成“没有会话”，因此账号删除会 fail closed，避免在可能仍有孤立浏览器 profile 或进程时删除持久账号行。 |
| Screenshot 瞬时失败重试 | 已实现 | `login/screenshot` 现在会对浏览器/CDP 的瞬时截图失败执行重试；该动作是只读操作，符合远端 smoke 中 screenshot 首次失败、立即重试成功的实际现象。 |
| Sidecar symlinked artifact entrypoint | 已实现并完成本地验证 | sidecar CLI 现在会先对 `process.argv[1]` 做 realpath 解析，再与 `import.meta.url` 比较，因此通过 `new-api-current` symlink 执行脚本时仍会运行 `main()`。这修复了一个只在部署态出现的 false-smoke 风险：直接 release 路径可运行，但 symlink artifact 路径无输出。 |
| Extractor | 已实现 | 候选扫描覆盖 OpenCode 域 cookie、local/session storage 与 JSON responses；测试覆盖排序和空状态拒绝。 |
| OAuth token 候选过滤 | 已实现并完成本地验证 | extractor 不再把泛化的 `*token` 字段当成 OpenCode API key，并且会明确拒绝 OAuth `access_token`、`id_token`、`refresh_token` 字段作为 API-key 候选。这样可以避免把授权过程产物误存成 provider API key。 |
| 部分提取合并安全 | 已实现 | `login/extract` 现在会把非空提取字段合并进已有加密账号材料，不再用空的 partial candidate 覆盖先前已保存的 API key、workspace ID、email 或 cookie。 |
| Partial extract quota preservation | 本地已实现 | `login/extract` 现在只有在浏览器提取结果确实包含 quota 证据时，才更新已存 quota 三元组。只包含 cookie/API key 的 partial extract 不再清空既有 `quota_raw`、`quota_limit` 或 `quota_used`；当 quota 证据存在时，三元组会作为一次完整观测一起更新。 |
| Channel binding 校验 | 已实现并完成本地验证 | OpenCode account create/update 现在会在 model 边界同时拒绝缺失 channel ID 与不存在的绑定 channel 行，避免 ghost binding 进入持久存储。channel enabled/disabled 状态仍由 channel 管理负责，不与账号导入强耦合；如果绑定 channel 在导入后被删除，readiness 会用既有 `channel_id` 字段报告缺失，activation 会 fail closed，且不暴露存储层 `record not found`。 |
| 凭据 readiness 诊断 | 已实现 | OpenCode account 公开响应现在提供脱敏的 `credential_integrity`、`activation_ready` 与 `missing_activation_fields` 信号，让操作者能区分账号材料缺失与密文解密失败，而不看到任何原始 secret。 |
| 凭据 key source 诊断 | 已实现并完成远端验证 | OpenCode account 公开响应现在包含非敏感的 `credential_key_source`，并且当已有 OpenCode 账号仍使用 session-secret fallback 而不是专用 crypto secret 加密时，启动日志会给出系统告警。这样在真实账号导入与 cache E2E 前，最容易踩的部署稳定性问题会变成可见状态。 |
| 凭据 diagnostics endpoint | 本地已实现并验证；待远端上线 | 已增加 root-only `GET /api/opencode/accounts/diagnostics`，只暴露 `credential_key_source` 与 `uses_fallback_credential_key`。这样 Admin UI 在还没有任何 OpenCode 账号时也能提示 fallback key 风险，同时不暴露 secret 值、密文、cookie、workspace ID、账号邮箱、OAuth payload 或本地部署路径。当前已增加 handler 级测试断言 JSON 契约，并确认配置的 crypto secret 不会出现在响应中。 |
| 前端 key-source 告警 | 本地已实现并验证 | OpenCode account 页面现在消费 diagnostics endpoint，并在生产账号导入前显示页面级 fallback-key 告警。告警与主工作区现在放在显式 fixed-content `auto + minmax(0,1fr)` 网格中，因此告警可见时浏览器面板仍受高度约束。账号列表仍会用紧凑的 `Fallback key` 标记说明已导入账号正在使用 fallback credential key source，页面刷新动作也会同时刷新 accounts、channels 与 diagnostics。当前已增加 helper 级测试覆盖 refresh fan-out、刷新禁用状态和 fixed-content grid row 决策，未引入新的 React DOM 测试栈。 |
| 前端账号窗口 | 已实现 | 已增加 Root-only 管理路由、侧边栏入口、账号列表、已启用 channel 选择器与数字 ID fallback、远端截图控制、extract、quota refresh、activate、stop、delete 操作。账号列表现在使用固定的创建/绑定工具栏与独立滚动的 table 区域，因此导入多个 OpenCode 账号后不会把远端浏览器工作区推出固定管理后台表面。 |
| 前端删除确认 | 本地已实现 | 账号删除现在使用现有 `ConfirmDialog` destructive flow，而不是单击即删。对话框会显示被选中的账号名，在删除请求执行中禁用重复确认，并且只有删除当前选中账号时才清空远端浏览器面板。helper 测试覆盖 dialog open 与 confirm enabled 判定，未新增 React DOM 测试栈。 |
| 前端业务失败拦截 | 本地已实现 | OpenCode account API wrapper 现在会在 React Query 执行 success handler 前拒绝 New API 的业务失败响应（`success:false`）。这样 purge/delete、extract、quota refresh、activation 或浏览器会话失败时，不会误弹成功 toast，也不会在后端刻意保留账号以便重试时清空前端状态。 |
| 激活到现有渠道 | 已实现 | 激活时解密选中账号 API key，在事务内更新绑定 channel，标记账号 active，并在 commit 后刷新 channel cache。 |
| Activation credential contract | 已实现并完成本地验证 | 激活现在会按照绑定 channel 类型构造 channel credential。非 Codex channel 继续接受纯 OpenCode API key；Codex channel 必须提供包含 `access_token` 与 `account_id` 的 JSON 材料。公开 readiness 诊断现在会在操作者点击 activate 前，把 Codex/plain-key 绑定标记为不可激活。 |
| 激活错误语义 | 本地已实现 | activate 现在对缺失账号 ID 返回同一脱敏的账号不存在业务失败；绑定 channel 缺失时返回明确的 channel-not-found 失败，不再把存储层 `record not found` 原文暴露给操作者。 |
| 远端 clean artifact 部署 | 已完成 | 已从隔离的干净 checkout 构建已推送的 `main`，生成包含二进制与 sidecar 的 artifact，远端服务已切换到这些 artifact，并显式保留既有运行时数据路径，服务状态已验证为 active。 |
| 上一次已验证远端上线 | 已完成 | 已推送的 `main` 提交 `e76a8063` 是上一次在远端服务完成验证的上线版本。经过 readiness polling 的 HTTP smoke 返回 200，服务状态为 active，基于可执行文件目录的 sidecar 解析返回成功的空状态 `stopped`，远端 default 前端 typecheck/build 通过，classic 前端 build 通过，远端 Node sidecar 测试通过，OpenCode key-source/readiness/extractor/quota/activation 相关 Go 定向测试通过，且 sidecar path-resolution 回归测试已在部署源 checkout 上通过。该版本之后的变更，包括当前本地 delete-purge hardening，仍需要在 Tailscale peer 恢复可达后再做远端 clean artifact 上线验证。 |
| 真实 OpenCode 登录 E2E | 待执行 | 需要操作者控制的 OpenCode 订阅账号；仓库不包含真实账号材料。 |
| 真实 `glm-5.2` cache-hit E2E | 待执行 | 只能在真实 OpenCode 账号经 New API 导入并激活后执行。 |

### 架构推进更新

当前实现已经落到计划中的 New API 原生连接器形态：

```text
Admin Web
  -> /opencode-accounts route
  -> Root-only /api/opencode/accounts API
  -> OpenCode account service and model
  -> encrypted durable account fields
  -> CDP sidecar for isolated remote authorization
  -> extractor
  -> atomic channel activation
  -> existing relay and cache accounting pipeline
```

实现中最关键且仍然成立的架构选择是职责归属：浏览器进程状态留在 sidecar/session 层，持久账号元数据留在 `model.OpenCodeAccount`，channel 变更只通过 activation service 完成。调用方不需要也不应该手工拼接“提取、解密、更新 channel、刷新 cache”这些半步操作；完整操作由 service 拥有。

当前取舍是先用 CDP screenshot/click/key primitives，而不是 noVNC。它的暴露面更小、权限边界更容易收束，对 OAuth 授权通常足够；代价是如果 OpenCode 或 Google 登录页出现复杂交互，操作体验不如完整远端桌面。更稳妥的升级路径是在真实 E2E 证明 CDP 不足时再加 noVNC 或 Playwright streaming 兜底，不改变账号模型和激活契约。

最新的安全收敛修复了 CDP key 路径上的 argv 暴露问题。浏览器文本输入，包括在 Google/OpenCode 页面键入的内容，现在通过 stdin 提供给 sidecar。这样可以避免操作者输入出现在 `ps`、服务管理器、shell history 或进程遥测中。代价是临时手工调用 sidecar 时不能再使用 `--text`；这是有意收窄，因为 Web API 应该是唯一受支持的输入面。

状态响应现在把浏览器 URL 视为敏感元数据。OAuth redirect URL 可能携带 `state`、`code` 或 provider-specific query payload，因此 New API 会在返回给 Admin UI 前移除 query string 与 fragment。sidecar 内部仍可使用完整 URL 做浏览器控制，但 API contract 只暴露操作者需要看到的导航位置。

状态接口现在刻意保持幂等。缺少 sidecar state 文件表示“该账号还没有启动登录浏览器”，而不是“连接器失败”。screenshot、click、key、extract 仍然会在没有现存会话时失败，因为这些操作确实需要 live browser target。

登录会话操作现在会在 sidecar 工作前验证持久账号所有权。这样 `stopped` 幂等语义只适用于真实账号；带缺失账号 ID 的 stale UI/API 调用不能创建、探测、键入、点击、停止或截图 New API 不再拥有的账号编号浏览器 artifact。

浏览器启动失败现在会更早、更可诊断地失败。在这次收敛之前，错误的 Chromium 路径或 Xvfb/Chromium 早退可能表现为非结构化进程错误或缓慢的 CDP timeout。现在 sidecar 会将 CDP ready 与进程启动失败进行竞速，并输出 API 层可直接展示给操作者的结构化 JSON 错误。

sidecar 脚本解析现在不再假设进程工作目录就是 artifact 根目录。Go 服务会同时从当前工作目录和运行中的可执行文件目录向上查找。这个改动是部署稳健性收敛：systemd working directory、clean artifact symlink、运行时数据目录可以合理分离，但 sidecar 脚本仍应该能从部署二进制旁边被发现。

最新的 sidecar path-resolution 加固已经从已推送的 `main` 提交 `f17bf862` 部署到远端。远端 clean artifact 构建完成，两个前端构建完成，远端 Node sidecar 测试通过，sidecar path-resolution Go 定向测试通过，OpenCode account/controller/router 扩展 Go 测试通过，服务重启后为 active，经过 readiness polling 的 HTTP smoke 返回 200，空 state directory 下的 sidecar `status` 返回 `success/stopped`。

既有浏览器复用现在以 CDP 可达性为准，而不是只看 PID 是否存活。进程 ID 可能仍存活或被复用，但记录的调试端口已经不可用；如果把这种状态当成可复用会话，前端会在 start 后看到 stopped。现在除非既有会话真实可达，否则 sidecar 会继续拉起新浏览器。

stop 现在更完整地拥有进程清理语义。它不再发送 SIGTERM 后立刻返回，而是等待记录的 browser/Xvfb 进程退出，并在未退出时使用强制清理兜底。这样 lifecycle smoke 与重复登录尝试更不容易堆积陈旧 headless browser 进程。

账号删除现在也进入同一生命周期边界。controller 会在删除持久账号行前先 purge 该账号的浏览器会话；sidecar 会停止记录的进程，并删除账号 state 文件与浏览器 profile 目录。如果 purge 失败，删除会 fail closed，并保留账号以便重试。这里的取舍是：sidecar 故障可能暂时阻塞删除，但这比在远端浏览器 artifact 可能仍存在时删除唯一的持久账号句柄更安全。

当前 delete-purge hardening 只完成本地与仓库级验证，不能视为已经在远端服务生效。必须等远端 Tailscale peer key 问题修复后，重新执行 clean artifact 上线、HTTP smoke 与 sidecar smoke 验证。

state 损坏现在也有明确的生命周期语义。state 文件缺失仍表示尚未启动登录浏览器，返回 `stopped`；state 不可读或 JSON 无效则是完整性失败。start、status、stop、purge 现在都会暴露该失败，而不是静默进入“无会话”路径。这个选择刻意偏向有噪声但可重试的操作者状态，而不是在可能留下未跟踪浏览器 profile 或进程时删除持久账号。

截图捕获现在会对浏览器/CDP 的瞬时失败执行重试。这个重试刻意只用于 screenshot，因为它是只读操作；click 和 key input 仍然保持单次执行，避免重复用户动作。该修复对应远端授权页 smoke 中 screenshot 首次失败、立即重试成功的实际现象。

sidecar CLI 入口现在把 symlink artifact 路径作为一等部署形态处理。systemd 和 smoke 脚本会通过 `new-api-current` symlink 执行 sidecar，而 Node 的 `import.meta.url` 会指向解析后的 release 真实路径。先前的字面路径比较会导致 symlink 执行时 `main()` 静默跳过。修复后先比较 realpath，并仅在 realpath 解析失败时回退到原始路径。

最新的 activation credential contract 与 symlink sidecar 入口修复已经从已推送的 `main` 提交 `2e1687eb` 部署到远端。远端 clean artifact 构建完成，两个前端构建完成，远端 Node sidecar 测试通过，activation/readiness Go 定向测试通过，服务重启后为 active，HTTP smoke 返回 200，sidecar `status` 经 symlink artifact 路径执行时返回 `success/stopped`。

最新的 sidecar 生命周期、状态脱敏、partial-extract merge、channel binding、前端 channel selector 和 screenshot retry 修复已经从已推送的 `main` 提交 `c95d3c0d` 部署到远端。远端服务已切换到新的 clean artifact、完成重启，并通过 HTTP smoke 与 sidecar 检查。官方 OpenCode 授权页已经在无凭证条件下执行 start、status、screenshot、stop；screenshot 阶段到达 OpenCode 授权域，stop 返回 `stopped`，按浏览器进程名约束的残留检查未发现该 smoke session 对应的 Chromium/Xvfb 进程。

Sidecar extractor 现在补上了原计划中的一个真实实现缺口。后端 extractor 已经接受 `json_responses`，但浏览器 sidecar 先前实际返回空数组；如果真实登录后的 API key、workspace 或 quota 只出现在 OpenCode 页面接口响应中，就会被漏掉。现在 extract 会在浏览器侧执行异步 probe，抓取页面近期加载过、看起来像账号/quota/workspace 端点的 OpenCode 同站 JSON 资源。它会刻意拒绝静态资源，以及携带 OAuth `code`、`state` 或 token payload 的 URL。这个取舍提升了提取覆盖率，同时不重放授权 callback，也不触碰非 OpenCode 资源。

extractor 现在也会拒绝把 OAuth token 字段作为 API-key 候选。这比“所有以 `token` 结尾的 key 都可作为 API key”更严格：OpenCode API key 仍可通过 `api_key`、`apiKey`、`api.key` 或 `.key` 这类明确 API-key 形态的字段发现；`access_token`、`id_token`、`refresh_token` 则被视为授权过程产物，而不是 provider API key。这里的取舍是有意保守：如果未来上游只暴露泛化 bearer token 字段，连接器应该提取失败并要求补充针对性 parser，而不是静默持久化错误凭据类别。

quota 解析也已经收紧。当 key 同时表达 used、usage 或 consumed 时，不能仅因为字段路径包含 quota 就把数值分类为 limit 或 raw display。这个修复移除了顺序相关故障：`quota.used` 可能被写入 `quota_limit` 或作为 quota raw 展示值，从而污染 quota 展示和后续对账号容量的判断。

最新的 OAuth-token 过滤与 quota raw 稳定化修复已经从已推送的 `main` 提交 `346dc24d` 部署到远端。远端 clean artifact 构建完成，两个前端构建完成，远端 Node sidecar 测试通过，extractor/quota 测试通过重复运行覆盖 Go map 遍历顺序，OpenCode Go 扩展测试通过，服务重启后为 active，HTTP smoke 返回 200，sidecar `status` 经 symlink artifact 路径执行时返回 `success/stopped`。

提取流程现在会在浏览器只给出部分候选时保留已有持久账号材料。真实授权页可能先暴露 cookie/quota，稍后才暴露 API key/workspace，或者因为导航时机不同只暴露部分字段。controller 现在会把非空提取字段合并到既有解密 secret 集合并重新加密保存，而不是把缺失候选当作显式删除。

quota 持久化现在遵循同样的 partial-extract 规则。浏览器提取结果如果只包含 cookie、workspace 或 API-key 材料，不应该擦掉上一份已知 quota snapshot。controller 现在只有在存在 quota 证据时才更新 `quota_raw`、`quota_limit` 与 `quota_used`，并且把三个字段作为同一次观测整体更新。这样可以避免授权页导航先暴露凭据、稍后才暴露 quota 时造成 UI 容量展示抖动。

最新的 partial-extract quota preservation 修复已经从已推送的 `main` 提交 `59645a65` 部署到远端。远端 clean artifact 构建完成，两个前端构建完成，远端 Node sidecar 测试通过，extractor/quota 重复测试通过，partial-extract controller 测试通过，OpenCode Go 扩展测试通过，服务重启后为 active，HTTP smoke 返回 200，sidecar `status` 经 symlink artifact 路径执行时返回 `success/stopped`。

Channel binding 现在会在 OpenCode account 持久化前校验。model 会拒绝缺失 channel ID 与不存在的绑定 channel 行，但有意不把 enabled/disabled 状态耦合进账号导入，通道路由状态仍由 channel 管理负责。前端也复用现有 channel list API，将已启用 channel 展示为可选项，同时保留数字 ID fallback。如果 channel 在导入后被删除，账号 readiness 会用既有 `channel_id` 字段报告缺失，activation 会 fail closed，且不暴露存储层原始错误。

凭据 readiness 现在是明确的 API 契约。先前公开响应只有 `has_*` 标志；如果 `CRYPTO_SECRET` 配错或轮换，密文字段仍然“存在”，但实际已无法解密，操作者要到 activate 阶段才会看到失败。现在账号响应会区分密文存在、凭据完整性和是否可激活。前端因此可以显示脱敏的 credential error 状态，并在明显无法成功时禁用 activate。代价是响应 schema 小幅扩展，但只暴露字段名与布尔状态，不暴露原始 secret、cookie、workspace ID、账号邮箱、OAuth payload 或本地部署路径。

激活现在有明确的 channel credential contract，而不是把提取到的材料盲写进 `channel.key`。这对 Codex channel 很关键：当前 fork 的 Codex relay 消费 OAuth JSON，并在请求头构造阶段要求同时存在 `access_token` 与 `account_id`；如果把纯 OpenCode API key 写进去，Admin UI 会显示激活成功，但第一轮调用会在 `SetupRequestHeader` 失败。现在 service 会在事务内拒绝这种不匹配，保持旧 channel key 不变，并把同一诊断反馈到账号 readiness，让前端提前禁用必然失败的 activate 路径。这里的取舍是保守的：连接器不会把 `workspace_id` 推断成 `account_id`，因为两者等价性没有证据。

激活错误语义现在与 OpenCode account API 的其它入口一致。缺失账号 ID 会在 controller 边界被拒绝，并返回 update/extract/quota/login 流程同样使用的脱敏账号不存在业务响应；绑定 channel 缺失会报告为 channel 所有权/配置错误，而不是直接暴露存储层 `record not found` 原文。activation service 仍然拥有事务，失败时不会改写 channel 或 account 状态。

最大部署坑点是 `CRYPTO_SECRET`：导入的持久凭证要求该值稳定。如果运行时使用自动生成或轮换的 secret，已存 OpenCode 账号材料会解密失败并 fail closed，需要重新导入。

这个坑点现在不只停留在计划文档里。OpenCode account 响应会暴露 `credential_key_source`，取值为 `crypto_secret` 或 `session_secret_fallback`；如果进程使用 fallback key source 且数据库中已经存在 OpenCode 账号，启动阶段会写出系统告警。该响应仍然是非敏感的：只暴露配置类别，不暴露 secret 值、密文、cookie、workspace ID、账号邮箱、OAuth payload 或本地部署路径。

root-only diagnostics endpoint 现在承载同一信号的实例级形态。`GET /api/opencode/accounts/diagnostics` 只暴露 key-source 类别与 fallback 布尔值，因此 UI 可以在第一个 OpenCode 账号导入前给出提示。这个职责拆分更干净：账号响应解释已存账号状态，diagnostics 解释当前 New API 进程是否适合导入持久生产凭据。

default 前端现在把这个诊断消费为页面级告警。使用 fallback key source 的账号仍会在列表中显示紧凑的 `Fallback key` 标记，但高价值告警不再依赖用户先选中某个已存在账号。UI 刻意不做 modal 或硬阻断：activation readiness 和后端校验继续负责硬正确性，前端告警负责在账号操作开始前暴露部署取舍。

该告警现在属于 fixed-content 布局契约，而不是临时插在工作区上方的普通块。页面使用显式 `auto + minmax(0,1fr)` 网格，因此告警出现时不会把远端浏览器 viewport 推出受限的管理后台区域。Refresh 命令也会同时刷新账号列表、channel 选项与 diagnostics，因为这三组数据共同决定操作者当前的账号切换决策。

账号删除现在有与后端语义一致的 UI guard。由于 delete 会在删除持久账号行前 purge 浏览器 state/profile artifact，它不再是普通表格行操作。default 前端现在会打开现有 destructive 确认对话框，在删除请求执行时禁用重复确认，并避免操作者删除其它账号时清空当前浏览器面板。这只是确认层，不是新的后端模式：server-side purge/fail-closed 契约仍然负责硬正确性。

delete 现在会在产生外部副作用前验证所有权。缺失账号 ID 是持久状态问题，不是 sidecar cleanup 请求，所以 controller 会先返回脱敏的“账号不存在”业务失败，不再调用 purge。这样外部浏览器清理只作用于 New API 仍然拥有的账号，也让 stale UI/API 调用保持可重试，不会删除任意按账号数字命名的浏览器 artifact。

前端 API 边界现在会拒绝 New API 的业务失败响应，而不是把 HTTP 200 直接当作成功。这里很关键：`common.ApiError` 会以 200 返回 `{success:false}`，如果不在 wrapper 层拦截，React Query 会对失败的 purge/delete、extract、quota refresh、activation 或浏览器会话操作继续执行 success handler。这个 wrapper 保留全局错误 toast 行为，但阻止失败操作误弹成功提示，也避免后端刻意保留账号以便重试时前端错误清空状态。

凭据 key-source 诊断已经从已推送的 `main` 提交 `e76a8063` 部署到远端。远端 clean artifact 构建完成，default 前端 typecheck/build 完成，classic 前端 build 完成，远端 Node sidecar 测试通过，OpenCode key-source/readiness/extractor/quota/activation Go 定向测试通过，服务重启完成，经过 readiness polling 的 HTTP smoke 返回 200，空 state directory 下的 sidecar `status` 返回 `success/stopped`。

远端部署现在已经与旧运行工作树分离。服务从基于已推送 `main` 构建的 clean artifact 运行，同时显式保留既有运行时数据位置。这样不会覆盖旧运行树中仍存在的本地 cache/accounting 工作，也把源码、artifact 与运行时数据拆成了三个独立边界。

### 验证更新

已成功验证：

```text
go test ./common ./service/relayconvert -count=1
go test ./model -run TestCreateOpenCodeAccount -count=1
go test ./model ./controller ./service -run 'TestCreateOpenCodeAccount|TestOpenCodeAccountPublicViewReportsCredentialDecryptFailure|TestOpenCodeAccountResponseDoesNotExposeSecrets|TestMergeExtractedOpenCodeSecretsPreservesExistingFields|TestExtractOpenCodeSecretsFromBrowserState|TestExtractOpenCodeQuotaFromBrowserState|TestActivateOpenCodeAccount|TestObserveChannelAffinityUsageCacheByRelayFormat_MixedMode' -count=1
go test ./controller -run TestOpenCodeAccountResponseDoesNotExposeSecrets -count=1
go test ./controller -run 'TestOpenCodeAccountResponseDoesNotExposeSecrets|TestMergeExtractedOpenCodeSecretsPreservesExistingFields' -count=1
go test ./controller -run "TestApplyExtractedOpenCodeAccount|TestMergeExtractedOpenCodeSecrets" -count=1
go test ./router -run TestOpenCodeAccountRoutesRegisterExpectedPaths -count=1
go test ./service -run 'TestExtractOpenCodeSecretsFromBrowserState|TestActivateOpenCodeAccount' -count=1
go test ./service -run "TestExtractOpenCodeSecretsFromBrowserState|TestExtractOpenCodeQuotaFromBrowserState" -count=20
go test ./service -run TestObserveChannelAffinityUsageCacheByRelayFormat_MixedMode -count=1
go test ./service -run 'TestExtractOpenCodeSecretsFromBrowserState|TestExtractOpenCodeQuotaFromBrowserState|TestActivateOpenCodeAccount|TestObserveChannelAffinityUsageCacheByRelayFormat_MixedMode' -count=1
go test ./service -run 'TestBuildOpenCodeAuthCommandSpecPassesKeyTextThroughStdin|TestExtractOpenCodeSecretsFromBrowserState|TestExtractOpenCodeQuotaFromBrowserState|TestActivateOpenCodeAccount|TestObserveChannelAffinityUsageCacheByRelayFormat_MixedMode' -count=1
go test ./service -run 'TestBuildOpenCodeAuthCommandSpecPassesKeyTextThroughStdin|TestOpenCodeAuthSidecarStatusTreatsMissingStateAsStopped|TestExtractOpenCodeSecretsFromBrowserState|TestExtractOpenCodeQuotaFromBrowserState|TestActivateOpenCodeAccount|TestObserveChannelAffinityUsageCacheByRelayFormat_MixedMode' -count=1
go test ./service -run 'TestOpenCodeAuthSidecarStartReportsInvalidChromiumBinary|TestOpenCodeAuthSidecarStatusTreatsMissingStateAsStopped|TestBuildOpenCodeAuthCommandSpecPassesKeyTextThroughStdin' -count=1
go test ./service -run "TestFindOpenCodeAuthSidecarPathSearchesExecutableDirectory|TestOpenCodeAuthSidecarStatusTreatsMissingStateAsStopped|TestBuildOpenCodeAuthCommandSpecPassesKeyTextThroughStdin" -count=1
go test ./service -run 'TestOpenCodeAuthSidecarStartReportsInvalidChromiumBinary|TestOpenCodeAuthSidecarStatusTreatsMissingStateAsStopped|TestBuildOpenCodeAuthCommandSpecPassesKeyTextThroughStdin|TestExtractOpenCodeSecretsFromBrowserState|TestExtractOpenCodeQuotaFromBrowserState|TestActivateOpenCodeAccount|TestObserveChannelAffinityUsageCacheByRelayFormat_MixedMode' -count=1
go test ./service -run 'TestOpenCodeAuthSidecarStartReportsInvalidChromiumBinary|TestOpenCodeAuthSidecarStartDoesNotReusePidWithoutCDP|TestOpenCodeAuthSidecarStatusTreatsMissingStateAsStopped|TestBuildOpenCodeAuthCommandSpecPassesKeyTextThroughStdin|TestExtractOpenCodeSecretsFromBrowserState|TestExtractOpenCodeQuotaFromBrowserState|TestActivateOpenCodeAccount|TestObserveChannelAffinityUsageCacheByRelayFormat_MixedMode' -count=1
go test ./service -run 'TestOpenCodeAuthSidecarStopWaitsForRecordedProcessExit|TestOpenCodeAuthSidecarStartReportsInvalidChromiumBinary|TestOpenCodeAuthSidecarStartDoesNotReusePidWithoutCDP|TestOpenCodeAuthSidecarStatusTreatsMissingStateAsStopped|TestBuildOpenCodeAuthCommandSpecPassesKeyTextThroughStdin|TestExtractOpenCodeSecretsFromBrowserState|TestExtractOpenCodeQuotaFromBrowserState|TestActivateOpenCodeAccount|TestObserveChannelAffinityUsageCacheByRelayFormat_MixedMode' -count=1
go test ./service -run 'TestSanitizeOpenCodeLoginSessionStatus|TestBuildOpenCodeAuthCommandSpecPassesKeyTextThroughStdin|TestOpenCodeAuthSidecarStatusTreatsMissingStateAsStopped|TestExtractOpenCodeSecretsFromBrowserState|TestExtractOpenCodeQuotaFromBrowserState|TestActivateOpenCodeAccount|TestObserveChannelAffinityUsageCacheByRelayFormat_MixedMode' -count=1
go test ./service ./controller -run "TestActivateOpenCodeAccount|TestOpenCodeAccountResponse" -count=1
go test ./controller -run "TestOpenCodeAccountDiagnosticsReportsCredentialKeySource|TestGetOpenCodeAccountDiagnosticsReturnsNonSecretPayload" -count=1
go test ./controller -run "TestDeleteOpenCodeAccountPurgesLoginSessionBeforeDeleting|TestDeleteOpenCodeAccountPreservesAccountWhenPurgeFails" -count=1
go test ./model ./controller ./service ./router -run "TestDeleteOpenCodeAccountPurgesLoginSessionBeforeDeleting|TestDeleteOpenCodeAccountPreservesAccountWhenPurgeFails|TestGetOpenCodeAccountDiagnosticsReturnsNonSecretPayload|TestOpenCodeAccountDiagnosticsReportsCredentialKeySource|TestCreateOpenCodeAccount|TestOpenCodeAccountPublicViewReportsCredentialDecryptFailure|TestOpenCodeAccountResponse|TestOpenCodeAccountPublicViewReportsCredentialKeySource|TestMergeExtractedOpenCodeSecrets|TestApplyExtractedOpenCodeAccount|TestExtractOpenCodeSecretsFromBrowserState|TestExtractOpenCodeQuotaFromBrowserState|TestActivateOpenCodeAccount|TestBuildOpenCodeAuthCommandSpecPassesKeyTextThroughStdin|TestFindOpenCodeAuthSidecarPathSearchesExecutableDirectory|TestOpenCodeAuthSidecarStatusTreatsMissingStateAsStopped|TestOpenCodeAccountRoutesRegisterExpectedPaths" -count=1
go test ./model ./controller ./service ./router -run "TestCreateOpenCodeAccount|TestOpenCodeAccountPublicViewReportsCredentialDecryptFailure|TestOpenCodeAccountResponse|TestMergeExtractedOpenCodeSecretsPreservesExistingFields|TestExtractOpenCodeSecretsFromBrowserState|TestExtractOpenCodeQuotaFromBrowserState|TestActivateOpenCodeAccount|TestBuildOpenCodeAuthCommandSpecPassesKeyTextThroughStdin|TestOpenCodeAuthSidecarStatusTreatsMissingStateAsStopped|TestOpenCodeAccountRoutesRegisterExpectedPaths" -count=1
go test ./model ./controller ./service ./router -run "TestOpenCodeAccountDiagnosticsReportsCredentialKeySource|TestCreateOpenCodeAccount|TestOpenCodeAccountPublicViewReportsCredentialDecryptFailure|TestOpenCodeAccountResponse|TestOpenCodeAccountPublicViewReportsCredentialKeySource|TestMergeExtractedOpenCodeSecrets|TestApplyExtractedOpenCodeAccount|TestExtractOpenCodeSecretsFromBrowserState|TestExtractOpenCodeQuotaFromBrowserState|TestActivateOpenCodeAccount|TestBuildOpenCodeAuthCommandSpecPassesKeyTextThroughStdin|TestFindOpenCodeAuthSidecarPathSearchesExecutableDirectory|TestOpenCodeAuthSidecarStatusTreatsMissingStateAsStopped|TestOpenCodeAccountRoutesRegisterExpectedPaths" -count=1
go test ./common ./model ./controller ./service ./router -run "TestOpenCodeAccountPublicViewReportsCredentialKeySource|TestCreateOpenCodeAccount|TestOpenCodeAccountPublicViewReportsCredentialDecryptFailure|TestOpenCodeAccountResponse|TestMergeExtractedOpenCodeSecrets|TestApplyExtractedOpenCodeAccount|TestExtractOpenCodeSecretsFromBrowserState|TestExtractOpenCodeQuotaFromBrowserState|TestActivateOpenCodeAccount|TestBuildOpenCodeAuthCommandSpecPassesKeyTextThroughStdin|TestFindOpenCodeAuthSidecarPathSearchesExecutableDirectory|TestOpenCodeAuthSidecarStatusTreatsMissingStateAsStopped|TestOpenCodeAccountRoutesRegisterExpectedPaths" -count=1
go test ./controller -run "TestDeleteOpenCodeAccountPurgesLoginSessionBeforeDeleting|TestDeleteOpenCodeAccountPreservesAccountWhenPurgeFails|TestDeleteOpenCodeAccountSkipsPurgeWhenAccountMissing|TestGetOpenCodeAccountDiagnosticsReturnsNonSecretPayload|TestOpenCodeAccountDiagnosticsReportsCredentialKeySource" -count=1
go test ./controller -run "TestOpenCodeLoginSessionActionsSkipSidecarWhenAccountMissing|TestDeleteOpenCodeAccountSkipsPurgeWhenAccountMissing|TestDeleteOpenCodeAccountPurgesLoginSessionBeforeDeleting|TestDeleteOpenCodeAccountPreservesAccountWhenPurgeFails" -count=1
go test ./controller ./service -run "TestActivateOpenCodeAccountReturnsNotFoundWhenAccountMissing|TestActivateOpenCodeAccountRequiresExistingChannel|TestActivateOpenCodeAccountRequiresAPIKey|TestActivateOpenCodeAccountRejectsPlainAPIKeyForCodexChannel|TestActivateOpenCodeAccountAcceptsCodexOAuthJSONKey|TestActivateOpenCodeAccountUpdatesBoundChannelKeyAndActiveAccount" -count=1
go test ./service -run "TestObserveChannelAffinityUsageCacheByRelayFormat" -count=20
go test ./model ./controller ./service -run "TestCreateOpenCodeAccount|TestUpdateOpenCodeAccountRejectsUnknownChannelBinding|TestOpenCodeAccountPublicView|TestOpenCodeAccountResponseMarks|TestActivateOpenCodeAccount" -count=1
go test ./service -run "TestChannelAffinityHitCodexTemplatePassHeadersEffective|TestGetPreferredChannelByAffinity_RequestHeaderKeySource|TestApplyChannelAffinityOverrideTemplate" -count=1
go test ./model ./controller ./service ./router ./service/relayconvert -run "TestActivateOpenCodeAccountReturnsNotFoundWhenAccountMissing|TestActivateOpenCodeAccountRequiresExistingChannel|TestOpenCodeLoginSessionActionsSkipSidecarWhenAccountMissing|TestDeleteOpenCodeAccountPurgesLoginSessionBeforeDeleting|TestDeleteOpenCodeAccountPreservesAccountWhenPurgeFails|TestDeleteOpenCodeAccountSkipsPurgeWhenAccountMissing|TestGetOpenCodeAccountDiagnosticsReturnsNonSecretPayload|TestOpenCodeAccountDiagnosticsReportsCredentialKeySource|TestCreateOpenCodeAccount|TestOpenCodeAccountPublicViewReportsCredentialDecryptFailure|TestOpenCodeAccountResponse|TestOpenCodeAccountPublicViewReportsCredentialKeySource|TestMergeExtractedOpenCodeSecrets|TestApplyExtractedOpenCodeAccount|TestExtractOpenCodeSecretsFromBrowserState|TestExtractOpenCodeQuotaFromBrowserState|TestActivateOpenCodeAccount|TestBuildOpenCodeAuthCommandSpecPassesKeyTextThroughStdin|TestFindOpenCodeAuthSidecarPathSearchesExecutableDirectory|TestOpenCodeAuthSidecarStatusTreatsMissingStateAsStopped|TestOpenCodeAccountRoutesRegisterExpectedPaths|TestUsageFromChatUsagePreservesCachedTokensForBothAccountingPaths|TestObserveChannelAffinityUsageCacheByRelayFormat" -count=1
bun run typecheck
bun test src/features/opencode-accounts/lib.test.ts
bunx oxlint -c .oxlintrc.json src/features/opencode-accounts src/routes/_authenticated/opencode-accounts src/hooks/use-sidebar-data.ts src/hooks/use-sidebar-config.ts
bunx oxlint -c .oxlintrc.json src/features/opencode-accounts
web/default 下 bun run build
web/classic 下 bun run build
go build .
node --test scripts/opencode-auth-session.test.mjs
node --check scripts/opencode-auth-session.mjs
node --test scripts/glm-cache-smoke.test.mjs
node --check scripts/glm-cache-smoke.mjs
git diff --check
diff secret-pattern scan
```

额外远端 smoke 验证：

```text
远端依赖检查：
  node v24.15.0
  chromium 可用
  Xvfb 可用
  dbus-daemon 可用
  git 与 bun 可用

Sidecar smoke：
  about:blank 上完成 start/status/screenshot/extract/stop
  https://opencode.ai/auth 上完成 start/status/screenshot/stop

远端 clean artifact 上线：
  clean checkout 固定到已推送 main 提交 e76a8063
  远端 web/default 构建完成
  远端 web/classic 构建完成
  Go 二进制已构建到隔离 artifact，并包含 OpenCode sidecar 脚本
  artifact 文件名扫描未发现数据库、env、cookie、workspace、API-key 或 token 文件
  system service 已切换到 clean artifact，同时保留既有运行时数据路径
  重启后服务为 active
  本机 HTTP smoke 返回 200
  artifact sidecar 在空 state directory 下返回 success/stopped
  artifact sidecar 在无效 Chromium 配置下返回结构化 JSON 失败
  官方 OpenCode 授权页无凭证 lifecycle smoke 通过 start/status/screenshot/stop
  stop 后按浏览器进程名检查，未发现该 smoke session 对应的 Chromium/Xvfb 残留进程
  登录状态 URL 脱敏与 partial extract secret merge 的远端定向 Go 测试通过
  channel binding validation 的远端定向 Go 测试通过
  web/default typecheck 与包含 channel selector UI 的 build 完成
  远端 Node sidecar retry 测试通过
  最新 screenshot retry artifact 通过官方 OpenCode 授权页 lifecycle smoke
  最新 credential readiness artifact 已部署到远端服务
  HTTP smoke 返回 200
  空 state 的 sidecar status 返回 successful stopped
  官方 OpenCode 授权页无凭证 lifecycle smoke 通过，且 stop 后无该 smoke session 对应的浏览器残留进程
  远端 Node sidecar 测试与 OpenCode readiness 相关 Go 定向测试通过
  最新 JSON probe extractor artifact 已部署到远端服务
  远端 Node sidecar 测试与 OpenCode extractor 相关 Go 定向测试通过
  官方 OpenCode 授权页无凭证 start/screenshot/extract/stop smoke 通过，且 stop 后无该 smoke session 对应的浏览器残留进程
  最新 sidecar path-resolution artifact 已部署到远端服务
  sidecar path-resolution Go 定向测试已在远端源 checkout 上通过
  服务重启后经过 readiness polling 的 HTTP smoke 返回 200
  已部署 artifact 的空状态 sidecar status 返回 success/stopped
  最新 credential key-source diagnostic artifact 已部署到远端服务
  default 前端 typecheck/build 与 classic 前端 build 已在远端通过
  OpenCode key-source/readiness/extractor/quota/activation Go 测试已在远端源 checkout 上通过
```

`web/classic` 构建失败的根因已经定位为 `date-fns-tz@1.3.8` 将 peer `date-fns` 解析到了 workspace 顶层的 `date-fns@4`。该版本通过 package exports 阻断 `date-fns/_lib/cloneObject/index.js` 等 private subpath。修复方式是保持 `web/default` 使用 `date-fns@4`，只在 classic 的 Rsbuild 配置中增加局部 alias，让 Semi UI 的 `date-fns-tz` 解析到 Semi 自带的 `date-fns@2.30.0`。

已知验证边界：

- channel-affinity 前端目录与 OpenCode 相关前端路径已通过 targeted lint。更广的全量前端 lint 仍应视为独立的历史质量门，不能作为真实 OpenCode 账号或 `glm-5.2` cache-hit 行为的证据。
- 更大的 `src/features/channels/components/dialogs/param-override-editor-dialog.tsx` 文件仍然存在既有 oxlint 风格问题，例如 `curly`、`no-nested-ternary` 和 `no-useless-spread`。本次只依赖该文件中的 Codex preset payload；typecheck、格式检查与 default 前端构建通过，但不声称该文件已经 lint-clean。
- `go test ./common ./model ./service ./controller ./router ./service/relayconvert -count=1` 当前暴露既有 SQLite 测试初始化问题，典型错误是无关测试缺少 `users`、`tasks`、`system_tasks` 表；本次 OpenCode 后端相关测试已通过。
- 最新远端可达性检查显示 Tailscale peer node key 已过期。因此当前变更只能声明为本地验证过的 gate 与已推送源码，不能声明为新的远端 rollout 或真实订阅账号 E2E 结果。
- 真实 OpenCode Google 登录、账号提取、订阅账号 channel 激活，以及多轮 `glm-5.2` cache-hit 统计验证仍需要操作者控制的真实凭证，不能写入仓库。

### 下一步

1. 如 Tailscale peer 仍报告 node key 过期，先恢复远端可达性，然后把当前已推送的 `main` 作为 clean artifact 上线，再执行真实凭据 E2E。
2. 在导入生产账号材料前，先对已部署服务运行非破坏性 preflight gate：

```bash
NEW_API_BASE_URL=https://<deployed-new-api> \
NEW_API_ADMIN_TOKEN=<admin-access-token> \
NEW_API_ADMIN_USER_ID=<admin-user-id> \
node scripts/opencode-e2e-preflight.mjs
```

3. 打开已部署的 Admin Web，确认 `/opencode-accounts` 不显示页面级 fallback-key 告警；如果仍显示，先配置稳定 `CRYPTO_SECRET`，再导入生产账号材料。
4. 使用操作者控制的 OpenCode 订阅账号，在远端浏览器会话中完成官方 OpenCode/Google 授权。
5. 提取账号材料，并确认 UI 只显示 masked indicator。
6. 激活绑定的 New API channel，确认 channel cache refresh，然后用 `--min-active-ready-accounts 1` 重跑 preflight。`--min-activation-ready-accounts 1 --min-active-accounts 1` 只能作为补充诊断；真实 cache smoke gate 应要求同一个账号同时满足两个状态。
7. 用输出脱敏的 smoke runner 通过 New API 多轮调用 `glm-5.2`：

```bash
NEW_API_BASE_URL=https://<deployed-new-api> \
NEW_API_KEY=<relay-api-key> \
NEW_API_ADMIN_TOKEN=<admin-access-token> \
NEW_API_ADMIN_USER_ID=<admin-user-id> \
GLM_CACHE_SMOKE_KEY=<stable-session-key> \
node scripts/glm-cache-smoke.mjs \
  --warmup-requests 2 \
  --requests 6 \
  --delay-ms 1000 \
  --require-stats true \
  --min-request-hit-rate 0.8 \
  --min-stats-hit-rate 0.8 \
  --min-cache-signal-tokens 1
```

8. 结合 runner 摘要、New API channel-affinity usage stats 与上游/OpenCode quota/accounting 比较 warm-cache 行为。默认输入已经是稳定 cache-probe prefix；只有在刻意验证其它 workload 时才传 `--input`。runner 会从失败输出中脱敏已配置 input，包括 JSON-escaped 与 truncated-prefix 回显；但更安全的默认做法仍是使用确定性 probe，除非真实 workload 本身就是待验证变量。本轮 smoke 应把 `warmup` 视为 cache 预热，把 `stats.delta` 作为测量阶段证据，把 `checks.status` 作为机器验收门，把 `stats.data` 只作为 final 累计快照；如果 `reset_detected` 为 true，应等 cache 窗口稳定后重跑。runner 证明请求链路与统计读取链路可重复，不单独证明上游 prompt-cache 计费正确。
9. 如果 CDP 截图交互不足以完成 Google 授权，再加 noVNC 兜底，但不改变账号模型和 activation contract。
