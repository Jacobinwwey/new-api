package service

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	openCodeGoDashboardBaseURL = "https://opencode.ai"
	openCodeGoDashboardMaxBody = 4 << 20
)

type OpenCodeGoQuotaWindow struct {
	UsagePercent float64   `json:"usage_percent"`
	ResetAt      time.Time `json:"reset_at"`
}

type OpenCodeGoQuotaSnapshot struct {
	Schema  string                 `json:"schema"`
	Rolling *OpenCodeGoQuotaWindow `json:"rolling,omitempty"`
	Weekly  *OpenCodeGoQuotaWindow `json:"weekly,omitempty"`
	Monthly *OpenCodeGoQuotaWindow `json:"monthly,omitempty"`
}

var (
	openCodeGoUsagePercentPattern = regexp.MustCompile(`usagePercent:\s*(-?\d+(?:\.\d+)?)`)
	openCodeGoResetSecondsPattern = regexp.MustCompile(`resetInSec:\s*(-?\d+(?:\.\d+)?)`)
	openCodeGoUsageLabelPattern   = regexp.MustCompile(`data-slot="usage-label">([^<]+)<`)
	openCodeGoUsageValuePattern   = regexp.MustCompile(`data-slot="usage-value">[^0-9]*(\d+(?:\.\d+)?)`)
	openCodeGoResetPattern        = regexp.MustCompile(`(?s)data-slot="(reset-time|reset-now)">(.+?)</span>`)
	openCodeGoDurationPattern     = regexp.MustCompile(`(?i)(\d+(?:\.\d+)?)\s*(days?|hours?|minutes?|seconds?)`)
)

func parseOpenCodeGoQuotaDashboard(html string, now time.Time) (OpenCodeGoQuotaSnapshot, error) {
	snapshot := OpenCodeGoQuotaSnapshot{Schema: "opencode-go-dashboard-v1"}
	snapshot.Rolling = parseOpenCodeGoSolidWindow(html, "rollingUsage", now)
	snapshot.Weekly = parseOpenCodeGoSolidWindow(html, "weeklyUsage", now)
	snapshot.Monthly = parseOpenCodeGoSolidWindow(html, "monthlyUsage", now)
	if snapshot.Rolling == nil && snapshot.Weekly == nil && snapshot.Monthly == nil {
		parseOpenCodeGoDataSlotWindows(html, now, &snapshot)
	}
	if snapshot.Rolling == nil && snapshot.Weekly == nil && snapshot.Monthly == nil {
		return OpenCodeGoQuotaSnapshot{}, errors.New("no OpenCode Go usage windows found")
	}
	return snapshot, nil
}

func FetchOpenCodeGoQuota(ctx context.Context, workspaceID string, cookieHeader string) (OpenCodeGoQuotaSnapshot, error) {
	client := GetHttpClient()
	if client == nil {
		client = http.DefaultClient
	}
	return fetchOpenCodeGoQuota(ctx, client, openCodeGoDashboardBaseURL, workspaceID, cookieHeader)
}

func fetchOpenCodeGoQuota(ctx context.Context, client *http.Client, baseURL string, workspaceID string, cookieHeader string) (OpenCodeGoQuotaSnapshot, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return OpenCodeGoQuotaSnapshot{}, errors.New("OpenCode Go workspace id is required")
	}
	authCookie, ok := openCodeGoAuthCookieHeader(cookieHeader)
	if !ok {
		return OpenCodeGoQuotaSnapshot{}, errors.New("OpenCode Go auth cookie is required")
	}
	base, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil || base.Scheme == "" || base.Host == "" {
		return OpenCodeGoQuotaSnapshot{}, errors.New("OpenCode Go dashboard base URL is invalid")
	}
	base.Path = "/workspace/" + url.PathEscape(workspaceID) + "/go"
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, base.String(), nil)
	if err != nil {
		return OpenCodeGoQuotaSnapshot{}, errors.New("create OpenCode Go dashboard request failed")
	}
	request.Header.Set("Accept", "text/html")
	request.Header.Set("Cookie", authCookie)
	response, err := client.Do(request)
	if err != nil {
		return OpenCodeGoQuotaSnapshot{}, errors.New("OpenCode Go dashboard request failed")
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return OpenCodeGoQuotaSnapshot{}, fmt.Errorf("OpenCode Go dashboard returned status %d", response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, openCodeGoDashboardMaxBody))
	if err != nil {
		return OpenCodeGoQuotaSnapshot{}, errors.New("read OpenCode Go dashboard response failed")
	}
	return parseOpenCodeGoQuotaDashboard(string(body), time.Now().UTC())
}

func openCodeGoAuthCookieHeader(cookieHeader string) (string, bool) {
	for _, part := range strings.Split(cookieHeader, ";") {
		name, value, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok || name != "auth" || strings.TrimSpace(value) == "" {
			continue
		}
		return "auth=" + strings.TrimSpace(value), true
	}
	return "", false
}

func parseOpenCodeGoSolidWindow(html string, field string, now time.Time) *OpenCodeGoQuotaWindow {
	pattern := regexp.MustCompile(regexp.QuoteMeta(field) + `:\$R\[\d+\]=\{([^}]*)\}`)
	match := pattern.FindStringSubmatch(html)
	if len(match) != 2 {
		return nil
	}
	usagePercent, ok := parseOpenCodeGoFloat(openCodeGoUsagePercentPattern, match[1])
	if !ok {
		return nil
	}
	resetInSeconds, ok := parseOpenCodeGoFloat(openCodeGoResetSecondsPattern, match[1])
	if !ok {
		return nil
	}
	return newOpenCodeGoQuotaWindow(usagePercent, resetInSeconds, now)
}

func parseOpenCodeGoDataSlotWindows(html string, now time.Time, snapshot *OpenCodeGoQuotaSnapshot) {
	for _, item := range strings.Split(html, `data-slot="usage-item"`)[1:] {
		labelMatch := openCodeGoUsageLabelPattern.FindStringSubmatch(item)
		if len(labelMatch) != 2 {
			continue
		}
		label := strings.ToLower(strings.TrimSpace(labelMatch[1]))
		usagePercent, ok := parseOpenCodeGoFloat(openCodeGoUsageValuePattern, item)
		if !ok {
			continue
		}
		resetMatch := openCodeGoResetPattern.FindStringSubmatch(item)
		if len(resetMatch) != 3 {
			continue
		}
		resetInSeconds, ok := parseOpenCodeGoResetSeconds(resetMatch[1], resetMatch[2])
		if !ok {
			continue
		}
		window := newOpenCodeGoQuotaWindow(usagePercent, resetInSeconds, now)
		switch {
		case strings.Contains(label, "rolling"):
			snapshot.Rolling = window
		case strings.Contains(label, "weekly"):
			snapshot.Weekly = window
		case strings.Contains(label, "monthly"):
			snapshot.Monthly = window
		}
	}
}

func parseOpenCodeGoFloat(pattern *regexp.Regexp, value string) (float64, bool) {
	match := pattern.FindStringSubmatch(value)
	if len(match) != 2 {
		return 0, false
	}
	parsed, err := strconv.ParseFloat(match[1], 64)
	if err != nil || parsed < 0 {
		return 0, false
	}
	return parsed, true
}

func parseOpenCodeGoResetSeconds(kind string, raw string) (float64, bool) {
	if kind == "reset-now" {
		return 0, true
	}
	var total float64
	for _, match := range openCodeGoDurationPattern.FindAllStringSubmatch(strings.ToLower(raw), -1) {
		value, err := strconv.ParseFloat(match[1], 64)
		if err != nil {
			return 0, false
		}
		switch match[2] {
		case "day", "days":
			total += value * 24 * 60 * 60
		case "hour", "hours":
			total += value * 60 * 60
		case "minute", "minutes":
			total += value * 60
		case "second", "seconds":
			total += value
		}
	}
	return total, total > 0
}

func newOpenCodeGoQuotaWindow(usagePercent float64, resetInSeconds float64, now time.Time) *OpenCodeGoQuotaWindow {
	return &OpenCodeGoQuotaWindow{
		UsagePercent: usagePercent,
		ResetAt:      now.Add(time.Duration(resetInSeconds * float64(time.Second))),
	}
}
