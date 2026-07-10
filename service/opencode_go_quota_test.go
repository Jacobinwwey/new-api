package service

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestParseOpenCodeGoQuotaDashboardParsesSolidHydrationWindows(t *testing.T) {
	now := time.Date(2026, time.July, 10, 12, 0, 0, 0, time.UTC)
	html := `rollingUsage:$R[1]={usagePercent:7.5,resetInSec:1800} weeklyUsage:$R[2]={resetInSec:7200,usagePercent:22} monthlyUsage:$R[3]={usagePercent:64,resetInSec:86400}`

	snapshot, err := parseOpenCodeGoQuotaDashboard(html, now)
	require.NoError(t, err)

	require.NotNil(t, snapshot.Rolling)
	assert.Equal(t, 7.5, snapshot.Rolling.UsagePercent)
	assert.Equal(t, now.Add(30*time.Minute), snapshot.Rolling.ResetAt)
	require.NotNil(t, snapshot.Weekly)
	assert.Equal(t, 22.0, snapshot.Weekly.UsagePercent)
	require.NotNil(t, snapshot.Monthly)
	assert.Equal(t, 64.0, snapshot.Monthly.UsagePercent)
}

func TestParseOpenCodeGoQuotaDashboardParsesDataSlotWindows(t *testing.T) {
	now := time.Date(2026, time.July, 10, 12, 0, 0, 0, time.UTC)
	html := `<div data-slot="usage-item"><span data-slot="usage-label">Rolling Usage</span><span data-slot="usage-value">7%</span><span data-slot="reset-time">Resets in 1 hour 30 minutes</span></div><div data-slot="usage-item"><span data-slot="usage-label">Weekly Usage</span><span data-slot="usage-value">22.5%</span><span data-slot="reset-now">Resets now</span></div>`

	snapshot, err := parseOpenCodeGoQuotaDashboard(html, now)
	require.NoError(t, err)

	require.NotNil(t, snapshot.Rolling)
	assert.Equal(t, 7.0, snapshot.Rolling.UsagePercent)
	assert.Equal(t, now.Add(90*time.Minute), snapshot.Rolling.ResetAt)
	require.NotNil(t, snapshot.Weekly)
	assert.Equal(t, 22.5, snapshot.Weekly.UsagePercent)
	assert.Equal(t, now, snapshot.Weekly.ResetAt)
	assert.Nil(t, snapshot.Monthly)
}

func TestParseOpenCodeGoQuotaDashboardRejectsUnknownMarkup(t *testing.T) {
	_, err := parseOpenCodeGoQuotaDashboard("<main>no usage windows</main>", time.Now())
	require.Error(t, err)
	assert.Contains(t, err.Error(), "usage windows")
}

func TestFetchOpenCodeGoQuotaRequestsWorkspaceDashboardWithAuthCookie(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		assert.Equal(t, "/workspace/workspace-fixture/go", request.URL.Path)
		assert.Equal(t, "auth=fixture-cookie", request.Header.Get("Cookie"))
		assert.Equal(t, "text/html", request.Header.Get("Accept"))
		_, _ = writer.Write([]byte(`rollingUsage:$R[1]={usagePercent:7,resetInSec:1800}`))
	}))
	defer server.Close()

	snapshot, err := fetchOpenCodeGoQuota(context.Background(), server.Client(), server.URL, "workspace-fixture", "auth=fixture-cookie")
	require.NoError(t, err)
	require.NotNil(t, snapshot.Rolling)
	assert.Equal(t, 7.0, snapshot.Rolling.UsagePercent)
}
