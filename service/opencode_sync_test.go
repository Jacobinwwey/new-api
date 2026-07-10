package service

import (
	"context"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSyncOpenCodeAccountPersistsBrowserKeyQuotaAndActivatesChannel(t *testing.T) {
	db := setupOpenCodeActivationTestDB(t)
	originalSecret := common.CryptoSecret
	common.CryptoSecret = "opencode-sync-test-secret"
	t.Cleanup(func() { common.CryptoSecret = originalSecret })
	require.NoError(t, db.Create(&model.Channel{Id: 31, Name: "OpenCode Go", Type: 1, Status: common.ChannelStatusEnabled}).Error)
	account := &model.OpenCodeAccount{Label: "go-sync", ChannelID: 31}
	require.NoError(t, model.CreateOpenCodeAccount(account, model.OpenCodeAccountSecrets{}))

	quotaSnapshot := OpenCodeGoQuotaSnapshot{
		Schema: "opencode-go-dashboard-v1",
		Rolling: &OpenCodeGoQuotaWindow{
			UsagePercent: 7,
			ResetAt:      time.Date(2026, time.July, 10, 14, 0, 0, 0, time.UTC),
		},
	}
	originalBrowserStateLoader := openCodeSyncBrowserStateLoader
	originalQuotaLoader := openCodeSyncQuotaLoader
	openCodeSyncBrowserStateLoader = func(context.Context, int) (OpenCodeBrowserState, error) {
		return OpenCodeBrowserState{
			WorkspaceID: "workspace-sync-test",
			APIKey:      "oc_fixture_key_0123456789abcdef",
			Cookies:     []OpenCodeBrowserCookie{{Name: "auth", Value: "fixture-cookie", Domain: "opencode.ai"}},
		}, nil
	}
	openCodeSyncQuotaLoader = func(context.Context, string, string) (OpenCodeGoQuotaSnapshot, error) {
		return quotaSnapshot, nil
	}
	t.Cleanup(func() {
		openCodeSyncBrowserStateLoader = originalBrowserStateLoader
		openCodeSyncQuotaLoader = originalQuotaLoader
	})

	activated, err := SyncOpenCodeAccount(context.Background(), account.Id)
	require.NoError(t, err)
	assert.True(t, activated.Active)
	assert.Equal(t, int64(100), activated.QuotaLimit)
	assert.Equal(t, int64(7), activated.QuotaUsed)

	var channel model.Channel
	require.NoError(t, db.First(&channel, 31).Error)
	assert.Equal(t, "oc_fixture_key_0123456789abcdef", channel.Key)
	stored, err := model.GetOpenCodeAccountById(account.Id)
	require.NoError(t, err)
	secrets, err := stored.DecryptSecrets()
	require.NoError(t, err)
	assert.Equal(t, "workspace-sync-test", secrets.WorkspaceID)
	assert.Contains(t, secrets.Cookie, "auth=fixture-cookie")
	assert.Equal(t, "oc_fixture_key_0123456789abcdef", secrets.APIKey)
	assert.NotEmpty(t, stored.QuotaRaw)
}
