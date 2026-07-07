package service

import (
	"context"
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

func TestNormalizeOpenCodeLoginPressKeyAllowsOnlySafeControlKeys(t *testing.T) {
	key, err := normalizeOpenCodeLoginPressKey("Enter")
	require.NoError(t, err)
	assert.Equal(t, "Enter", key)

	key, err = normalizeOpenCodeLoginPressKey(" ArrowLeft ")
	require.NoError(t, err)
	assert.Equal(t, "ArrowLeft", key)

	_, err = normalizeOpenCodeLoginPressKey("Control+L")
	require.Error(t, err)
	assert.NotContains(t, err.Error(), "Control+L")

	_, err = normalizeOpenCodeLoginPressKey("secret pasted into key field")
	require.Error(t, err)
	assert.NotContains(t, err.Error(), "secret pasted")
}

func TestPressOpenCodeLoginSessionKeyPassesOnlySafeKeyArgument(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node is required for opencode auth sidecar tests")
	}
	tempRoot := t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(tempRoot, "scripts"), 0o700))
	markerPath := filepath.Join(tempRoot, "press-marker.txt")
	t.Setenv("OPENCODE_PRESS_MARKER", markerPath)
	t.Setenv("OPENCODE_AUTH_STATE_DIR", t.TempDir())
	require.NoError(t, os.WriteFile(
		filepath.Join(tempRoot, "scripts", "opencode-auth-session.mjs"),
		[]byte(`import fs from "node:fs";
const args = process.argv.slice(2);
fs.writeFileSync(process.env.OPENCODE_PRESS_MARKER, args.join("\n"));
const accountID = Number(args[args.indexOf("--account-id") + 1]);
console.log(JSON.stringify({ success: true, status: { account_id: accountID, running: true, status: "running" } }));
`),
		0o700,
	))
	previousWorkingDirectory, err := os.Getwd()
	require.NoError(t, err)
	require.NoError(t, os.Chdir(tempRoot))
	t.Cleanup(func() {
		require.NoError(t, os.Chdir(previousWorkingDirectory))
	})

	status, err := PressOpenCodeLoginSessionKey(context.Background(), 202, OpenCodeLoginPressInput{Key: "Tab"})
	require.NoError(t, err)
	assert.True(t, status.Running)

	marker, err := os.ReadFile(markerPath)
	require.NoError(t, err)
	argv := string(marker)
	assert.Contains(t, argv, "--action\npress")
	assert.Contains(t, argv, "--account-id\n202")
	assert.Contains(t, argv, "--key\nTab")
}

func TestSanitizeOpenCodeLoginSessionStatusDropsAuthorizationPayload(t *testing.T) {
	status := sanitizeOpenCodeLoginSessionStatus(OpenCodeLoginSessionStatus{
		AccountID: 9,
		Running:   true,
		Status:    "running",
		URL:       "https://operator:secret@auth.opencode.ai/authorize?client_id=app&state=oauth-state&code=auth-code#fragment",
		StartedAt: 123,
	})

	assert.Equal(t, 9, status.AccountID)
	assert.Equal(t, "https://auth.opencode.ai/authorize", status.URL)
	assert.NotContains(t, status.URL, "operator")
	assert.NotContains(t, status.URL, "secret")
	assert.NotContains(t, status.URL, "oauth-state")
	assert.NotContains(t, status.URL, "auth-code")
	assert.NotContains(t, status.URL, "fragment")
}

func TestSanitizeOpenCodeLoginSessionStatusSanitizesTitle(t *testing.T) {
	status := sanitizeOpenCodeLoginSessionStatus(OpenCodeLoginSessionStatus{
		AccountID: 9,
		Running:   true,
		Status:    "running",
		Title: strings.Join([]string{
			"Sign in as operator@example.test",
			"https://operator:secret@auth.opencode.ai/callback?code=oauth-code&state=oauth-state#fragment-secret",
			"Bearer bearer-token-secret",
			`workspace_` + `id=workspace-secret`,
			"D:\\srv\\new-api\\private\\session.txt",
			"/home/operator/profile",
		}, " "),
	})

	assert.Contains(t, status.Title, "Sign in as")
	assert.Contains(t, status.Title, "https://auth.opencode.ai/callback")
	assert.NotContains(t, status.Title, "operator@example.test")
	assert.NotContains(t, status.Title, "operator:secret")
	assert.NotContains(t, status.Title, "oauth-code")
	assert.NotContains(t, status.Title, "oauth-state")
	assert.NotContains(t, status.Title, "fragment-secret")
	assert.NotContains(t, status.Title, "bearer-token-secret")
	assert.NotContains(t, status.Title, "workspace-secret")
	assert.NotContains(t, status.Title, "D:\\srv")
	assert.NotContains(t, status.Title, "/home/operator")
}

func TestSanitizeOpenCodeLoginSessionStatusKeepsAboutBlank(t *testing.T) {
	status := sanitizeOpenCodeLoginSessionStatus(OpenCodeLoginSessionStatus{
		URL: "about:blank#fragment",
	})

	assert.Equal(t, "about:blank", status.URL)
}

func TestSanitizeOpenCodeLoginSessionStatusDropsUnsafeNonHTTPBrowserURL(t *testing.T) {
	for _, rawURL := range []string{
		"data:text/plain,embedded-secret",
		"file:///local/browser-profile/token.txt",
		"javascript:alert('embedded-secret')",
	} {
		status := sanitizeOpenCodeLoginSessionStatus(OpenCodeLoginSessionStatus{URL: rawURL})

		assert.Empty(t, status.URL)
	}
}

func TestSanitizeOpenCodeSidecarPublicMessageRedactsSensitiveFragments(t *testing.T) {
	message := strings.Join([]string{
		"browser failed",
		"https://operator:secret@auth.opencode.ai/callback?code=oauth-code&state=oauth-state#fragment-secret",
		"data:text/plain,embedded-secret",
		"file:///opt/new-api/private/session.txt",
		"D:\\srv\\new-api\\private\\session.txt",
		"operator@example.test",
		"Bearer bearer-token-secret",
		`api_` + `key=api-key-secret`,
		`cook` + `ie=cookie-secret`,
		`workspace_` + `id=workspace-secret`,
	}, " ")

	sanitized := sanitizeOpenCodeSidecarPublicMessage(message)

	assert.Contains(t, sanitized, "browser failed")
	assert.Contains(t, sanitized, "https://auth.opencode.ai/callback")
	assert.NotContains(t, sanitized, "operator:secret")
	assert.NotContains(t, sanitized, "oauth-code")
	assert.NotContains(t, sanitized, "oauth-state")
	assert.NotContains(t, sanitized, "fragment-secret")
	assert.NotContains(t, sanitized, "embedded-secret")
	assert.NotContains(t, sanitized, "/opt/new-api/private")
	assert.NotContains(t, sanitized, "D:\\srv")
	assert.NotContains(t, sanitized, "operator@example.test")
	assert.NotContains(t, sanitized, "bearer-token-secret")
	assert.NotContains(t, sanitized, "api-key-secret")
	assert.NotContains(t, sanitized, "cookie-secret")
	assert.NotContains(t, sanitized, "workspace-secret")
	assert.Contains(t, sanitized, openCodePublicRedactedURLToken)
	assert.Contains(t, sanitized, openCodePublicRedactedPathToken)
	assert.Contains(t, sanitized, openCodePublicRedactedEmailToken)
	assert.Contains(t, sanitized, openCodePublicRedactedSecretToken)
}

func TestFindOpenCodeAuthSidecarPathSearchesExecutableDirectory(t *testing.T) {
	tempDir := t.TempDir()
	workingDir := filepath.Join(tempDir, "runtime")
	executableDir := filepath.Join(tempDir, "artifact", "bin")
	scriptDir := filepath.Join(tempDir, "artifact", "scripts")
	scriptPath := filepath.Join(scriptDir, "opencode-auth-session.mjs")
	require.NoError(t, os.MkdirAll(workingDir, 0o755))
	require.NoError(t, os.MkdirAll(executableDir, 0o755))
	require.NoError(t, os.MkdirAll(scriptDir, 0o755))
	require.NoError(t, os.WriteFile(scriptPath, []byte(""), 0o644))

	resolved, err := findOpenCodeAuthSidecarPath([]string{workingDir, executableDir})
	require.NoError(t, err)

	assert.Equal(t, scriptPath, resolved)
}

func TestOpenCodeAuthSidecarFailureMessageIsSanitized(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node is required for opencode auth sidecar tests")
	}
	tempRoot := t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(tempRoot, "scripts"), 0o700))
	require.NoError(t, os.WriteFile(
		filepath.Join(tempRoot, "scripts", "opencode-auth-session.mjs"),
		[]byte(`console.log(JSON.stringify({ success: false, message: process.env.OPENCODE_FAKE_FAILURE_MESSAGE }));`),
		0o700,
	))
	previousWorkingDirectory, err := os.Getwd()
	require.NoError(t, err)
	require.NoError(t, os.Chdir(tempRoot))
	t.Cleanup(func() {
		require.NoError(t, os.Chdir(previousWorkingDirectory))
	})
	t.Setenv("OPENCODE_AUTH_STATE_DIR", t.TempDir())
	t.Setenv("OPENCODE_FAKE_FAILURE_MESSAGE", strings.Join([]string{
		"browser failed",
		"https://operator:secret@auth.opencode.ai/callback?code=oauth-code&state=oauth-state#fragment-secret",
		"D:\\srv\\new-api\\private\\session.txt",
		"operator@example.test",
		`api_` + `key=api-key-secret`,
	}, " "))

	_, err = StartOpenCodeLoginSession(context.Background(), 201)
	require.Error(t, err)
	message := err.Error()

	assert.Contains(t, message, "browser failed")
	assert.Contains(t, message, "https://auth.opencode.ai/callback")
	assert.NotContains(t, message, "operator:secret")
	assert.NotContains(t, message, "oauth-code")
	assert.NotContains(t, message, "oauth-state")
	assert.NotContains(t, message, "fragment-secret")
	assert.NotContains(t, message, "D:\\srv")
	assert.NotContains(t, message, "operator@example.test")
	assert.NotContains(t, message, "api-key-secret")
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
	stateDir := t.TempDir()

	command := exec.Command("node",
		scriptPath,
		"--action", "start",
		"--account-id", "198",
		"--state-dir", stateDir,
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
	assert.NoFileExists(t, filepath.Join(stateDir, "account-198.json"))
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
	profileDir := filepath.Join(stateDir, "profile-200")

	child := exec.Command("node", "-e", `
		process.on("SIGTERM", () => setTimeout(() => process.exit(0), 350));
		setInterval(() => {}, 1000);
	`, "--remote-debugging-port=9", "--user-data-dir="+profileDir)
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
		"profile": `+strconv.Quote(profileDir)+`,
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

func TestOpenCodeAuthSidecarStopDoesNotKillUnmatchedRecordedPid(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node is required for opencode auth sidecar tests")
	}
	scriptPath, err := filepath.Abs(filepath.Join("..", "scripts", "opencode-auth-session.mjs"))
	require.NoError(t, err)
	stateDir := t.TempDir()

	child := exec.Command("node", "-e", `
		process.on("SIGTERM", () => process.exit(23));
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

	require.NoError(t, os.WriteFile(filepath.Join(stateDir, "account-201.json"), []byte(`{
		"accountID": 201,
		"port": 9,
		"display": ":401",
		"profile": `+strconv.Quote(filepath.Join(stateDir, "profile-201"))+`,
		"browserPid": `+strconv.Itoa(child.Process.Pid)+`,
		"xvfbPid": 0,
		"startedAt": 1
	}`), 0o600))

	output, err := exec.Command("node",
		scriptPath,
		"--action", "stop",
		"--account-id", "201",
		"--state-dir", stateDir,
		"--url", openCodeAuthURL,
	).Output()
	require.NoError(t, err)

	var response openCodeAuthSidecarResponse
	require.NoError(t, common.Unmarshal(output, &response))
	require.True(t, response.Success, string(output))

	select {
	case <-waitDone:
		t.Fatal("unmatched recorded pid was stopped")
	case <-time.After(150 * time.Millisecond):
	}
}
