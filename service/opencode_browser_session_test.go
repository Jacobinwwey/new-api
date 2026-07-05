package service

import (
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestBuildOpenCodeAuthCommandSpecPassesKeyTextThroughStdin(t *testing.T) {
	spec := buildOpenCodeAuthCommandSpec("sidecar.mjs", "key", 7, "state-dir", "secret-login-text")

	assert.NotContains(t, spec.args, "secret-login-text")
	assert.NotContains(t, strings.Join(spec.args, "\x00"), "secret-login-text")
	assert.Equal(t, "secret-login-text", spec.stdin)
}

func TestOpenCodeAuthSidecarStatusTreatsMissingStateAsStopped(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node is required for opencode auth sidecar tests")
	}
	scriptPath, err := filepath.Abs(filepath.Join("..", "scripts", "opencode-auth-session.mjs"))
	require.NoError(t, err)

	output, err := exec.Command("node",
		scriptPath,
		"--action", "status",
		"--account-id", "197",
		"--state-dir", t.TempDir(),
		"--url", openCodeAuthURL,
	).Output()
	require.NoError(t, err)

	var response openCodeAuthSidecarResponse
	require.NoError(t, common.Unmarshal(output, &response))
	require.True(t, response.Success, string(output))
	assert.False(t, response.Status.Running)
	assert.Equal(t, "stopped", response.Status.Status)
	assert.Equal(t, 197, response.Status.AccountID)
}
