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
| Maximize cache-hit accounting for `glm-5.2` | Relay usage conversion exists, but current fork only maps cache details into `InputTokensDetails` in `UsageFromChatUsage` | Accounting compatibility should preserve both Chat and Responses usage detail fields | Land cache accounting parity tests before connector activation tests |
| Robust secret handling | RootAuth and secure verification patterns exist | No reversible encryption for imported provider secrets | Add AES-GCM secret encryption using stable `CRYPTO_SECRET` |
| No clipboard limit change | Unrelated to this connector | No action required | Preserve existing Deskflow-related choice outside this repository |

### Remote-Validated Work Not Yet Landed in This Fork

The remote service previously validated two cache-related fixes and `glm-5.2` cache hit behavior. They are not represented in this fork's current `main`:

- A replay/cache-key hardening patch around request-body cache key generation. The expected file path from the remote working tree is not present in the fork's current `main`.
- A Responses usage compatibility fix where chat usage cache details are preserved for both chat-compatible accounting and Responses-compatible accounting.

This matters because OpenCode account switching must not regress cache hit reporting. The connector should be implemented only after the cache accounting behavior is landed and covered by tests in this repository.

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
| OpenCode account model | Implemented | Added `opencode_accounts` model, migration registration, validation, encrypted secret storage, and masked public view. |
| Reversible encryption helper | Implemented | Added AES-GCM `EncryptSecret` / `DecryptSecret` using `CRYPTO_SECRET`-derived key and versioned ciphertext. |
| Root-only OpenCode account API | Implemented | Added CRUD, login-session, extract, quota refresh, and activate routes under `/api/opencode/accounts`. Quota refresh now accepts quota-only browser payloads and updates structured `quota_limit` / `quota_used` fields. |
| Remote browser sidecar | Implemented and smoke-tested on the remote host without credentials | Added Node CDP + Xvfb sidecar with start/status/screenshot/click/key/extract/stop actions. Remote smoke tests covered `about:blank` and the official OpenCode authorization entrypoint without logging in. |
| Sensitive browser input transport | Implemented | `login/key` now sends typed text to the Node sidecar through stdin instead of argv, so Google/OpenCode login text does not appear in process command lines. The sidecar rejects legacy `--text` input. |
| Extractor | Implemented | Candidate-based scanner covers OpenCode-domain cookies, local/session storage, and JSON responses; tests cover ranking and empty-state rejection. |
| Frontend account window | Implemented | Added Root-only admin route, sidebar entry, account list, remote screenshot controls, extract, quota refresh, activate, stop, and delete actions. |
| Activation into existing channels | Implemented | Activation decrypts the selected account API key, updates the bound channel inside a transaction, marks the account active, and refreshes channel cache after commit. |
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

The biggest deployment pitfall is `CRYPTO_SECRET`: durable imported credentials require a stable value. If an operator runs with an auto-generated or rotated secret, stored OpenCode account material will fail closed on decrypt and must be re-imported.

### Verification Update

Validated successfully:

```text
go test ./common ./service/relayconvert -count=1
go test ./model -run TestCreateOpenCodeAccount -count=1
go test ./controller -run TestOpenCodeAccountResponseDoesNotExposeSecrets -count=1
go test ./router -run TestOpenCodeAccountRoutesRegisterExpectedPaths -count=1
go test ./service -run 'TestExtractOpenCodeSecretsFromBrowserState|TestActivateOpenCodeAccount' -count=1
go test ./service -run TestObserveChannelAffinityUsageCacheByRelayFormat_MixedMode -count=1
go test ./service -run 'TestExtractOpenCodeSecretsFromBrowserState|TestExtractOpenCodeQuotaFromBrowserState|TestActivateOpenCodeAccount|TestObserveChannelAffinityUsageCacheByRelayFormat_MixedMode' -count=1
go test ./service -run 'TestBuildOpenCodeAuthCommandSpecPassesKeyTextThroughStdin|TestExtractOpenCodeSecretsFromBrowserState|TestExtractOpenCodeQuotaFromBrowserState|TestActivateOpenCodeAccount|TestObserveChannelAffinityUsageCacheByRelayFormat_MixedMode' -count=1
bun run typecheck
bunx oxlint -c .oxlintrc.json src/features/opencode-accounts src/routes/_authenticated/opencode-accounts src/hooks/use-sidebar-data.ts src/hooks/use-sidebar-config.ts
bun run build in web/default
bun run build in web/classic
go build .
node --check scripts/opencode-auth-session.mjs
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
```

The `web/classic` build failure was traced to `date-fns-tz@1.3.8` resolving its peer `date-fns` to the workspace-level `date-fns@4`. That package version blocks private subpath imports such as `date-fns/_lib/cloneObject/index.js`. The fix keeps `web/default` on `date-fns@4` and adds a classic-only Rsbuild alias so Semi UI's `date-fns-tz` resolves to Semi's nested `date-fns@2.30.0`.

Known verification limits:

- Full frontend lint currently fails on pre-existing files outside this change set. The OpenCode-related frontend paths pass targeted lint.
- `go test ./common ./model ./service ./controller ./router ./service/relayconvert -count=1` currently exposes pre-existing SQLite test setup failures such as missing `users`, `tasks`, and `system_tasks` tables in unrelated tests. The OpenCode-specific backend tests pass.
- Real OpenCode Google login, account extraction, channel activation against a live subscription account, and repeated `glm-5.2` cache-hit measurement still require operator-controlled credentials and must not be committed to the repository.

### Immediate Next Steps

1. Deploy the branch to the remote New API host with a stable `CRYPTO_SECRET`.
2. Ensure Chromium, Xvfb, and Node are available to the New API process, or set `CHROMIUM_BIN` explicitly.
3. Import one non-production OpenCode subscription account through `/opencode-accounts`.
4. Activate the bound New API channel and confirm channel cache refresh.
5. Run repeated `glm-5.2` requests through New API, then compare prompt cached-token accounting before and after warm cache.
6. If CDP screenshot interaction proves insufficient for Google authorization, add a noVNC fallback without changing the account model or activation contract.

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
| 最大化 `glm-5.2` cache-hit 统计 | relay usage 转换存在，但当前 fork 的 `UsageFromChatUsage` 只把 cache details 写入 `InputTokensDetails` | 计费兼容层应同时保留 Chat 与 Responses 侧 usage detail | 先合入 cache accounting parity 测试与修复，再做连接器激活测试 |
| 稳健处理 secret | 已有 RootAuth 和安全验证模式 | 没有导入 provider secret 所需的可逆加密 | 基于稳定 `CRYPTO_SECRET` 增加 AES-GCM secret 加密 |
| 不限制 clipboardSharingSize | 与本连接器无关 | 不需要动作 | Deskflow 相关选择保留在本仓库之外 |

### 远端已验证但尚未落入本 fork 的工作

远端服务此前已经验证过两类 cache 相关修复以及 `glm-5.2` cache hit 行为。但这些内容尚未体现在当前 fork 的 `main` 中：

- request-body cache key 生成相关的 replay/cache-key 加固补丁。远端工作树中的预期文件路径在当前 fork `main` 中不存在。
- Responses usage 兼容修复：将 chat usage 中的 cache details 同时保留给 chat-compatible 计费与 Responses-compatible 计费。

这点很关键，因为 OpenCode 账号切换不能让 cache hit 统计倒退。账号连接器应在 cache accounting 行为进入本仓库并有测试覆盖之后再继续实现。

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
| OpenCode account model | 已实现 | 已增加 `opencode_accounts` model、迁移注册、校验、加密 secret 存储与 masked public view。 |
| 可逆加密 helper | 已实现 | 已增加 AES-GCM `EncryptSecret` / `DecryptSecret`，使用 `CRYPTO_SECRET` 派生 key，密文带版本前缀。 |
| Root-only OpenCode account API | 已实现 | `/api/opencode/accounts` 下已包含 CRUD、登录会话、提取、quota refresh 与 activate 路由。quota refresh 现在支持只包含 quota 的浏览器 payload，并会更新结构化 `quota_limit` / `quota_used` 字段。 |
| 远端浏览器 sidecar | 已实现，并已在远端主机完成无凭证 smoke test | 已增加 Node CDP + Xvfb sidecar，支持 start/status/screenshot/click/key/extract/stop。远端 smoke 覆盖 `about:blank` 与官方 OpenCode 授权入口，未登录、未使用任何账号材料。 |
| 敏感浏览器输入传输 | 已实现 | `login/key` 现在通过 stdin 向 Node sidecar 传递键入文本，不再放入 argv，因此 Google/OpenCode 登录页中的输入不会出现在进程命令行中。sidecar 会拒绝旧的 `--text` 输入。 |
| Extractor | 已实现 | 候选扫描覆盖 OpenCode 域 cookie、local/session storage 与 JSON responses；测试覆盖排序和空状态拒绝。 |
| 前端账号窗口 | 已实现 | 已增加 Root-only 管理路由、侧边栏入口、账号列表、远端截图控制、extract、quota refresh、activate、stop、delete 操作。 |
| 激活到现有渠道 | 已实现 | 激活时解密选中账号 API key，在事务内更新绑定 channel，标记账号 active，并在 commit 后刷新 channel cache。 |
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

最大部署坑点是 `CRYPTO_SECRET`：导入的持久凭证要求该值稳定。如果运行时使用自动生成或轮换的 secret，已存 OpenCode 账号材料会解密失败并 fail closed，需要重新导入。

### 验证更新

已成功验证：

```text
go test ./common ./service/relayconvert -count=1
go test ./model -run TestCreateOpenCodeAccount -count=1
go test ./controller -run TestOpenCodeAccountResponseDoesNotExposeSecrets -count=1
go test ./router -run TestOpenCodeAccountRoutesRegisterExpectedPaths -count=1
go test ./service -run 'TestExtractOpenCodeSecretsFromBrowserState|TestActivateOpenCodeAccount' -count=1
go test ./service -run TestObserveChannelAffinityUsageCacheByRelayFormat_MixedMode -count=1
go test ./service -run 'TestExtractOpenCodeSecretsFromBrowserState|TestExtractOpenCodeQuotaFromBrowserState|TestActivateOpenCodeAccount|TestObserveChannelAffinityUsageCacheByRelayFormat_MixedMode' -count=1
go test ./service -run 'TestBuildOpenCodeAuthCommandSpecPassesKeyTextThroughStdin|TestExtractOpenCodeSecretsFromBrowserState|TestExtractOpenCodeQuotaFromBrowserState|TestActivateOpenCodeAccount|TestObserveChannelAffinityUsageCacheByRelayFormat_MixedMode' -count=1
bun run typecheck
bunx oxlint -c .oxlintrc.json src/features/opencode-accounts src/routes/_authenticated/opencode-accounts src/hooks/use-sidebar-data.ts src/hooks/use-sidebar-config.ts
web/default 下 bun run build
web/classic 下 bun run build
go build .
node --check scripts/opencode-auth-session.mjs
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
```

`web/classic` 构建失败的根因已经定位为 `date-fns-tz@1.3.8` 将 peer `date-fns` 解析到了 workspace 顶层的 `date-fns@4`。该版本通过 package exports 阻断 `date-fns/_lib/cloneObject/index.js` 等 private subpath。修复方式是保持 `web/default` 使用 `date-fns@4`，只在 classic 的 Rsbuild 配置中增加局部 alias，让 Semi UI 的 `date-fns-tz` 解析到 Semi 自带的 `date-fns@2.30.0`。

已知验证边界：

- 全量前端 lint 目前失败在本次变更外的既有文件；OpenCode 相关前端路径的定向 lint 已通过。
- `go test ./common ./model ./service ./controller ./router ./service/relayconvert -count=1` 当前暴露既有 SQLite 测试初始化问题，典型错误是无关测试缺少 `users`、`tasks`、`system_tasks` 表；本次 OpenCode 后端相关测试已通过。
- 真实 OpenCode Google 登录、账号提取、订阅账号 channel 激活，以及多轮 `glm-5.2` cache-hit 统计验证仍需要操作者控制的真实凭证，不能写入仓库。

### 下一步

1. 将分支部署到远端 New API 主机，并确认使用稳定 `CRYPTO_SECRET`。
2. 确认 New API 进程可访问 Chromium、Xvfb、Node；必要时显式设置 `CHROMIUM_BIN`。
3. 通过 `/opencode-accounts` 导入一个非生产 OpenCode 订阅账号。
4. 激活绑定的 New API channel，并确认 channel cache refresh。
5. 通过 New API 多轮调用 `glm-5.2`，比较 warm cache 前后的 prompt cached-token accounting。
6. 如果 CDP 截图交互不足以完成 Google 授权，再加 noVNC 兜底，但不改变账号模型和 activation contract。
