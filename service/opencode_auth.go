package service

import (
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
)

type OpenCodeBrowserCookie struct {
	Name   string `json:"name"`
	Value  string `json:"value"`
	Domain string `json:"domain"`
}

type OpenCodeBrowserState struct {
	Cookies        []OpenCodeBrowserCookie `json:"cookies"`
	LocalStorage   map[string]string       `json:"local_storage"`
	SessionStorage map[string]string       `json:"session_storage"`
	JSONResponses  []string                `json:"json_responses"`
}

type OpenCodeExtractedAccount struct {
	Secrets    model.OpenCodeAccountSecrets
	QuotaRaw   string
	QuotaLimit int64
	QuotaUsed  int64
	Confidence int
}

type OpenCodeExtractedQuota struct {
	Raw   string
	Limit int64
	Used  int64
}

var emailCandidatePattern = regexp.MustCompile(`^[^@\s]+@[^@\s]+\.[^@\s]+$`)

func ExtractOpenCodeSecretsFromBrowserState(state OpenCodeBrowserState) (OpenCodeExtractedAccount, error) {
	var extracted OpenCodeExtractedAccount
	extracted.Secrets.Cookie = buildOpenCodeCookieHeader(state.Cookies)
	if extracted.Secrets.Cookie != "" {
		extracted.Confidence++
	}

	scanKeyValues(state.LocalStorage, &extracted)
	scanKeyValues(state.SessionStorage, &extracted)
	for _, raw := range state.JSONResponses {
		scanJSONCandidate(raw, &extracted)
	}

	if extracted.Secrets.APIKey == "" &&
		extracted.Secrets.WorkspaceID == "" &&
		extracted.Secrets.Cookie == "" {
		return OpenCodeExtractedAccount{}, errors.New("no OpenCode account candidates found")
	}
	return extracted, nil
}

func ExtractOpenCodeQuotaFromBrowserState(state OpenCodeBrowserState) (OpenCodeExtractedQuota, error) {
	var extracted OpenCodeExtractedAccount
	scanKeyValues(state.LocalStorage, &extracted)
	scanKeyValues(state.SessionStorage, &extracted)
	for _, raw := range state.JSONResponses {
		scanJSONCandidate(raw, &extracted)
	}
	if extracted.QuotaRaw == "" && extracted.QuotaLimit == 0 && extracted.QuotaUsed == 0 {
		return OpenCodeExtractedQuota{}, errors.New("no OpenCode quota candidates found")
	}
	return OpenCodeExtractedQuota{
		Raw:   extracted.QuotaRaw,
		Limit: extracted.QuotaLimit,
		Used:  extracted.QuotaUsed,
	}, nil
}

func scanKeyValues(values map[string]string, extracted *OpenCodeExtractedAccount) {
	for key, value := range values {
		if extracted.QuotaRaw == "" && isQuotaCandidate(strings.ToLower(strings.TrimSpace(key))) {
			extracted.QuotaRaw = strings.TrimSpace(value)
			extracted.Confidence++
		}
		if scanJSONCandidate(value, extracted) {
			continue
		}
		acceptCandidate(key, value, extracted)
	}
}

func scanJSONCandidate(raw string, extracted *OpenCodeExtractedAccount) bool {
	raw = strings.TrimSpace(raw)
	if raw == "" || !(strings.HasPrefix(raw, "{") || strings.HasPrefix(raw, "[")) {
		return false
	}
	var decoded any
	if err := common.Unmarshal([]byte(raw), &decoded); err != nil {
		return false
	}
	walkOpenCodeCandidate("", decoded, extracted)
	return true
}

func walkOpenCodeCandidate(key string, value any, extracted *OpenCodeExtractedAccount) {
	switch typed := value.(type) {
	case map[string]any:
		for childKey, childValue := range typed {
			walkOpenCodeCandidate(joinCandidateKey(key, childKey), childValue, extracted)
		}
	case []any:
		for index, childValue := range typed {
			walkOpenCodeCandidate(fmt.Sprintf("%s[%d]", key, index), childValue, extracted)
		}
	case string:
		acceptCandidate(key, typed, extracted)
	case float64:
		acceptQuotaNumberCandidate(key, int64(typed), extracted)
		acceptCandidate(key, fmt.Sprintf("%v", typed), extracted)
	default:
		acceptCandidate(key, fmt.Sprintf("%v", typed), extracted)
	}
}

func acceptCandidate(key string, value string, extracted *OpenCodeExtractedAccount) {
	key = strings.ToLower(strings.TrimSpace(key))
	value = strings.TrimSpace(value)
	if value == "" {
		return
	}
	acceptQuotaStringCandidate(key, value, extracted)
	switch {
	case extracted.Secrets.APIKey == "" && isAPIKeyCandidate(key):
		extracted.Secrets.APIKey = value
		extracted.Confidence++
	case extracted.Secrets.WorkspaceID == "" && isWorkspaceCandidate(key):
		extracted.Secrets.WorkspaceID = value
		extracted.Confidence++
	case extracted.Secrets.Email == "" && emailCandidatePattern.MatchString(value):
		extracted.Secrets.Email = value
		extracted.Confidence++
	case extracted.QuotaRaw == "" && isQuotaCandidate(key):
		extracted.QuotaRaw = value
		extracted.Confidence++
	}
}

func acceptQuotaStringCandidate(key string, value string, extracted *OpenCodeExtractedAccount) {
	number, ok := parseQuotaNumber(value)
	if !ok {
		return
	}
	acceptQuotaNumberCandidate(key, number, extracted)
}

func acceptQuotaNumberCandidate(key string, value int64, extracted *OpenCodeExtractedAccount) {
	key = strings.ToLower(strings.TrimSpace(key))
	if value < 0 {
		return
	}
	switch {
	case extracted.QuotaUsed == 0 && isQuotaUsedCandidate(key):
		extracted.QuotaUsed = value
	case extracted.QuotaLimit == 0 && isQuotaLimitCandidate(key):
		extracted.QuotaLimit = value
	}
}

func isAPIKeyCandidate(key string) bool {
	return strings.Contains(key, "api_key") ||
		strings.Contains(key, "apikey") ||
		strings.HasSuffix(key, ".key") ||
		strings.HasSuffix(key, "token")
}

func isWorkspaceCandidate(key string) bool {
	return strings.Contains(key, "workspace_id") ||
		strings.Contains(key, "workspaceid") ||
		strings.HasSuffix(key, "workspace")
}

func isQuotaCandidate(key string) bool {
	return strings.Contains(key, "quota") ||
		strings.Contains(key, "credit") ||
		strings.Contains(key, "limit")
}

func isQuotaLimitCandidate(key string) bool {
	return strings.Contains(key, "limit") ||
		strings.Contains(key, "total") ||
		strings.Contains(key, "quota")
}

func isQuotaUsedCandidate(key string) bool {
	return strings.Contains(key, "used") ||
		strings.Contains(key, "usage") ||
		strings.Contains(key, "consumed")
}

func parseQuotaNumber(value string) (int64, bool) {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0, false
	}
	var parsed int64
	if _, err := fmt.Sscan(value, &parsed); err != nil {
		return 0, false
	}
	return parsed, true
}

func joinCandidateKey(parent string, child string) string {
	if parent == "" {
		return child
	}
	return parent + "." + child
}

func buildOpenCodeCookieHeader(cookies []OpenCodeBrowserCookie) string {
	parts := make([]string, 0, len(cookies))
	for _, cookie := range cookies {
		name := strings.TrimSpace(cookie.Name)
		value := strings.TrimSpace(cookie.Value)
		domain := strings.ToLower(strings.TrimSpace(cookie.Domain))
		if name == "" || value == "" {
			continue
		}
		if domain != "" && !strings.Contains(domain, "opencode.ai") {
			continue
		}
		parts = append(parts, name+"="+value)
	}
	return strings.Join(parts, "; ")
}
