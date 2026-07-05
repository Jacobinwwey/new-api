package service

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
)

const openCodeAuthURL = "https://opencode.ai/auth"

type OpenCodeLoginSessionStatus struct {
	AccountID int    `json:"account_id"`
	Running   bool   `json:"running"`
	Status    string `json:"status"`
	URL       string `json:"url,omitempty"`
	StartedAt int64  `json:"started_at,omitempty"`
	Message   string `json:"message,omitempty"`
}

type OpenCodeLoginScreenshot struct {
	ImageBase64 string `json:"image_base64"`
}

type OpenCodeLoginClick struct {
	X int `json:"x"`
	Y int `json:"y"`
}

type OpenCodeLoginKeyInput struct {
	Text string `json:"text"`
}

type openCodeAuthSidecarResponse struct {
	Success      bool                       `json:"success"`
	Message      string                     `json:"message"`
	Status       OpenCodeLoginSessionStatus `json:"status"`
	Screenshot   OpenCodeLoginScreenshot    `json:"screenshot"`
	BrowserState OpenCodeBrowserState       `json:"browser_state"`
}

type openCodeAuthCommandSpec struct {
	args  []string
	stdin string
}

func StartOpenCodeLoginSession(ctx context.Context, accountID int) (OpenCodeLoginSessionStatus, error) {
	return runOpenCodeAuthStatusAction(ctx, "start", accountID, nil, "")
}

func GetOpenCodeLoginSessionStatus(ctx context.Context, accountID int) (OpenCodeLoginSessionStatus, error) {
	return runOpenCodeAuthStatusAction(ctx, "status", accountID, nil, "")
}

func ClickOpenCodeLoginSession(ctx context.Context, accountID int, click OpenCodeLoginClick) (OpenCodeLoginSessionStatus, error) {
	return runOpenCodeAuthStatusAction(ctx, "click", accountID, map[string]string{
		"x": strconv.Itoa(click.X),
		"y": strconv.Itoa(click.Y),
	}, "")
}

func TypeOpenCodeLoginSessionText(ctx context.Context, accountID int, input OpenCodeLoginKeyInput) (OpenCodeLoginSessionStatus, error) {
	return runOpenCodeAuthStatusAction(ctx, "key", accountID, nil, input.Text)
}

func StopOpenCodeLoginSession(ctx context.Context, accountID int) (OpenCodeLoginSessionStatus, error) {
	return runOpenCodeAuthStatusAction(ctx, "stop", accountID, nil, "")
}

func CaptureOpenCodeLoginScreenshot(ctx context.Context, accountID int) (OpenCodeLoginScreenshot, error) {
	resp, err := runOpenCodeAuthSidecar(ctx, "screenshot", accountID, nil, "")
	if err != nil {
		return OpenCodeLoginScreenshot{}, err
	}
	return resp.Screenshot, nil
}

func ExtractOpenCodeBrowserState(ctx context.Context, accountID int) (OpenCodeBrowserState, error) {
	resp, err := runOpenCodeAuthSidecar(ctx, "extract", accountID, nil, "")
	if err != nil {
		return OpenCodeBrowserState{}, err
	}
	return resp.BrowserState, nil
}

func runOpenCodeAuthStatusAction(ctx context.Context, action string, accountID int, args map[string]string, stdin string) (OpenCodeLoginSessionStatus, error) {
	resp, err := runOpenCodeAuthSidecar(ctx, action, accountID, args, stdin)
	if err != nil {
		return OpenCodeLoginSessionStatus{}, err
	}
	return resp.Status, nil
}

func runOpenCodeAuthSidecar(ctx context.Context, action string, accountID int, args map[string]string, stdin string) (openCodeAuthSidecarResponse, error) {
	if accountID <= 0 {
		return openCodeAuthSidecarResponse{}, errors.New("opencode account id is required")
	}
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = openCodeAuthContext(ctx)
		defer cancel()
	}
	scriptPath, err := openCodeAuthSidecarPath()
	if err != nil {
		return openCodeAuthSidecarResponse{}, err
	}
	stateDir, err := openCodeAuthStateDir()
	if err != nil {
		return openCodeAuthSidecarResponse{}, err
	}
	spec := buildOpenCodeAuthCommandSpec(scriptPath, action, accountID, stateDir, stdin)
	for key, value := range args {
		spec.args = append(spec.args, "--"+key, value)
	}
	command := exec.CommandContext(ctx, "node", spec.args...)
	if spec.stdin != "" {
		command.Stdin = strings.NewReader(spec.stdin)
	}
	var stderr bytes.Buffer
	command.Stderr = &stderr
	output, err := command.Output()
	if err != nil {
		message := strings.TrimSpace(stderr.String())
		if message == "" {
			message = err.Error()
		}
		return openCodeAuthSidecarResponse{}, fmt.Errorf("opencode auth sidecar failed: %s", message)
	}
	var resp openCodeAuthSidecarResponse
	if err := commonDecodeOpenCodeSidecar(output, &resp); err != nil {
		return openCodeAuthSidecarResponse{}, err
	}
	if !resp.Success {
		if resp.Message == "" {
			resp.Message = "opencode auth sidecar returned failure"
		}
		return resp, errors.New(resp.Message)
	}
	return resp, nil
}

func buildOpenCodeAuthCommandSpec(scriptPath string, action string, accountID int, stateDir string, stdin string) openCodeAuthCommandSpec {
	return openCodeAuthCommandSpec{
		args: []string{
			scriptPath,
			"--action", action,
			"--account-id", strconv.Itoa(accountID),
			"--state-dir", stateDir,
			"--url", openCodeAuthURL,
		},
		stdin: stdin,
	}
}

func commonDecodeOpenCodeSidecar(output []byte, target *openCodeAuthSidecarResponse) error {
	if err := common.Unmarshal(output, target); err != nil {
		return fmt.Errorf("decode opencode auth sidecar response: %w", err)
	}
	return nil
}

func openCodeAuthStateDir() (string, error) {
	dir := strings.TrimSpace(os.Getenv("OPENCODE_AUTH_STATE_DIR"))
	if dir == "" {
		dir = filepath.Join("data", "opencode-auth-sessions")
	}
	return filepath.Abs(dir)
}

func openCodeAuthSidecarPath() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		candidate := filepath.Join(dir, "scripts", "opencode-auth-session.mjs")
		if _, err := os.Stat(candidate); err == nil {
			return candidate, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return "", errors.New("scripts/opencode-auth-session.mjs not found")
}

func openCodeAuthContext(parent context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(parent, 30*time.Second)
}
