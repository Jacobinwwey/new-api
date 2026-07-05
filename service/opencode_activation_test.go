package service

import (
	"testing"

	"github.com/QuantumNous/new-api/common"
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

	account := &model.OpenCodeAccount{
		Label:     "missing-key",
		ChannelID: 10,
	}
	require.NoError(t, model.CreateOpenCodeAccount(account, model.OpenCodeAccountSecrets{}))

	_, err = ActivateOpenCodeAccount(account.Id)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "api key")
}
