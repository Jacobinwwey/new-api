package service

import (
	"errors"
	"fmt"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"gorm.io/gorm"
)

func ActivateOpenCodeAccount(accountID int) (*model.OpenCodeAccount, error) {
	account, err := model.GetOpenCodeAccountById(accountID)
	if err != nil {
		return nil, err
	}
	secrets, err := account.DecryptSecrets()
	if err != nil {
		return nil, err
	}
	apiKey := strings.TrimSpace(secrets.APIKey)
	if apiKey == "" {
		return nil, errors.New("opencode account api key is required")
	}
	if account.ChannelID <= 0 {
		return nil, errors.New("opencode account channel id is required")
	}

	err = model.DB.Transaction(func(tx *gorm.DB) error {
		var channel model.Channel
		if err := tx.First(&channel, account.ChannelID).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return errors.New("opencode account channel not found")
			}
			return err
		}
		channelKey, err := buildOpenCodeChannelCredential(channel, secrets)
		if err != nil {
			return err
		}
		if err := tx.Model(&model.Channel{}).
			Where("id = ?", account.ChannelID).
			Update("key", channelKey).Error; err != nil {
			return err
		}
		if err := tx.Model(&model.OpenCodeAccount{}).
			Where("active = ?", true).
			Update("active", false).Error; err != nil {
			return err
		}
		if err := tx.Model(&model.OpenCodeAccount{}).
			Where("id = ?", account.Id).
			Update("active", true).Error; err != nil {
			return err
		}
		account.Active = true
		return nil
	})
	if err != nil {
		return nil, err
	}
	model.InitChannelCache()
	return account, nil
}

func GetOpenCodeActivationMissingFields(account *model.OpenCodeAccount) []string {
	if account == nil || model.DB == nil || account.ChannelID <= 0 {
		return nil
	}
	secrets, err := account.DecryptSecrets()
	if err != nil || strings.TrimSpace(secrets.APIKey) == "" {
		return nil
	}
	channel, err := model.GetChannelById(account.ChannelID, true)
	if err != nil || channel == nil {
		return []string{"channel"}
	}
	if channel.Type == constant.ChannelTypeCodex {
		if err := validateCodexOAuthCredential(secrets.APIKey); err != nil {
			return []string{"codex_oauth_key"}
		}
	}
	return nil
}

func buildOpenCodeChannelCredential(channel model.Channel, secrets model.OpenCodeAccountSecrets) (string, error) {
	apiKey := strings.TrimSpace(secrets.APIKey)
	if apiKey == "" {
		return "", errors.New("opencode account api key is required")
	}
	if channel.Type != constant.ChannelTypeCodex {
		return apiKey, nil
	}
	if err := validateCodexOAuthCredential(apiKey); err != nil {
		return "", fmt.Errorf("Codex channel credential is incompatible with extracted OpenCode material: %w", err)
	}
	return apiKey, nil
}

func validateCodexOAuthCredential(raw string) error {
	if !strings.HasPrefix(strings.TrimSpace(raw), "{") {
		return errors.New("key must be a JSON object with access_token and account_id")
	}
	var keyMap map[string]any
	if err := common.Unmarshal([]byte(raw), &keyMap); err != nil {
		return errors.New("key must be a valid JSON object with access_token and account_id")
	}
	if fieldIsBlank(keyMap, "access_token") {
		return errors.New("key JSON must include access_token")
	}
	if fieldIsBlank(keyMap, "account_id") {
		return errors.New("key JSON must include account_id")
	}
	return nil
}

func fieldIsBlank(values map[string]any, field string) bool {
	value, ok := values[field]
	if !ok || value == nil {
		return true
	}
	return strings.TrimSpace(fmt.Sprintf("%v", value)) == ""
}
