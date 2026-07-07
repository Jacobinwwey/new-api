package router

import (
	"net/http"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestOpenCodeAccountRoutesRegisterExpectedPaths(t *testing.T) {
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	api := engine.Group("/api")

	require.NotPanics(t, func() {
		registerOpenCodeAccountRoutes(api)
	})

	routes := map[string]struct{}{}
	for _, route := range engine.Routes() {
		routes[route.Method+" "+route.Path] = struct{}{}
	}

	expected := []string{
		http.MethodGet + " /api/opencode/accounts",
		http.MethodGet + " /api/opencode/accounts/diagnostics",
		http.MethodPost + " /api/opencode/accounts",
		http.MethodPut + " /api/opencode/accounts/:id",
		http.MethodDelete + " /api/opencode/accounts/:id",
		http.MethodPost + " /api/opencode/accounts/:id/login/start",
		http.MethodGet + " /api/opencode/accounts/:id/login/status",
		http.MethodGet + " /api/opencode/accounts/:id/login/screenshot",
		http.MethodPost + " /api/opencode/accounts/:id/login/click",
		http.MethodPost + " /api/opencode/accounts/:id/login/key",
		http.MethodPost + " /api/opencode/accounts/:id/login/press",
		http.MethodPost + " /api/opencode/accounts/:id/login/extract",
		http.MethodPost + " /api/opencode/accounts/:id/login/stop",
		http.MethodPost + " /api/opencode/accounts/:id/quota/refresh",
		http.MethodPost + " /api/opencode/accounts/:id/activate",
	}
	for _, route := range expected {
		_, ok := routes[route]
		assert.True(t, ok, "missing route %s", route)
	}
}
