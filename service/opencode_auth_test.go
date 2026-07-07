package service

import (
	"encoding/base64"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestExtractOpenCodeSecretsFromBrowserStateRanksStorageAndJsonCandidates(t *testing.T) {
	state := OpenCodeBrowserState{
		Cookies: []OpenCodeBrowserCookie{
			{Name: "oc_session", Value: "fixture-session-test", Domain: "auth.opencode.ai"},
		},
		LocalStorage: map[string]string{
			"account": `{"email":"operator@example.test","workspace_id":"workspace-storage-test"}`,
			"apiKey":  "opencode-api-key-storage-test",
		},
		SessionStorage: map[string]string{
			"quota": `{"quota":{"limit":1000000,"used":42}}`,
		},
		JSONResponses: []string{
			`{"data":{"workspaceId":"workspace-json-test","api_key":"opencode-api-key-json-test"}}`,
		},
	}

	extracted, err := ExtractOpenCodeSecretsFromBrowserState(state)
	require.NoError(t, err)

	assert.Equal(t, "operator@example.test", extracted.Secrets.Email)
	assert.Equal(t, "workspace-storage-test", extracted.Secrets.WorkspaceID)
	assert.Equal(t, "opencode-api-key-storage-test", extracted.Secrets.APIKey)
	assert.Contains(t, extracted.Secrets.Cookie, "oc_session=fixture-session-test")
	assert.Contains(t, extracted.QuotaRaw, "limit")
	assert.EqualValues(t, 1000000, extracted.QuotaLimit)
	assert.EqualValues(t, 42, extracted.QuotaUsed)
	assert.GreaterOrEqual(t, extracted.Confidence, 4)
}

func TestExtractOpenCodeSecretsFromBrowserStateRejectsEmptyCandidates(t *testing.T) {
	extracted, err := ExtractOpenCodeSecretsFromBrowserState(OpenCodeBrowserState{})
	require.Error(t, err)
	assert.Empty(t, extracted.Secrets.APIKey)
}

func TestExtractOpenCodeSecretsFromBrowserStateDoesNotTreatOAuthTokensAsAPIKeys(t *testing.T) {
	state := OpenCodeBrowserState{
		JSONResponses: []string{
			`{"workspace_id":"workspace-oauth-token-test","access_token":"oauth-access-token-test","id_token":"oauth-id-token-test","refresh_token":"oauth-refresh-token-test"}`,
		},
	}

	extracted, err := ExtractOpenCodeSecretsFromBrowserState(state)
	require.NoError(t, err)

	assert.Equal(t, "workspace-oauth-token-test", extracted.Secrets.WorkspaceID)
	assert.Empty(t, extracted.Secrets.APIKey)
}

func TestExtractOpenCodeSecretsFromBrowserStateAcceptsCodexOAuthObject(t *testing.T) {
	state := OpenCodeBrowserState{
		JSONResponses: []string{
			`{"data":{"credential":{"type":"codex","access_token":"codex-access-token-test","refresh_token":"codex-refresh-token-test","account_id":"codex-account-test","email":"operator@example.test"}}}`,
		},
	}

	extracted, err := ExtractOpenCodeSecretsFromBrowserState(state)
	require.NoError(t, err)

	var key CodexOAuthKey
	require.NoError(t, common.Unmarshal([]byte(extracted.Secrets.APIKey), &key))
	assert.Equal(t, "codex-access-token-test", key.AccessToken)
	assert.Equal(t, "codex-refresh-token-test", key.RefreshToken)
	assert.Equal(t, "codex-account-test", key.AccountID)
	assert.Equal(t, "operator@example.test", key.Email)
	assert.Equal(t, "codex", key.Type)
	assert.Equal(t, "operator@example.test", extracted.Secrets.Email)
	assert.GreaterOrEqual(t, extracted.Confidence, 2)
}

func TestExtractOpenCodeSecretsFromBrowserStateDerivesCodexAccountFromJWT(t *testing.T) {
	accessToken := buildOpenCodeAuthTestJWT(t, map[string]any{
		"email": "operator@example.test",
		"https://api.openai.com/auth": map[string]any{
			"chatgpt_account_id": "jwt-account-test",
		},
	})
	state := OpenCodeBrowserState{
		JSONResponses: []string{
			`{"oauth":{"access_token":"` + accessToken + `","refresh_token":"jwt-refresh-token-test"}}`,
		},
	}

	extracted, err := ExtractOpenCodeSecretsFromBrowserState(state)
	require.NoError(t, err)

	var key CodexOAuthKey
	require.NoError(t, common.Unmarshal([]byte(extracted.Secrets.APIKey), &key))
	assert.Equal(t, accessToken, key.AccessToken)
	assert.Equal(t, "jwt-refresh-token-test", key.RefreshToken)
	assert.Equal(t, "jwt-account-test", key.AccountID)
	assert.Equal(t, "operator@example.test", key.Email)
	assert.Equal(t, "operator@example.test", extracted.Secrets.Email)
}

func TestExtractOpenCodeQuotaFromBrowserStateAcceptsQuotaOnlyPayload(t *testing.T) {
	state := OpenCodeBrowserState{
		JSONResponses: []string{
			`{"quota":{"limit":250000,"used":1250}}`,
		},
	}

	quota, err := ExtractOpenCodeQuotaFromBrowserState(state)
	require.NoError(t, err)

	assert.Contains(t, quota.Raw, "250000")
	assert.EqualValues(t, 250000, quota.Limit)
	assert.EqualValues(t, 1250, quota.Used)
}

func buildOpenCodeAuthTestJWT(t *testing.T, claims map[string]any) string {
	t.Helper()

	header, err := common.Marshal(map[string]any{"alg": "none", "typ": "JWT"})
	require.NoError(t, err)
	payload, err := common.Marshal(claims)
	require.NoError(t, err)

	return base64.RawURLEncoding.EncodeToString(header) + "." +
		base64.RawURLEncoding.EncodeToString(payload) + ".signature"
}
