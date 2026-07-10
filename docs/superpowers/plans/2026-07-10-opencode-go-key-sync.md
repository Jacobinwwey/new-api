# OpenCode Go Key Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## 中文

**目标：** 自动从已登录的隔离 OpenCode 浏览器复制已有 API key，保存 workspace/cookie/key，拉取 Go 配额并激活绑定通道。

**架构：** Node sidecar 负责受限页面导航、语义化复制控件定位和剪贴板读取；Go 服务负责凭证合并、Go dashboard 配额读取和现有激活事务。前端在浏览器已到达 Key 页面后触发一次幂等同步，显示分类失败而不暴露凭证。

**技术栈：** Node.js CDP、Go/Gin/GORM、React/TanStack Query、现有 New API 加密模型。

**当前进度：** Task 1 至 Task 3 已完成并通过相应 Node、Go 和前端状态机测试。受控同步现在包含公开无敏感页面类别、复制前清空远端剪贴板、服务层复制串行化、root-only `/sync`、加密凭证落库、quota 刷新和激活。Task 4 的本地回归已完成；剩余远端脱敏验收、部署和提交。

---

### Task 1: Sidecar 受限同步与敏感状态边界

**文件：**
- 修改：`scripts/opencode-auth-session.mjs`
- 测试：`scripts/opencode-auth-session.test.mjs`

- [ ] **Step 1: 编写失败测试**

覆盖以下行为：从工作区 URL 提取 workspace id；只接受可见且语义为 API key 的复制按钮；拒绝掩码/短剪贴板值；状态 URL 删除 workspace 标识；`sync` 输出仅在内部 browser state 包含候选 key。

- [ ] **Step 2: 运行 Node 测试并确认失败**

运行：`rtk node --test scripts/opencode-auth-session.test.mjs`

预期：新增的 workspace、copy-control、clipboard 和 URL-redaction 测试失败。

- [ ] **Step 3: 最小实现**

增加 `syncSession`：使用 `Page.navigate` 进入同源工作区 `/keys` 页面，使用 DOM label/aria/title 与邻近 key 字段定位复制按钮，发送真实鼠标事件，仅读取该次操作后的剪贴板。将 `workspace_id` 和 `api_key` 放入 `browser_state`；对公开 status URL 仅返回页面类别或已脱敏 URL。

- [ ] **Step 4: 运行 Node 测试并确认通过**

运行：`rtk node --test scripts/opencode-auth-session.test.mjs`

预期：所有 sidecar 测试通过。

### Task 2: Go 浏览器状态、Go 配额和同步编排

**文件：**
- 修改：`service/opencode_auth.go`
- 修改：`service/opencode_browser_session.go`
- 新建：`service/opencode_go_quota.go`
- 修改：`service/opencode_activation.go`
- 测试：`service/opencode_auth_test.go`
- 测试：`service/opencode_browser_session_test.go`
- 新建：`service/opencode_go_quota_test.go`

- [ ] **Step 1: 编写失败测试**

测试 browser state 的 workspace/API key 只参与内部提取；测试 workspace id 与 cookie 请求固定 dashboard URL；测试 SolidJS 与 data-slot 两种 quota 格式；测试 API key 缺失、cookie 缺失、workspace 缺失、HTTP 非成功和无 usage window 的分类错误。

- [ ] **Step 2: 运行 Go 测试并确认失败**

运行：`rtk go test ./service -run 'Test(ExtractOpenCode|OpenCodeGoQuota|SanitizeOpenCode)' -count=1`

预期：新增的同步和配额测试失败。

- [ ] **Step 3: 最小实现**

扩展 `OpenCodeBrowserState` 内部字段和 `ExtractOpenCodeBrowserState` 的 `sync` action。实现 `FetchOpenCodeGoQuota`，固定请求 OpenCode Go dashboard，使用 account cookie，解析 rolling/weekly/monthly usage，序列化无敏感快照。提供单个 `SyncOpenCodeAccount` 服务操作：提取、加密保存、刷新配额、调用现有 `ActivateOpenCodeAccount`。

- [ ] **Step 4: 运行 Go 测试并确认通过**

运行：`rtk go test ./service ./controller ./router -count=1`

预期：OpenCode 服务、控制器与路由测试全部通过。

### Task 3: API 路由、控制器与前端自动触发

**文件：**
- 修改：`router/opencode-account-router.go`
- 修改：`controller/opencode_account.go`
- 修改：`controller/opencode_account_test.go`
- 修改：`web/default/src/features/opencode-accounts/api.ts`
- 修改：`web/default/src/features/opencode-accounts/types.ts`
- 修改：`web/default/src/features/opencode-accounts/lib.ts`
- 修改：`web/default/src/features/opencode-accounts/lib.test.ts`
- 修改：`web/default/src/features/opencode-accounts/index.tsx`
- 修改：`web/default/src/features/opencode-accounts/remote-browser-window.tsx`

- [ ] **Step 1: 编写失败测试**

增加 `/sync` 路由测试；测试 API client 使用同步端点；测试前端只对 Key 页面会话自动同步一次，并且同步失败不会循环请求或错误启用 Activate。

- [ ] **Step 2: 运行前端与路由测试并确认失败**

运行：`rtk pnpm test -- --run web/default/src/features/opencode-accounts/lib.test.ts`

运行：`rtk go test ./router ./controller -count=1`

预期：新增 sync route 和自动同步测试失败。

- [ ] **Step 3: 最小实现**

增加 root-only `POST /api/opencode/accounts/:id/sync`。控制器仅返回 `OpenCodeAccountPublic`，不返回 secret。React 使用一次性会话键在 status 表示 Key 页面后调用 sync，刷新 account query；保留手动 Sync 按钮作为网络/浏览器失败后的显式重试，不提供 API key 文本输入或展示。

- [ ] **Step 4: 运行测试并确认通过**

运行：`rtk pnpm test -- --run web/default/src/features/opencode-accounts/lib.test.ts`

运行：`rtk go test ./controller ./router -count=1`

预期：新增和既有测试全部通过。

### Task 4: 回归、部署和运行时验收

**文件：**
- 修改：`scripts/new-api-clean-rollout.mjs`（仅当现有部署验证无法覆盖新 route 时）
- 测试：`scripts/new-api-clean-rollout.test.mjs`（仅当脚本修改时）

- [ ] **Step 1: 执行静态与回归检查**

运行：`rtk git diff --check`

运行：`rtk go test ./service ./controller ./router -count=1`

运行：`rtk node --test scripts/opencode-auth-session.test.mjs`

运行：`rtk pnpm test -- --run web/default/src/features/opencode-accounts/lib.test.ts`

- [ ] **Step 2: 部署并进行脱敏实机验证**

通过 LearnSSH alias 部署。验证服务版本、`/opencode-browser` 页面和 `/sync` 路由；在已登录账户上执行同步，确认 `has_api_key=true`、`has_workspace_id=true`、配额检查时间更新、`activation_ready=true`、`active=true`。只报告布尔状态、窗口数量和时间戳。

- [ ] **Step 3: 提交**

仅暂存本计划列出的文件及双语文档；在确认没有密钥、cookie、workspace id、OAuth token 或远端本地文件后提交并推送。

## English

**Goal:** Automatically copy an existing API key from the logged-in isolated OpenCode browser, persist workspace/cookie/key, fetch Go quota, and activate the bound channel.

**Architecture:** The Node sidecar owns constrained page navigation, semantic copy-control discovery, and clipboard reads. Go owns encrypted credential merging, Go dashboard quota retrieval, and the existing activation transaction. The frontend performs one idempotent sync once the browser reaches the Key page and shows classified failures without exposing credentials.

**Tech Stack:** Node.js CDP, Go/Gin/GORM, React/TanStack Query, and the existing New API encryption model.

**Current status:** Tasks 1 through 3 are implemented and covered by their Node, Go, and frontend state-machine tests. The controlled sync now includes a public non-sensitive page kind, remote clipboard clearing before copy, service-level copy serialization, a root-only `/sync`, encrypted credential persistence, quota refresh, and activation. The local portion of Task 4 is complete; remote redacted acceptance, deployment, and commit remain.

---

### Task 1: Constrained Sidecar Sync and Sensitive-State Boundary

**Files:**
- Modify: `scripts/opencode-auth-session.mjs`
- Test: `scripts/opencode-auth-session.test.mjs`

- [ ] Write failing tests for workspace extraction, semantic copy-control selection, masked/short clipboard rejection, workspace redaction in public URLs, and internal-only API-key browser state output.
- [ ] Run `rtk node --test scripts/opencode-auth-session.test.mjs` and confirm the new tests fail.
- [ ] Implement `syncSession`: navigate to the same-origin workspace `/keys` page, locate a copy control associated with an API-key field, perform a real click, and read only the clipboard value generated by that action. Return workspace id and API key only inside browser state; expose a redacted status URL or page kind publicly.
- [ ] Re-run `rtk node --test scripts/opencode-auth-session.test.mjs` and confirm all sidecar tests pass.

### Task 2: Go Browser State, Go Quota, and Sync Orchestration

**Files:**
- Modify: `service/opencode_auth.go`
- Modify: `service/opencode_browser_session.go`
- Create: `service/opencode_go_quota.go`
- Modify: `service/opencode_activation.go`
- Test: `service/opencode_auth_test.go`
- Test: `service/opencode_browser_session_test.go`
- Create: `service/opencode_go_quota_test.go`

- [ ] Write failing tests for internal workspace/key extraction, fixed dashboard requests using the account cookie, SolidJS and data-slot quota formats, and classified missing credential/HTTP/unparseable responses.
- [ ] Run `rtk go test ./service -run 'Test(ExtractOpenCode|OpenCodeGoQuota|SanitizeOpenCode)' -count=1` and confirm failure.
- [ ] Implement internal browser-state fields, `sync` action support, `FetchOpenCodeGoQuota`, and one `SyncOpenCodeAccount` service operation that extracts, encrypts, refreshes quota, and calls `ActivateOpenCodeAccount`.
- [ ] Run `rtk go test ./service ./controller ./router -count=1` and confirm success.

### Task 3: API Route, Controller, and Frontend Auto Trigger

**Files:**
- Modify: `router/opencode-account-router.go`
- Modify: `controller/opencode_account.go`
- Modify: `controller/opencode_account_test.go`
- Modify: `web/default/src/features/opencode-accounts/api.ts`
- Modify: `web/default/src/features/opencode-accounts/types.ts`
- Modify: `web/default/src/features/opencode-accounts/lib.ts`
- Modify: `web/default/src/features/opencode-accounts/lib.test.ts`
- Modify: `web/default/src/features/opencode-accounts/index.tsx`
- Modify: `web/default/src/features/opencode-accounts/remote-browser-window.tsx`

- [ ] Write failing tests for the root-only `/sync` route, the API client, and a frontend auto-sync that runs once per Key-page session without retries or false activation.
- [ ] Run route and frontend tests; confirm the new assertions fail.
- [ ] Add `POST /api/opencode/accounts/:id/sync`, returning only the public account shape. Trigger sync once when browser status identifies the Key page, refresh account queries, and retain a Sync button as an explicit retry without rendering or accepting API-key text.
- [ ] Re-run the targeted tests and confirm success.

### Task 4: Regression, Deployment, and Runtime Acceptance

**Files:**
- Modify: `scripts/new-api-clean-rollout.mjs` only if the existing deploy verifier cannot cover the new route.
- Test: `scripts/new-api-clean-rollout.test.mjs` only if the script changes.

- [ ] Run `rtk git diff --check`, service/controller/router tests, sidecar tests, and the targeted frontend test.
- [ ] Deploy through the LearnSSH alias and perform a redacted runtime sync verification: version, browser page, sync route, API-key/workspace presence, quota timestamp, activation readiness, and active state.
- [ ] Stage only the files listed above and the bilingual documents; verify no API keys, cookies, workspace ids, OAuth tokens, or remote local files are committed before push.
