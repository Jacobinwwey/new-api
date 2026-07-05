package model

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
)

type OpenCodeAccount struct {
	Id                    int       `json:"id" gorm:"primaryKey"`
	Label                 string    `json:"label" gorm:"type:varchar(64);uniqueIndex;not null"`
	EmailCiphertext       string    `json:"-" gorm:"type:text"`
	WorkspaceIDCiphertext string    `json:"-" gorm:"type:text"`
	APIKeyCiphertext      string    `json:"-" gorm:"type:text"`
	CookieCiphertext      string    `json:"-" gorm:"type:text"`
	ChannelID             int       `json:"channel_id" gorm:"index"`
	QuotaRaw              string    `json:"quota_raw" gorm:"type:text"`
	QuotaLimit            int64     `json:"quota_limit" gorm:"bigint;default:0"`
	QuotaUsed             int64     `json:"quota_used" gorm:"bigint;default:0"`
	LoginStatus           string    `json:"login_status" gorm:"type:varchar(32);default:'idle'"`
	Active                bool      `json:"active"`
	LastExtractedAt       int64     `json:"last_extracted_at" gorm:"bigint;default:0"`
	LastQuotaCheckedAt    int64     `json:"last_quota_checked_at" gorm:"bigint;default:0"`
	CreatedAt             time.Time `json:"created_at"`
	UpdatedAt             time.Time `json:"updated_at"`
}

type OpenCodeAccountSecrets struct {
	Email       string
	WorkspaceID string
	APIKey      string
	Cookie      string
}

type OpenCodeAccountPublic struct {
	Id                 int    `json:"id"`
	Label              string `json:"label"`
	ChannelID          int    `json:"channel_id"`
	QuotaRaw           string `json:"quota_raw"`
	QuotaLimit         int64  `json:"quota_limit"`
	QuotaUsed          int64  `json:"quota_used"`
	LoginStatus        string `json:"login_status"`
	Active             bool   `json:"active"`
	LastExtractedAt    int64  `json:"last_extracted_at"`
	LastQuotaCheckedAt int64  `json:"last_quota_checked_at"`
	CreatedAt          string `json:"created_at"`
	UpdatedAt          string `json:"updated_at"`
	HasEmail           bool   `json:"has_email"`
	HasWorkspaceID     bool   `json:"has_workspace_id"`
	HasAPIKey          bool   `json:"has_api_key"`
	HasCookie          bool   `json:"has_cookie"`
	EmailMasked        string `json:"email_masked"`
}

func (OpenCodeAccount) TableName() string {
	return "opencode_accounts"
}

func CreateOpenCodeAccount(account *OpenCodeAccount, secrets OpenCodeAccountSecrets) error {
	if account == nil {
		return errors.New("opencode account is nil")
	}
	if err := normalizeOpenCodeAccount(account); err != nil {
		return err
	}
	if err := account.EncryptSecrets(secrets); err != nil {
		return err
	}
	return DB.Create(account).Error
}

func UpdateOpenCodeAccount(account *OpenCodeAccount, secrets OpenCodeAccountSecrets) error {
	if account == nil {
		return errors.New("opencode account is nil")
	}
	if err := normalizeOpenCodeAccount(account); err != nil {
		return err
	}
	if err := account.EncryptSecrets(secrets); err != nil {
		return err
	}
	return DB.Save(account).Error
}

func GetOpenCodeAccountById(id int) (*OpenCodeAccount, error) {
	var account OpenCodeAccount
	if err := DB.First(&account, id).Error; err != nil {
		return nil, err
	}
	return &account, nil
}

func GetAllOpenCodeAccounts() ([]*OpenCodeAccount, error) {
	var accounts []*OpenCodeAccount
	err := DB.Order("id asc").Find(&accounts).Error
	return accounts, err
}

func DeleteOpenCodeAccount(id int) error {
	return DB.Delete(&OpenCodeAccount{}, id).Error
}

func (account *OpenCodeAccount) EncryptSecrets(secrets OpenCodeAccountSecrets) error {
	email, err := common.EncryptSecret(strings.TrimSpace(secrets.Email))
	if err != nil {
		return fmt.Errorf("encrypt email: %w", err)
	}
	workspaceID, err := common.EncryptSecret(strings.TrimSpace(secrets.WorkspaceID))
	if err != nil {
		return fmt.Errorf("encrypt workspace id: %w", err)
	}
	apiKey, err := common.EncryptSecret(strings.TrimSpace(secrets.APIKey))
	if err != nil {
		return fmt.Errorf("encrypt api key: %w", err)
	}
	cookie, err := common.EncryptSecret(strings.TrimSpace(secrets.Cookie))
	if err != nil {
		return fmt.Errorf("encrypt cookie: %w", err)
	}
	account.EmailCiphertext = email
	account.WorkspaceIDCiphertext = workspaceID
	account.APIKeyCiphertext = apiKey
	account.CookieCiphertext = cookie
	return nil
}

func (account *OpenCodeAccount) DecryptSecrets() (OpenCodeAccountSecrets, error) {
	email, err := common.DecryptSecret(account.EmailCiphertext)
	if err != nil {
		return OpenCodeAccountSecrets{}, fmt.Errorf("decrypt email: %w", err)
	}
	workspaceID, err := common.DecryptSecret(account.WorkspaceIDCiphertext)
	if err != nil {
		return OpenCodeAccountSecrets{}, fmt.Errorf("decrypt workspace id: %w", err)
	}
	apiKey, err := common.DecryptSecret(account.APIKeyCiphertext)
	if err != nil {
		return OpenCodeAccountSecrets{}, fmt.Errorf("decrypt api key: %w", err)
	}
	cookie, err := common.DecryptSecret(account.CookieCiphertext)
	if err != nil {
		return OpenCodeAccountSecrets{}, fmt.Errorf("decrypt cookie: %w", err)
	}
	return OpenCodeAccountSecrets{
		Email:       email,
		WorkspaceID: workspaceID,
		APIKey:      apiKey,
		Cookie:      cookie,
	}, nil
}

func (account *OpenCodeAccount) PublicView() OpenCodeAccountPublic {
	secrets, _ := account.DecryptSecrets()
	return OpenCodeAccountPublic{
		Id:                 account.Id,
		Label:              account.Label,
		ChannelID:          account.ChannelID,
		QuotaRaw:           account.QuotaRaw,
		QuotaLimit:         account.QuotaLimit,
		QuotaUsed:          account.QuotaUsed,
		LoginStatus:        account.LoginStatus,
		Active:             account.Active,
		LastExtractedAt:    account.LastExtractedAt,
		LastQuotaCheckedAt: account.LastQuotaCheckedAt,
		CreatedAt:          account.CreatedAt.Format(time.RFC3339),
		UpdatedAt:          account.UpdatedAt.Format(time.RFC3339),
		HasEmail:           account.EmailCiphertext != "",
		HasWorkspaceID:     account.WorkspaceIDCiphertext != "",
		HasAPIKey:          account.APIKeyCiphertext != "",
		HasCookie:          account.CookieCiphertext != "",
		EmailMasked:        maskEmail(secrets.Email),
	}
}

func normalizeOpenCodeAccount(account *OpenCodeAccount) error {
	label := strings.ToLower(strings.TrimSpace(account.Label))
	if label == "" {
		return errors.New("label is required")
	}
	if account.ChannelID <= 0 {
		return errors.New("channel id is required")
	}
	for _, c := range label {
		if !((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-') {
			return errors.New("label must contain only lowercase letters, numbers, and hyphens")
		}
	}
	if account.LoginStatus == "" {
		account.LoginStatus = "idle"
	}
	account.Label = label
	return nil
}

func maskEmail(email string) string {
	email = strings.TrimSpace(email)
	if email == "" {
		return ""
	}
	parts := strings.SplitN(email, "@", 2)
	if len(parts) != 2 {
		return "present"
	}
	local := parts[0]
	if local == "" {
		return "***@" + parts[1]
	}
	return local[:1] + "***@" + parts[1]
}
