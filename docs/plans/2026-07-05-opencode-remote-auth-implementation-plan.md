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
| Cache accounting parity in fork | Not started | Remote-validated behavior still needs to be landed here. |
| OpenCode account model | Not started | Requires encrypted secret fields. |
| Reversible encryption helper | Not started | Must use stable `CRYPTO_SECRET`. |
| Remote browser sidecar | Not started | Recommended CDP + Xvfb first. |
| Frontend account window | Not started | Should be Root-only and admin-focused. |
| Activation into existing channels | Not started | Must update channel and refresh runtime cache safely. |

### Immediate Next Steps

1. Land cache accounting parity tests and fixes first.
2. Add reversible secret encryption with tests.
3. Add `opencode_accounts` model and migration.
4. Add Root-only account CRUD and masked responses.
5. Add CDP sidecar/session service.
6. Add extractor and fixture tests.
7. Add frontend account window.
8. Add activation path into existing channel management.
9. Run real `glm-5.2` cache-hit validation only after the connector is wired end to end.

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
| fork 内 cache accounting parity | 未开始 | 远端已验证行为仍需合入本仓库。 |
| OpenCode account model | 未开始 | 需要加密 secret 字段。 |
| 可逆加密 helper | 未开始 | 必须使用稳定 `CRYPTO_SECRET`。 |
| 远端浏览器 sidecar | 未开始 | 建议先用 CDP + Xvfb。 |
| 前端账号窗口 | 未开始 | 应为 Root-only 管理界面。 |
| 激活到现有渠道 | 未开始 | 必须安全更新 channel 并刷新 runtime cache。 |

### 下一步

1. 先合入 cache accounting parity 测试与修复。
2. 增加可逆 secret 加密与测试。
3. 增加 `opencode_accounts` model 与迁移。
4. 增加 Root-only 账号 CRUD 和 masked response。
5. 增加 CDP sidecar/session service。
6. 增加 extractor 与 fixture 测试。
7. 增加前端账号窗口。
8. 增加激活到现有 channel management 的路径。
9. 只有在连接器端到端打通后，再做真实 `glm-5.2` cache-hit 验证。
