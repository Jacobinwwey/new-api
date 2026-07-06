package service

import (
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func TestActivateOpenCodeAccountUpdatesBoundChannelKeyAndActiveAccount(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	model.DB = db
	require.NoError(t, db.AutoMigrate(&model.OpenCodeAccount{}, &model.Channel{}))

	originalSecret := common.CryptoSecret
	common.CryptoSecret = "opencode-activation-test-secret"
	t.Cleanup(func() {
		common.CryptoSecret = originalSecret
	})

	channel := &model.Channel{
		Id:     9,
		Name:   "OpenCode Test",
		Type:   1,
		Key:    "old-key",
		Status: common.ChannelStatusEnabled,
	}
	require.NoError(t, db.Create(channel).Error)

	account := &model.OpenCodeAccount{
		Label:     "primary",
		ChannelID: 9,
	}
	require.NoError(t, model.CreateOpenCodeAccount(account, model.OpenCodeAccountSecrets{
		APIKey:      "opencode-api-key-activation-test",
		WorkspaceID: "workspace-activation-test",
		Cookie:      "cookie-activation-test",
	}))

	activated, err := ActivateOpenCodeAccount(account.Id)
	require.NoError(t, err)

	assert.True(t, activated.Active)
	var updatedChannel model.Channel
	require.NoError(t, db.First(&updatedChannel, 9).Error)
	assert.Equal(t, "opencode-api-key-activation-test", updatedChannel.Key)
}

func TestActivateOpenCodeAccountRequiresAPIKey(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	model.DB = db
	require.NoError(t, db.AutoMigrate(&model.OpenCodeAccount{}, &model.Channel{}))
	require.NoError(t, db.Create(&model.Channel{
		Id:     10,
		Name:   "OpenCode Missing Key",
		Type:   1,
		Key:    "old-key",
		Status: common.ChannelStatusEnabled,
	}).Error)

	account := &model.OpenCodeAccount{
		Label:     "missing-key",
		ChannelID: 10,
	}
	require.NoError(t, model.CreateOpenCodeAccount(account, model.OpenCodeAccountSecrets{}))

	_, err = ActivateOpenCodeAccount(account.Id)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "api key")
}

func TestActivateOpenCodeAccountRequiresExistingChannel(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	model.DB = db
	require.NoError(t, db.AutoMigrate(&model.OpenCodeAccount{}, &model.Channel{}))
	require.NoError(t, db.Create(&model.Channel{
		Id:     404,
		Name:   "OpenCode Deleted Channel",
		Type:   1,
		Key:    "old-key",
		Status: common.ChannelStatusEnabled,
	}).Error)

	originalSecret := common.CryptoSecret
	common.CryptoSecret = "opencode-missing-channel-activation-test-secret"
	t.Cleanup(func() {
		common.CryptoSecret = originalSecret
	})

	account := &model.OpenCodeAccount{
		Label:     "missing-channel",
		ChannelID: 404,
	}
	require.NoError(t, model.CreateOpenCodeAccount(account, model.OpenCodeAccountSecrets{
		APIKey: "opencode-api-key-missing-channel-test",
	}))
	require.NoError(t, db.Delete(&model.Channel{}, 404).Error)

	_, err = ActivateOpenCodeAccount(account.Id)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "channel")
	assert.NotContains(t, err.Error(), "record not found")

	var updatedAccount model.OpenCodeAccount
	require.NoError(t, db.First(&updatedAccount, account.Id).Error)
	assert.False(t, updatedAccount.Active)
}

func TestActivateOpenCodeAccountRejectsPlainAPIKeyForCodexChannel(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	model.DB = db
	require.NoError(t, db.AutoMigrate(&model.OpenCodeAccount{}, &model.Channel{}))

	originalSecret := common.CryptoSecret
	common.CryptoSecret = "opencode-codex-activation-test-secret"
	t.Cleanup(func() {
		common.CryptoSecret = originalSecret
	})

	channel := &model.Channel{
		Id:     11,
		Name:   "Codex Test",
		Type:   constant.ChannelTypeCodex,
		Key:    `{"access_token":"old-token","account_id":"old-account"}`,
		Status: common.ChannelStatusEnabled,
	}
	require.NoError(t, db.Create(channel).Error)

	account := &model.OpenCodeAccount{
		Label:     "plain-key",
		ChannelID: 11,
	}
	require.NoError(t, model.CreateOpenCodeAccount(account, model.OpenCodeAccountSecrets{
		APIKey: "plain-opencode-api-key",
	}))

	_, err = ActivateOpenCodeAccount(account.Id)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "Codex")
	assert.Contains(t, err.Error(), "access_token")

	var updatedChannel model.Channel
	require.NoError(t, db.First(&updatedChannel, 11).Error)
	assert.Equal(t, `{"access_token":"old-token","account_id":"old-account"}`, updatedChannel.Key)

	var updatedAccount model.OpenCodeAccount
	require.NoError(t, db.First(&updatedAccount, account.Id).Error)
	assert.False(t, updatedAccount.Active)
}

func TestActivateOpenCodeAccountAcceptsCodexOAuthJSONKey(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	model.DB = db
	require.NoError(t, db.AutoMigrate(&model.OpenCodeAccount{}, &model.Channel{}))

	originalSecret := common.CryptoSecret
	common.CryptoSecret = "opencode-codex-json-activation-test-secret"
	t.Cleanup(func() {
		common.CryptoSecret = originalSecret
	})

	channel := &model.Channel{
		Id:     12,
		Name:   "Codex JSON Test",
		Type:   constant.ChannelTypeCodex,
		Key:    `{"access_token":"old-token","account_id":"old-account"}`,
		Status: common.ChannelStatusEnabled,
	}
	require.NoError(t, db.Create(channel).Error)

	codexKey := `{"access_token":"unit-access-token","account_id":"unit-account"}`
	account := &model.OpenCodeAccount{
		Label:     "json-key",
		ChannelID: 12,
	}
	require.NoError(t, model.CreateOpenCodeAccount(account, model.OpenCodeAccountSecrets{
		APIKey: codexKey,
	}))

	activated, err := ActivateOpenCodeAccount(account.Id)
	require.NoError(t, err)
	assert.True(t, activated.Active)

	var updatedChannel model.Channel
	require.NoError(t, db.First(&updatedChannel, 12).Error)
	assert.Equal(t, codexKey, updatedChannel.Key)
}
