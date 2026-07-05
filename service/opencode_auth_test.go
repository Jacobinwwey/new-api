package service

import (
	"testing"

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
