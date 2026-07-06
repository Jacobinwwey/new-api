package model

import (
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func TestCreateOpenCodeAccountEncryptsSecretsAndMasksPublicView(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	DB = db
	require.NoError(t, db.AutoMigrate(&OpenCodeAccount{}, &Channel{}))
	require.NoError(t, db.Create(&Channel{
		Id:     7,
		Name:   "OpenCode Test Channel",
		Type:   1,
		Key:    "test-key",
		Status: common.ChannelStatusEnabled,
	}).Error)

	originalSecret := common.CryptoSecret
	common.CryptoSecret = "opencode-account-test-secret"
	t.Cleanup(func() {
		common.CryptoSecret = originalSecret
	})

	account := &OpenCodeAccount{
		Label:     "  primary-go-plan  ",
		ChannelID: 7,
	}
	err = CreateOpenCodeAccount(account, OpenCodeAccountSecrets{
		Email:       "operator@example.test",
		WorkspaceID: "workspace-test-value",
		APIKey:      "opencode-api-key-test-value",
		Cookie:      "opencode-cookie-test-value",
	})
	require.NoError(t, err)
	require.NotZero(t, account.Id)

	var stored OpenCodeAccount
	require.NoError(t, DB.First(&stored, account.Id).Error)

	assert.Equal(t, "primary-go-plan", stored.Label)
	assert.NotContains(t, stored.EmailCiphertext, "operator@example.test")
	assert.NotContains(t, stored.WorkspaceIDCiphertext, "workspace-test-value")
	assert.NotContains(t, stored.APIKeyCiphertext, "opencode-api-key-test-value")
	assert.NotContains(t, stored.CookieCiphertext, "opencode-cookie-test-value")

	secrets, err := stored.DecryptSecrets()
	require.NoError(t, err)
	assert.Equal(t, "operator@example.test", secrets.Email)
	assert.Equal(t, "workspace-test-value", secrets.WorkspaceID)
	assert.Equal(t, "opencode-api-key-test-value", secrets.APIKey)
	assert.Equal(t, "opencode-cookie-test-value", secrets.Cookie)

	public := stored.PublicView()
	assert.Equal(t, stored.Id, public.Id)
	assert.Equal(t, "primary-go-plan", public.Label)
	assert.Equal(t, 7, public.ChannelID)
	assert.True(t, public.HasEmail)
	assert.True(t, public.HasWorkspaceID)
	assert.True(t, public.HasAPIKey)
	assert.True(t, public.HasCookie)
	assert.Equal(t, "ok", public.CredentialIntegrity)
	assert.NotEmpty(t, public.CredentialKeySource)
	assert.True(t, public.ActivationReady)
	assert.Empty(t, public.MissingActivationFields)
	assert.NotContains(t, public.EmailMasked, "operator@example.test")
}

func TestOpenCodeAccountPublicViewReportsCredentialDecryptFailure(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	DB = db
	require.NoError(t, db.AutoMigrate(&OpenCodeAccount{}, &Channel{}))
	require.NoError(t, db.Create(&Channel{
		Id:     7,
		Name:   "OpenCode Test Channel",
		Type:   1,
		Key:    "test-key",
		Status: common.ChannelStatusEnabled,
	}).Error)

	originalSecret := common.CryptoSecret
	common.CryptoSecret = "opencode-account-original-secret"
	t.Cleanup(func() {
		common.CryptoSecret = originalSecret
	})

	account := &OpenCodeAccount{
		Label:     "primary-go-plan",
		ChannelID: 7,
	}
	err = CreateOpenCodeAccount(account, OpenCodeAccountSecrets{
		Email:       "operator@example.test",
		WorkspaceID: "workspace-test-value",
		APIKey:      "opencode-api-key-test-value",
		Cookie:      "opencode-cookie-test-value",
	})
	require.NoError(t, err)

	common.CryptoSecret = "opencode-account-rotated-secret"
	var stored OpenCodeAccount
	require.NoError(t, DB.First(&stored, account.Id).Error)

	public := stored.PublicView()
	assert.True(t, public.HasAPIKey)
	assert.True(t, public.HasCookie)
	assert.True(t, public.HasWorkspaceID)
	assert.Equal(t, "decrypt_failed", public.CredentialIntegrity)
	assert.False(t, public.ActivationReady)
	assert.Contains(t, public.MissingActivationFields, "credentials_decryptable")
	assert.Empty(t, public.EmailMasked)
}

func TestOpenCodeAccountPublicViewReportsCredentialKeySource(t *testing.T) {
	account := &OpenCodeAccount{
		Label:     "primary",
		ChannelID: 7,
	}

	t.Setenv("CRYPTO_SECRET", "configured-crypto-secret")
	assert.Equal(t, common.SecretEncryptionKeySourceCryptoSecret, account.PublicView().CredentialKeySource)

	t.Setenv("CRYPTO_SECRET", "")
	assert.Equal(t, common.SecretEncryptionKeySourceSessionSecretFallback, account.PublicView().CredentialKeySource)
}

func TestCreateOpenCodeAccountRejectsInvalidLabel(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	DB = db
	require.NoError(t, db.AutoMigrate(&OpenCodeAccount{}))

	err = CreateOpenCodeAccount(&OpenCodeAccount{Label: "bad label", ChannelID: 7}, OpenCodeAccountSecrets{})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "label")
}

func TestCreateOpenCodeAccountRejectsMissingChannelBinding(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	DB = db
	require.NoError(t, db.AutoMigrate(&OpenCodeAccount{}))

	err = CreateOpenCodeAccount(&OpenCodeAccount{Label: "primary"}, OpenCodeAccountSecrets{})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "channel id")
}

func TestCreateOpenCodeAccountRejectsUnknownChannelBinding(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	DB = db
	require.NoError(t, db.AutoMigrate(&OpenCodeAccount{}, &Channel{}))

	err = CreateOpenCodeAccount(&OpenCodeAccount{
		Label:     "unknown-channel",
		ChannelID: 404,
	}, OpenCodeAccountSecrets{})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "channel not found")
}

func TestUpdateOpenCodeAccountRejectsUnknownChannelBinding(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	DB = db
	require.NoError(t, db.AutoMigrate(&OpenCodeAccount{}, &Channel{}))
	require.NoError(t, db.Create(&Channel{
		Id:     7,
		Name:   "OpenCode Test Channel",
		Type:   1,
		Key:    "test-key",
		Status: common.ChannelStatusEnabled,
	}).Error)

	account := &OpenCodeAccount{
		Label:     "primary",
		ChannelID: 7,
	}
	require.NoError(t, CreateOpenCodeAccount(account, OpenCodeAccountSecrets{
		APIKey: "opencode-api-key-test-value",
	}))

	account.ChannelID = 404
	err = UpdateOpenCodeAccount(account, OpenCodeAccountSecrets{
		APIKey: "opencode-api-key-test-value",
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "channel not found")

	var stored OpenCodeAccount
	require.NoError(t, DB.First(&stored, account.Id).Error)
	assert.Equal(t, 7, stored.ChannelID)
}
