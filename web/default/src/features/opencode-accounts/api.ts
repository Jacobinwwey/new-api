import { api } from '@/lib/api'

import { requireSuccessfulOpenCodeResponse } from './lib'
import type {
  ApiResponse,
  OpenCodeAccount,
  OpenCodeAccountDiagnostics,
  OpenCodeAccountRequest,
  OpenCodeClickRequest,
  OpenCodeKeyRequest,
  OpenCodeLoginStatus,
  OpenCodePressRequest,
  OpenCodeScreenshot,
} from './types'

export async function listOpenCodeAccounts() {
  const res = await api.get<ApiResponse<OpenCodeAccount[]>>(
    '/api/opencode/accounts'
  )
  return requireSuccessfulOpenCodeResponse(
    res.data,
    'Failed to list OpenCode accounts'
  )
}

export async function getOpenCodeAccountDiagnostics() {
  const res = await api.get<ApiResponse<OpenCodeAccountDiagnostics>>(
    '/api/opencode/accounts/diagnostics'
  )
  return requireSuccessfulOpenCodeResponse(
    res.data,
    'Failed to load OpenCode account diagnostics'
  )
}

export async function createOpenCodeAccount(request: OpenCodeAccountRequest) {
  const res = await api.post<ApiResponse<OpenCodeAccount>>(
    '/api/opencode/accounts',
    request
  )
  return requireSuccessfulOpenCodeResponse(
    res.data,
    'Failed to create OpenCode account'
  )
}

export async function deleteOpenCodeAccount(id: number) {
  const res = await api.delete<ApiResponse<null>>(
    `/api/opencode/accounts/${id}`
  )
  return requireSuccessfulOpenCodeResponse(
    res.data,
    'Failed to delete OpenCode account'
  )
}

export async function startOpenCodeLogin(id: number) {
  const res = await api.post<ApiResponse<OpenCodeLoginStatus>>(
    `/api/opencode/accounts/${id}/login/start`
  )
  return requireSuccessfulOpenCodeResponse(
    res.data,
    'Failed to start OpenCode login session'
  )
}

export async function getOpenCodeLoginStatus(id: number) {
  const res = await api.get<ApiResponse<OpenCodeLoginStatus>>(
    `/api/opencode/accounts/${id}/login/status`,
    { disableDuplicate: true }
  )
  return requireSuccessfulOpenCodeResponse(
    res.data,
    'Failed to load OpenCode login status'
  )
}

export async function getOpenCodeLoginScreenshot(id: number) {
  const res = await api.get<ApiResponse<OpenCodeScreenshot>>(
    `/api/opencode/accounts/${id}/login/screenshot`,
    { disableDuplicate: true }
  )
  return requireSuccessfulOpenCodeResponse(
    res.data,
    'Failed to capture OpenCode login screenshot'
  )
}

export async function clickOpenCodeLogin(
  id: number,
  request: OpenCodeClickRequest
) {
  const res = await api.post<ApiResponse<OpenCodeLoginStatus>>(
    `/api/opencode/accounts/${id}/login/click`,
    request
  )
  return requireSuccessfulOpenCodeResponse(
    res.data,
    'Failed to click OpenCode login session'
  )
}

export async function keyOpenCodeLogin(
  id: number,
  request: OpenCodeKeyRequest
) {
  const res = await api.post<ApiResponse<OpenCodeLoginStatus>>(
    `/api/opencode/accounts/${id}/login/key`,
    request
  )
  return requireSuccessfulOpenCodeResponse(
    res.data,
    'Failed to type into OpenCode login session'
  )
}

export async function pressOpenCodeLogin(
  id: number,
  request: OpenCodePressRequest
) {
  const res = await api.post<ApiResponse<OpenCodeLoginStatus>>(
    `/api/opencode/accounts/${id}/login/press`,
    request
  )
  return requireSuccessfulOpenCodeResponse(
    res.data,
    'Failed to press key in OpenCode login session'
  )
}

export async function extractOpenCodeLogin(id: number) {
  const res = await api.post<ApiResponse<OpenCodeAccount>>(
    `/api/opencode/accounts/${id}/login/extract`
  )
  return requireSuccessfulOpenCodeResponse(
    res.data,
    'Failed to extract OpenCode account material'
  )
}

export async function stopOpenCodeLogin(id: number) {
  const res = await api.post<ApiResponse<OpenCodeLoginStatus>>(
    `/api/opencode/accounts/${id}/login/stop`
  )
  return requireSuccessfulOpenCodeResponse(
    res.data,
    'Failed to stop OpenCode login session'
  )
}

export async function refreshOpenCodeQuota(id: number) {
  const res = await api.post<ApiResponse<OpenCodeAccount>>(
    `/api/opencode/accounts/${id}/quota/refresh`
  )
  return requireSuccessfulOpenCodeResponse(
    res.data,
    'Failed to refresh OpenCode quota'
  )
}

export async function activateOpenCodeAccount(id: number) {
  const res = await api.post<ApiResponse<OpenCodeAccount>>(
    `/api/opencode/accounts/${id}/activate`
  )
  return requireSuccessfulOpenCodeResponse(
    res.data,
    'Failed to activate OpenCode account'
  )
}
