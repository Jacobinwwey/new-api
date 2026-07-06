package controller

import (
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
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
	assert.Equal(t, "ok", response.CredentialIntegrity)
	assert.True(t, response.ActivationReady)
	assert.Empty(t, response.MissingActivationFields)
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

func TestApplyExtractedOpenCodeAccountPreservesQuotaWhenExtractHasNoQuota(t *testing.T) {
	account := &model.OpenCodeAccount{
		QuotaRaw:   "old quota raw",
		QuotaLimit: 1000,
		QuotaUsed:  250,
	}

	applyExtractedOpenCodeAccount(account, service.OpenCodeExtractedAccount{
		Secrets: model.OpenCodeAccountSecrets{
			Cookie: "cookie-only-partial-extract",
		},
	})

	assert.Equal(t, "old quota raw", account.QuotaRaw)
	assert.EqualValues(t, 1000, account.QuotaLimit)
	assert.EqualValues(t, 250, account.QuotaUsed)
	assert.Greater(t, account.LastExtractedAt, int64(0))
}

func TestApplyExtractedOpenCodeAccountUpdatesCompleteQuotaWhenQuotaIsPresent(t *testing.T) {
	account := &model.OpenCodeAccount{
		QuotaRaw:   "old quota raw",
		QuotaLimit: 1000,
		QuotaUsed:  250,
	}

	applyExtractedOpenCodeAccount(account, service.OpenCodeExtractedAccount{
		QuotaRaw:   "new quota raw",
		QuotaLimit: 2000,
		QuotaUsed:  0,
	})

	assert.Equal(t, "new quota raw", account.QuotaRaw)
	assert.EqualValues(t, 2000, account.QuotaLimit)
	assert.EqualValues(t, 0, account.QuotaUsed)
	assert.Greater(t, account.LastExtractedAt, int64(0))
}

func TestOpenCodeAccountResponseMarksCodexPlainAPIKeyNotReady(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	originalDB := model.DB
	model.DB = db
	t.Cleanup(func() {
		model.DB = originalDB
	})
	require.NoError(t, db.AutoMigrate(&model.Channel{}))

	originalSecret := common.CryptoSecret
	common.CryptoSecret = "opencode-controller-codex-readiness-test-secret"
	t.Cleanup(func() {
		common.CryptoSecret = originalSecret
	})

	require.NoError(t, db.Create(&model.Channel{
		Id:     21,
		Name:   "Codex Readiness",
		Type:   constant.ChannelTypeCodex,
		Key:    `{"access_token":"old-token","account_id":"old-account"}`,
		Status: common.ChannelStatusEnabled,
	}).Error)

	account := &model.OpenCodeAccount{
		Id:        22,
		Label:     "codex-plain",
		ChannelID: 21,
	}
	require.NoError(t, account.EncryptSecrets(model.OpenCodeAccountSecrets{
		APIKey: "plain-opencode-api-key",
	}))

	response := toOpenCodeAccountResponse(account)

	assert.False(t, response.ActivationReady)
	assert.Contains(t, response.MissingActivationFields, "codex_oauth_key")
}

func TestOpenCodeAccountDiagnosticsReportsCredentialKeySource(t *testing.T) {
	t.Setenv("CRYPTO_SECRET", "configured-crypto-secret")

	configured := toOpenCodeAccountDiagnosticsResponse()
	assert.Equal(t, common.SecretEncryptionKeySourceCryptoSecret, configured.CredentialKeySource)
	assert.False(t, configured.UsesFallbackCredentialKey)

	t.Setenv("CRYPTO_SECRET", "")

	fallback := toOpenCodeAccountDiagnosticsResponse()
	assert.Equal(t, common.SecretEncryptionKeySourceSessionSecretFallback, fallback.CredentialKeySource)
	assert.True(t, fallback.UsesFallbackCredentialKey)
}
