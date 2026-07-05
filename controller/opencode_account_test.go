package controller

import (
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestOpenCodeAccountResponseDoesNotExposeSecrets(t *testing.T) {
	originalSecret := common.CryptoSecret
	common.CryptoSecret = "opencode-controller-test-secret"
	t.Cleanup(func() {
		common.CryptoSecret = originalSecret
	})

	account := &model.OpenCodeAccount{
		Id:        11,
		Label:     "primary",
		ChannelID: 3,
	}
	require.NoError(t, account.EncryptSecrets(model.OpenCodeAccountSecrets{
		Email:       "operator@example.test",
		WorkspaceID: "workspace-controller-test",
		APIKey:      "opencode-api-key-controller-test",
		Cookie:      "opencode-cookie-controller-test",
	}))

	response := toOpenCodeAccountResponse(account)
	payload, err := common.Marshal(response)
	require.NoError(t, err)
	body := string(payload)

	assert.Equal(t, 11, response.Id)
	assert.Equal(t, "primary", response.Label)
	assert.True(t, response.HasAPIKey)
	assert.True(t, response.HasCookie)
	assert.True(t, response.HasWorkspaceID)
	assert.NotContains(t, body, "opencode-api-key-controller-test")
	assert.NotContains(t, body, "opencode-cookie-controller-test")
	assert.NotContains(t, body, "workspace-controller-test")
	assert.NotContains(t, body, "operator@example.test")
	assert.NotContains(t, body, "Ciphertext")
}

func TestMergeExtractedOpenCodeSecretsPreservesExistingFields(t *testing.T) {
	merged := mergeExtractedOpenCodeSecrets(
		model.OpenCodeAccountSecrets{
			Email:       "operator@example.test",
			WorkspaceID: "workspace-existing-test",
			APIKey:      "opencode-api-key-existing-test",
			Cookie:      "cookie-existing-test",
		},
		model.OpenCodeAccountSecrets{
			Cookie: "cookie-extracted-test",
		},
	)

	assert.Equal(t, "operator@example.test", merged.Email)
	assert.Equal(t, "workspace-existing-test", merged.WorkspaceID)
	assert.Equal(t, "opencode-api-key-existing-test", merged.APIKey)
	assert.Equal(t, "cookie-extracted-test", merged.Cookie)
}
