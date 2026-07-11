package service

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
)

const openCodeAuthURL = "https://opencode.ai/auth"

var (
	openCodePublicHTTPURLPattern      = regexp.MustCompile(`https?://[^\s"'<>]+`)
	openCodePublicUnsafeURLPattern    = regexp.MustCompile(`(?i)\b(?:data|file|javascript):[^\s"'<>]+`)
	openCodePublicBearerPattern       = regexp.MustCompile(`(?i)\bbearer\s+[a-z0-9._-]+`)
	openCodePublicSecretKVPattern     = regexp.MustCompile(`(?i)\b(api[-_]?key|cookie|workspace[-_]?id|authorization|access_token|refresh_token|id_token|code|state)=([^&\s"'<>]+)`)
	openCodePublicEmailPattern        = regexp.MustCompile(`[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}`)
	openCodePublicWindowsPathPattern  = regexp.MustCompile(`(?i)\b[a-z]:\\[^\s"'<>]+`)
	openCodePublicUnixPathPattern     = regexp.MustCompile(`\B/(?:home|root|opt|var|srv|etc|mnt|tmp|data)/[^\s"'<>]+`)
	openCodePublicRedactedURLToken    = "<redacted-url>"
	openCodePublicRedactedSecretToken = "<redacted>"
	openCodePublicRedactedEmailToken  = "<redacted-email>"
	openCodePublicRedactedPathToken   = "<redacted-path>"
)

const openCodeBrowserTitleMaxRunes = 160

type OpenCodeLoginSessionStatus struct {
	AccountID int    `json:"account_id"`
	Running   bool   `json:"running"`
	Status    string `json:"status"`
	URL       string `json:"url,omitempty"`
	Title     string `json:"title,omitempty"`
	Page      string `json:"page,omitempty"`
	StartedAt int64  `json:"started_at,omitempty"`
	Message   string `json:"message,omitempty"`
}

type OpenCodeLoginScreenshot struct {
	ImageBase64 string                 `json:"image_base64"`
	Width       int                    `json:"width"`
	Height      int                    `json:"height"`
	Hotspots    []OpenCodeLoginHotspot `json:"hotspots,omitempty"`
}

type OpenCodeLoginClick struct {
	X int `json:"x"`
	Y int `json:"y"`
}

type OpenCodeLoginKeyInput struct {
	Text string `json:"text"`
}

type OpenCodeLoginPressInput struct {
	Key string `json:"key"`
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

var openCodeLoginPressKeys = map[string]struct{}{
	"Enter":      {},
	"Tab":        {},
	"Backspace":  {},
	"Escape":     {},
	"ArrowUp":    {},
	"ArrowDown":  {},
	"ArrowLeft":  {},
	"ArrowRight": {},
}

func StartOpenCodeLoginSession(ctx context.Context, accountID int) (OpenCodeLoginSessionStatus, error) {
	status, err := runOpenCodeAuthStatusAction(ctx, "start", accountID, nil, "")
	if err == nil {
		openCodeAccountAutoSync.track(status)
	}
	return status, err
}

func GetOpenCodeLoginSessionStatus(ctx context.Context, accountID int) (OpenCodeLoginSessionStatus, error) {
	status, err := loadOpenCodeLoginSessionStatus(ctx, accountID)
	if err == nil {
		openCodeAccountAutoSync.track(status)
	}
	return status, err
}

func loadOpenCodeLoginSessionStatus(ctx context.Context, accountID int) (OpenCodeLoginSessionStatus, error) {
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

func PressOpenCodeLoginSessionKey(ctx context.Context, accountID int, input OpenCodeLoginPressInput) (OpenCodeLoginSessionStatus, error) {
	key, err := normalizeOpenCodeLoginPressKey(input.Key)
	if err != nil {
		return OpenCodeLoginSessionStatus{}, err
	}
	return runOpenCodeAuthStatusAction(ctx, "press", accountID, map[string]string{"key": key}, "")
}

func StopOpenCodeLoginSession(ctx context.Context, accountID int) (OpenCodeLoginSessionStatus, error) {
	status, err := runOpenCodeAuthStatusAction(ctx, "stop", accountID, nil, "")
	if err == nil {
		openCodeAccountAutoSync.stop(accountID)
	}
	return status, err
}

func PurgeOpenCodeLoginSession(ctx context.Context, accountID int) (OpenCodeLoginSessionStatus, error) {
	status, err := runOpenCodeAuthStatusAction(ctx, "purge", accountID, nil, "")
	if err == nil {
		openCodeAccountAutoSync.stop(accountID)
	}
	return status, err
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

func SyncOpenCodeBrowserState(ctx context.Context, accountID int) (OpenCodeBrowserState, error) {
	resp, err := runOpenCodeAuthSidecar(ctx, "sync", accountID, nil, "")
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
	return sanitizeOpenCodeLoginSessionStatus(resp.Status), nil
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
		message = sanitizeOpenCodeSidecarPublicMessage(message)
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
		resp.Message = sanitizeOpenCodeSidecarPublicMessage(resp.Message)
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

func normalizeOpenCodeLoginPressKey(rawKey string) (string, error) {
	key := strings.TrimSpace(rawKey)
	if _, ok := openCodeLoginPressKeys[key]; !ok {
		return "", errors.New("unsupported opencode login key")
	}
	return key, nil
}

func sanitizeOpenCodeLoginSessionStatus(status OpenCodeLoginSessionStatus) OpenCodeLoginSessionStatus {
	status.URL = sanitizeOpenCodeBrowserURL(status.URL)
	status.Title = sanitizeOpenCodeBrowserTitle(status.Title)
	status.Page = normalizeOpenCodeLoginPageKind(status.Page)
	return status
}

func normalizeOpenCodeLoginPageKind(rawPage string) string {
	page := strings.ToLower(strings.TrimSpace(rawPage))
	switch page {
	case "keys", "workspace":
		return page
	default:
		return ""
	}
}

func sanitizeOpenCodeBrowserURL(rawURL string) string {
	rawURL = strings.TrimSpace(rawURL)
	if rawURL == "" {
		return ""
	}
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Scheme == "" {
		return ""
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		if parsed.Scheme == "about" && strings.EqualFold(parsed.Opaque, "blank") {
			return "about:blank"
		}
		return ""
	}
	parsed.User = nil
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String()
}

func sanitizeOpenCodeSidecarPublicMessage(message string) string {
	message = strings.TrimSpace(message)
	if message == "" {
		return ""
	}
	message = openCodePublicHTTPURLPattern.ReplaceAllStringFunc(message, func(rawURL string) string {
		sanitized := sanitizeOpenCodeBrowserURL(rawURL)
		if sanitized == "" {
			return openCodePublicRedactedURLToken
		}
		return sanitized
	})
	message = openCodePublicUnsafeURLPattern.ReplaceAllString(message, openCodePublicRedactedURLToken)
	message = openCodePublicBearerPattern.ReplaceAllString(message, "Bearer "+openCodePublicRedactedSecretToken)
	message = openCodePublicSecretKVPattern.ReplaceAllString(message, "${1}="+openCodePublicRedactedSecretToken)
	message = openCodePublicEmailPattern.ReplaceAllString(message, openCodePublicRedactedEmailToken)
	message = openCodePublicWindowsPathPattern.ReplaceAllString(message, openCodePublicRedactedPathToken)
	message = openCodePublicUnixPathPattern.ReplaceAllString(message, openCodePublicRedactedPathToken)
	return message
}

func sanitizeOpenCodeBrowserTitle(title string) string {
	title = strings.Join(strings.Fields(sanitizeOpenCodeSidecarPublicMessage(title)), " ")
	runes := []rune(title)
	if len(runes) <= openCodeBrowserTitleMaxRunes {
		return title
	}
	return string(runes[:openCodeBrowserTitleMaxRunes-3]) + "..."
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
	startDirs := make([]string, 0, 2)
	if dir, err := os.Getwd(); err == nil {
		startDirs = append(startDirs, dir)
	}
	if executable, err := os.Executable(); err == nil {
		startDirs = append(startDirs, filepath.Dir(executable))
	}
	return findOpenCodeAuthSidecarPath(startDirs)
}

func findOpenCodeAuthSidecarPath(startDirs []string) (string, error) {
	seen := make(map[string]bool, len(startDirs))
	for _, dir := range startDirs {
		dir = strings.TrimSpace(dir)
		if dir == "" {
			continue
		}
		absDir, err := filepath.Abs(dir)
		if err != nil {
			continue
		}
		clean := filepath.Clean(absDir)
		if seen[clean] {
			continue
		}
		seen[clean] = true
		if path, ok := findOpenCodeAuthSidecarPathAbove(clean); ok {
			return path, nil
		}
	}
	return "", errors.New("scripts/opencode-auth-session.mjs not found")
}

func findOpenCodeAuthSidecarPathAbove(dir string) (string, bool) {
	for {
		candidate := filepath.Join(dir, "scripts", "opencode-auth-session.mjs")
		if _, err := os.Stat(candidate); err == nil {
			return candidate, true
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return "", false
}

func openCodeAuthContext(parent context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(parent, 30*time.Second)
}
