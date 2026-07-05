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
	require.NoError(t, db.AutoMigrate(&OpenCodeAccount{}))

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
	assert.NotContains(t, public.EmailMasked, "operator@example.test")
}

func TestCreateOpenCodeAccountRejectsInvalidLabel(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	DB = db
	require.NoError(t, db.AutoMigrate(&OpenCodeAccount{}))

	err = CreateOpenCodeAccount(&OpenCodeAccount{Label: "bad label"}, OpenCodeAccountSecrets{})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "label")
}
