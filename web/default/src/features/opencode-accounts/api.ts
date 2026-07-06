import { api } from '@/lib/api'

import type {
  ApiResponse,
  OpenCodeAccount,
  OpenCodeAccountDiagnostics,
  OpenCodeAccountRequest,
  OpenCodeClickRequest,
  OpenCodeKeyRequest,
  OpenCodeLoginStatus,
  OpenCodeScreenshot,
} from './types'

export async function listOpenCodeAccounts() {
  const res =
    await api.get<ApiResponse<OpenCodeAccount[]>>('/api/opencode/accounts')
  return res.data
}

export async function getOpenCodeAccountDiagnostics() {
  const res = await api.get<ApiResponse<OpenCodeAccountDiagnostics>>(
    '/api/opencode/accounts/diagnostics'
  )
  return res.data
}

export async function createOpenCodeAccount(request: OpenCodeAccountRequest) {
  const res = await api.post<ApiResponse<OpenCodeAccount>>(
    '/api/opencode/accounts',
    request
  )
  return res.data
}

export async function deleteOpenCodeAccount(id: number) {
  const res = await api.delete<ApiResponse<null>>(
    `/api/opencode/accounts/${id}`
  )
  return res.data
}

export async function startOpenCodeLogin(id: number) {
  const res = await api.post<ApiResponse<OpenCodeLoginStatus>>(
    `/api/opencode/accounts/${id}/login/start`
  )
  return res.data
}

export async function getOpenCodeLoginStatus(id: number) {
  const res = await api.get<ApiResponse<OpenCodeLoginStatus>>(
    `/api/opencode/accounts/${id}/login/status`,
    { disableDuplicate: true }
  )
  return res.data
}

export async function getOpenCodeLoginScreenshot(id: number) {
  const res = await api.get<ApiResponse<OpenCodeScreenshot>>(
    `/api/opencode/accounts/${id}/login/screenshot`,
    { disableDuplicate: true }
  )
  return res.data
}

export async function clickOpenCodeLogin(
  id: number,
  request: OpenCodeClickRequest
) {
  const res = await api.post<ApiResponse<OpenCodeLoginStatus>>(
    `/api/opencode/accounts/${id}/login/click`,
    request
  )
  return res.data
}

export async function keyOpenCodeLogin(
  id: number,
  request: OpenCodeKeyRequest
) {
  const res = await api.post<ApiResponse<OpenCodeLoginStatus>>(
    `/api/opencode/accounts/${id}/login/key`,
    request
  )
  return res.data
}

export async function extractOpenCodeLogin(id: number) {
  const res = await api.post<ApiResponse<OpenCodeAccount>>(
    `/api/opencode/accounts/${id}/login/extract`
  )
  return res.data
}

export async function stopOpenCodeLogin(id: number) {
  const res = await api.post<ApiResponse<OpenCodeLoginStatus>>(
    `/api/opencode/accounts/${id}/login/stop`
  )
  return res.data
}

export async function refreshOpenCodeQuota(id: number) {
  const res = await api.post<ApiResponse<OpenCodeAccount>>(
    `/api/opencode/accounts/${id}/quota/refresh`
  )
  return res.data
}

export async function activateOpenCodeAccount(id: number) {
  const res = await api.post<ApiResponse<OpenCodeAccount>>(
    `/api/opencode/accounts/${id}/activate`
  )
  return res.data
}
