package controller

import (
	"net/http"
	"strconv"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
)

type OpenCodeAccountRequest struct {
	Label       string `json:"label"`
	ChannelID   int    `json:"channel_id"`
	Email       string `json:"email"`
	WorkspaceID string `json:"workspace_id"`
	APIKey      string `json:"api_key"`
	Cookie      string `json:"cookie"`
	QuotaRaw    string `json:"quota_raw"`
	QuotaLimit  int64  `json:"quota_limit"`
	QuotaUsed   int64  `json:"quota_used"`
}

type UpdateOpenCodeAccountRequest struct {
	Label       *string `json:"label"`
	ChannelID   *int    `json:"channel_id"`
	Email       *string `json:"email"`
	WorkspaceID *string `json:"workspace_id"`
	APIKey      *string `json:"api_key"`
	Cookie      *string `json:"cookie"`
	QuotaRaw    *string `json:"quota_raw"`
	QuotaLimit  *int64  `json:"quota_limit"`
	QuotaUsed   *int64  `json:"quota_used"`
}

func toOpenCodeAccountResponse(account *model.OpenCodeAccount) model.OpenCodeAccountPublic {
	if account == nil {
		return model.OpenCodeAccountPublic{}
	}
	response := account.PublicView()
	for _, field := range service.GetOpenCodeActivationMissingFields(account) {
		response.MissingActivationFields = appendMissingActivationField(response.MissingActivationFields, field)
	}
	response.ActivationReady = len(response.MissingActivationFields) == 0
	return response
}

func appendMissingActivationField(fields []string, field string) []string {
	for _, existing := range fields {
		if existing == field {
			return fields
		}
	}
	return append(fields, field)
}

func GetOpenCodeAccounts(c *gin.Context) {
	accounts, err := model.GetAllOpenCodeAccounts()
	if err != nil {
		common.ApiError(c, err)
		return
	}
	response := make([]model.OpenCodeAccountPublic, 0, len(accounts))
	for _, account := range accounts {
		response = append(response, toOpenCodeAccountResponse(account))
	}
	common.ApiSuccess(c, response)
}

func CreateOpenCodeAccount(c *gin.Context) {
	var req OpenCodeAccountRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		common.ApiErrorMsg(c, "无效的请求参数: "+err.Error())
		return
	}
	account := &model.OpenCodeAccount{
		Label:      req.Label,
		ChannelID:  req.ChannelID,
		QuotaRaw:   req.QuotaRaw,
		QuotaLimit: req.QuotaLimit,
		QuotaUsed:  req.QuotaUsed,
	}
	if err := model.CreateOpenCodeAccount(account, model.OpenCodeAccountSecrets{
		Email:       req.Email,
		WorkspaceID: req.WorkspaceID,
		APIKey:      req.APIKey,
		Cookie:      req.Cookie,
	}); err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, toOpenCodeAccountResponse(account))
}

func UpdateOpenCodeAccount(c *gin.Context) {
	id, ok := parseOpenCodeAccountID(c)
	if !ok {
		return
	}
	account, err := model.GetOpenCodeAccountById(id)
	if err != nil {
		common.ApiErrorMsg(c, "未找到该 OpenCode 账号")
		return
	}
	var req UpdateOpenCodeAccountRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		common.ApiErrorMsg(c, "无效的请求参数: "+err.Error())
		return
	}
	secrets, err := account.DecryptSecrets()
	if err != nil {
		common.ApiError(c, err)
		return
	}
	if req.Label != nil {
		account.Label = *req.Label
	}
	if req.ChannelID != nil {
		account.ChannelID = *req.ChannelID
	}
	if req.QuotaRaw != nil {
		account.QuotaRaw = *req.QuotaRaw
	}
	if req.QuotaLimit != nil {
		account.QuotaLimit = *req.QuotaLimit
	}
	if req.QuotaUsed != nil {
		account.QuotaUsed = *req.QuotaUsed
	}
	if req.Email != nil {
		secrets.Email = *req.Email
	}
	if req.WorkspaceID != nil {
		secrets.WorkspaceID = *req.WorkspaceID
	}
	if req.APIKey != nil {
		secrets.APIKey = *req.APIKey
	}
	if req.Cookie != nil {
		secrets.Cookie = *req.Cookie
	}
	if err := model.UpdateOpenCodeAccount(account, secrets); err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, toOpenCodeAccountResponse(account))
}

func DeleteOpenCodeAccount(c *gin.Context) {
	id, ok := parseOpenCodeAccountID(c)
	if !ok {
		return
	}
	if err := model.DeleteOpenCodeAccount(id); err != nil {
		common.ApiError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "message": ""})
}

func StartOpenCodeAccountLogin(c *gin.Context) {
	id, ok := parseOpenCodeAccountID(c)
	if !ok {
		return
	}
	status, err := service.StartOpenCodeLoginSession(c.Request.Context(), id)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, status)
}

func GetOpenCodeAccountLoginStatus(c *gin.Context) {
	id, ok := parseOpenCodeAccountID(c)
	if !ok {
		return
	}
	status, err := service.GetOpenCodeLoginSessionStatus(c.Request.Context(), id)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, status)
}

func GetOpenCodeAccountLoginScreenshot(c *gin.Context) {
	id, ok := parseOpenCodeAccountID(c)
	if !ok {
		return
	}
	screenshot, err := service.CaptureOpenCodeLoginScreenshot(c.Request.Context(), id)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, screenshot)
}

func ClickOpenCodeAccountLogin(c *gin.Context) {
	id, ok := parseOpenCodeAccountID(c)
	if !ok {
		return
	}
	var req service.OpenCodeLoginClick
	if err := c.ShouldBindJSON(&req); err != nil {
		common.ApiErrorMsg(c, "无效的请求参数: "+err.Error())
		return
	}
	status, err := service.ClickOpenCodeLoginSession(c.Request.Context(), id, req)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, status)
}

func KeyOpenCodeAccountLogin(c *gin.Context) {
	id, ok := parseOpenCodeAccountID(c)
	if !ok {
		return
	}
	var req service.OpenCodeLoginKeyInput
	if err := c.ShouldBindJSON(&req); err != nil {
		common.ApiErrorMsg(c, "无效的请求参数: "+err.Error())
		return
	}
	status, err := service.TypeOpenCodeLoginSessionText(c.Request.Context(), id, req)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, status)
}

func ExtractOpenCodeAccountLogin(c *gin.Context) {
	id, ok := parseOpenCodeAccountID(c)
	if !ok {
		return
	}
	account, err := model.GetOpenCodeAccountById(id)
	if err != nil {
		common.ApiErrorMsg(c, "未找到该 OpenCode 账号")
		return
	}
	state, err := service.ExtractOpenCodeBrowserState(c.Request.Context(), id)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	extracted, err := service.ExtractOpenCodeSecretsFromBrowserState(state)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	secrets, err := account.DecryptSecrets()
	if err != nil {
		common.ApiError(c, err)
		return
	}
	account.QuotaRaw = extracted.QuotaRaw
	account.QuotaLimit = extracted.QuotaLimit
	account.QuotaUsed = extracted.QuotaUsed
	account.LastExtractedAt = common.GetTimestamp()
	if err := model.UpdateOpenCodeAccount(account, mergeExtractedOpenCodeSecrets(secrets, extracted.Secrets)); err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, toOpenCodeAccountResponse(account))
}

func StopOpenCodeAccountLogin(c *gin.Context) {
	id, ok := parseOpenCodeAccountID(c)
	if !ok {
		return
	}
	status, err := service.StopOpenCodeLoginSession(c.Request.Context(), id)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, status)
}

func RefreshOpenCodeAccountQuota(c *gin.Context) {
	id, ok := parseOpenCodeAccountID(c)
	if !ok {
		return
	}
	account, err := model.GetOpenCodeAccountById(id)
	if err != nil {
		common.ApiErrorMsg(c, "未找到该 OpenCode 账号")
		return
	}
	state, err := service.ExtractOpenCodeBrowserState(c.Request.Context(), id)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	extracted, err := service.ExtractOpenCodeQuotaFromBrowserState(state)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	secrets, err := account.DecryptSecrets()
	if err != nil {
		common.ApiError(c, err)
		return
	}
	account.QuotaRaw = extracted.Raw
	account.QuotaLimit = extracted.Limit
	account.QuotaUsed = extracted.Used
	account.LastQuotaCheckedAt = common.GetTimestamp()
	if err := model.UpdateOpenCodeAccount(account, secrets); err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, toOpenCodeAccountResponse(account))
}

func ActivateOpenCodeAccount(c *gin.Context) {
	id, ok := parseOpenCodeAccountID(c)
	if !ok {
		return
	}
	account, err := service.ActivateOpenCodeAccount(id)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, toOpenCodeAccountResponse(account))
}

func parseOpenCodeAccountID(c *gin.Context) (int, bool) {
	id, err := strconv.Atoi(c.Param("id"))
	if err != nil || id <= 0 {
		common.ApiErrorMsg(c, "无效的 ID")
		return 0, false
	}
	return id, true
}

func mergeExtractedOpenCodeSecrets(existing model.OpenCodeAccountSecrets, extracted model.OpenCodeAccountSecrets) model.OpenCodeAccountSecrets {
	if extracted.Email != "" {
		existing.Email = extracted.Email
	}
	if extracted.WorkspaceID != "" {
		existing.WorkspaceID = extracted.WorkspaceID
	}
	if extracted.APIKey != "" {
		existing.APIKey = extracted.APIKey
	}
	if extracted.Cookie != "" {
		existing.Cookie = extracted.Cookie
	}
	return existing
}
