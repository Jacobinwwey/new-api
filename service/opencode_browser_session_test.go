package service

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

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

func TestOpenCodeAuthSidecarStartReportsInvalidChromiumBinary(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node is required for opencode auth sidecar tests")
	}
	scriptPath, err := filepath.Abs(filepath.Join("..", "scripts", "opencode-auth-session.mjs"))
	require.NoError(t, err)

	command := exec.Command("node",
		scriptPath,
		"--action", "start",
		"--account-id", "198",
		"--state-dir", t.TempDir(),
		"--url", "about:blank",
	)
	command.Env = append(os.Environ(), "CHROMIUM_BIN=definitely-missing-opencode-browser-binary")

	output, err := command.Output()
	require.NoError(t, err)

	var response openCodeAuthSidecarResponse
	require.NoError(t, common.Unmarshal(output, &response))
	require.False(t, response.Success, string(output))
	assert.Contains(t, response.Message, "chromium")
	assert.Contains(t, response.Message, "definitely-missing-opencode-browser-binary")
}

func TestOpenCodeAuthSidecarStartDoesNotReusePidWithoutCDP(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node is required for opencode auth sidecar tests")
	}
	scriptPath, err := filepath.Abs(filepath.Join("..", "scripts", "opencode-auth-session.mjs"))
	require.NoError(t, err)
	stateDir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(stateDir, "account-199.json"), []byte(`{
		"accountID": 199,
		"port": 9,
		"display": ":399",
		"profile": "",
		"browserPid": `+strconv.Itoa(os.Getpid())+`,
		"xvfbPid": 0,
		"startedAt": 1
	}`), 0o600))

	command := exec.Command("node",
		scriptPath,
		"--action", "start",
		"--account-id", "199",
		"--state-dir", stateDir,
		"--url", "about:blank",
	)
	command.Env = append(os.Environ(), "CHROMIUM_BIN=definitely-missing-opencode-browser-binary")

	output, err := command.Output()
	require.NoError(t, err)

	var response openCodeAuthSidecarResponse
	require.NoError(t, common.Unmarshal(output, &response))
	require.False(t, response.Success, string(output))
	assert.Contains(t, response.Message, "definitely-missing-opencode-browser-binary")
}

func TestOpenCodeAuthSidecarStopWaitsForRecordedProcessExit(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node is required for opencode auth sidecar tests")
	}
	scriptPath, err := filepath.Abs(filepath.Join("..", "scripts", "opencode-auth-session.mjs"))
	require.NoError(t, err)
	stateDir := t.TempDir()

	child := exec.Command("node", "-e", `
		process.on("SIGTERM", () => setTimeout(() => process.exit(0), 350));
		setInterval(() => {}, 1000);
	`)
	require.NoError(t, child.Start())
	waitDone := make(chan struct{})
	go func() {
		_ = child.Wait()
		close(waitDone)
	}()
	t.Cleanup(func() {
		select {
		case <-waitDone:
			return
		default:
			_ = child.Process.Kill()
		}
		<-waitDone
	})

	require.NoError(t, os.WriteFile(filepath.Join(stateDir, "account-200.json"), []byte(`{
		"accountID": 200,
		"port": 9,
		"display": ":400",
		"profile": "",
		"browserPid": `+strconv.Itoa(child.Process.Pid)+`,
		"xvfbPid": 0,
		"startedAt": 1
	}`), 0o600))

	output, err := exec.Command("node",
		scriptPath,
		"--action", "stop",
		"--account-id", "200",
		"--state-dir", stateDir,
		"--url", openCodeAuthURL,
	).Output()
	require.NoError(t, err)

	var response openCodeAuthSidecarResponse
	require.NoError(t, common.Unmarshal(output, &response))
	require.True(t, response.Success, string(output))

	assert.Eventually(t, func() bool {
		select {
		case <-waitDone:
			return true
		default:
			return false
		}
	}, 100*time.Millisecond, 10*time.Millisecond)
}
