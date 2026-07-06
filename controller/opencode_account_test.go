package controller

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
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

func TestGetOpenCodeAccountDiagnosticsReturnsNonSecretPayload(t *testing.T) {
	gin.SetMode(gin.TestMode)
	t.Setenv("CRYPTO_SECRET", "configured-crypto-secret")

	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodGet, "/api/opencode/accounts/diagnostics", nil)

	GetOpenCodeAccountDiagnostics(ctx)

	require.Equal(t, http.StatusOK, recorder.Code)
	var payload struct {
		Success bool                       `json:"success"`
		Message string                     `json:"message"`
		Data    OpenCodeAccountDiagnostics `json:"data"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &payload))
	assert.True(t, payload.Success)
	assert.Empty(t, payload.Message)
	assert.Equal(t, common.SecretEncryptionKeySourceCryptoSecret, payload.Data.CredentialKeySource)
	assert.False(t, payload.Data.UsesFallbackCredentialKey)
	assert.NotContains(t, recorder.Body.String(), "configured-crypto-secret")
}

func TestDeleteOpenCodeAccountPurgesLoginSessionBeforeDeleting(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	originalDB := model.DB
	model.DB = db
	t.Cleanup(func() {
		model.DB = originalDB
	})
	require.NoError(t, db.AutoMigrate(&model.OpenCodeAccount{}))
	require.NoError(t, db.Create(&model.OpenCodeAccount{
		Id:        77,
		Label:     "delete-lifecycle",
		ChannelID: 9,
	}).Error)

	tempRoot := t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(tempRoot, "scripts"), 0o700))
	markerPath := filepath.Join(tempRoot, "stop-marker.txt")
	t.Setenv("OPENCODE_DELETE_STOP_MARKER", markerPath)
	require.NoError(t, os.WriteFile(
		filepath.Join(tempRoot, "scripts", "opencode-auth-session.mjs"),
		[]byte(`import fs from "node:fs";
const args = process.argv.slice(2);
fs.writeFileSync(process.env.OPENCODE_DELETE_STOP_MARKER, args.join("\n"));
const accountID = Number(args[args.indexOf("--account-id") + 1]);
console.log(JSON.stringify({ success: true, status: { account_id: accountID, running: false, status: "stopped" } }));
`),
		0o700,
	))
	previousWorkingDirectory, err := os.Getwd()
	require.NoError(t, err)
	require.NoError(t, os.Chdir(tempRoot))
	t.Cleanup(func() {
		require.NoError(t, os.Chdir(previousWorkingDirectory))
	})

	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Params = gin.Params{{Key: "id", Value: "77"}}
	ctx.Request = httptest.NewRequest(http.MethodDelete, "/api/opencode/accounts/77", nil)

	DeleteOpenCodeAccount(ctx)

	require.Equal(t, http.StatusOK, recorder.Code)
	marker, err := os.ReadFile(markerPath)
	require.NoError(t, err)
	assert.Contains(t, string(marker), "--action\npurge")
	assert.Contains(t, string(marker), "--account-id\n77")

	var account model.OpenCodeAccount
	err = db.First(&account, 77).Error
	assert.True(t, errors.Is(err, gorm.ErrRecordNotFound))
}

func TestDeleteOpenCodeAccountPreservesAccountWhenPurgeFails(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	originalDB := model.DB
	model.DB = db
	t.Cleanup(func() {
		model.DB = originalDB
	})
	require.NoError(t, db.AutoMigrate(&model.OpenCodeAccount{}))
	require.NoError(t, db.Create(&model.OpenCodeAccount{
		Id:        78,
		Label:     "delete-purge-fails",
		ChannelID: 9,
	}).Error)

	tempRoot := t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(tempRoot, "scripts"), 0o700))
	require.NoError(t, os.WriteFile(
		filepath.Join(tempRoot, "scripts", "opencode-auth-session.mjs"),
		[]byte(`console.log(JSON.stringify({ success: false, message: "purge failed for test" }));`),
		0o700,
	))
	previousWorkingDirectory, err := os.Getwd()
	require.NoError(t, err)
	require.NoError(t, os.Chdir(tempRoot))
	t.Cleanup(func() {
		require.NoError(t, os.Chdir(previousWorkingDirectory))
	})

	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Params = gin.Params{{Key: "id", Value: "78"}}
	ctx.Request = httptest.NewRequest(http.MethodDelete, "/api/opencode/accounts/78", nil)

	DeleteOpenCodeAccount(ctx)

	require.Equal(t, http.StatusOK, recorder.Code)
	assert.Contains(t, recorder.Body.String(), "purge failed for test")

	var account model.OpenCodeAccount
	require.NoError(t, db.First(&account, 78).Error)
	assert.Equal(t, "delete-purge-fails", account.Label)
}
