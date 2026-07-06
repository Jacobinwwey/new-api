export type ApiResponse<T> = {
  success: boolean
  message?: string
  data: T
}

export type OpenCodeAccount = {
  id: number
  label: string
  channel_id: number
  quota_raw: string
  quota_limit: number
  quota_used: number
  login_status: string
  active: boolean
  last_extracted_at: number
  last_quota_checked_at: number
  created_at: string
  updated_at: string
  has_email: boolean
  has_workspace_id: boolean
  has_api_key: boolean
  has_cookie: boolean
  email_masked: string
  credential_integrity: 'ok' | 'decrypt_failed'
  credential_key_source: 'crypto_secret' | 'session_secret_fallback'
  activation_ready: boolean
  missing_activation_fields: string[]
}

export type OpenCodeAccountDiagnostics = {
  credential_key_source: 'crypto_secret' | 'session_secret_fallback'
  uses_fallback_credential_key: boolean
}

export type OpenCodeAccountRequest = {
  label: string
  channel_id: number
}

export type OpenCodeLoginStatus = {
  account_id: number
  running: boolean
  status: string
  url?: string
  started_at?: number
  message?: string
}

export type OpenCodeScreenshot = {
  image_base64: string
}

export type OpenCodeClickRequest = {
  x: number
  y: number
}

export type OpenCodeKeyRequest = {
  text: string
}
