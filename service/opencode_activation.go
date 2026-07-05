package service

import (
	"errors"
	"strings"

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
			return err
		}
		if err := tx.Model(&model.Channel{}).
			Where("id = ?", account.ChannelID).
			Update("key", apiKey).Error; err != nil {
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
