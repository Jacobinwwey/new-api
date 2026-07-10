package service

import (
	"context"
	"math"
	"sync"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
)

type openCodeBrowserStateLoader func(context.Context, int) (OpenCodeBrowserState, error)
type openCodeGoQuotaLoader func(context.Context, string, string) (OpenCodeGoQuotaSnapshot, error)

var (
	openCodeBrowserStateSyncMutex  sync.Mutex
	openCodeSyncBrowserStateLoader openCodeBrowserStateLoader = SyncOpenCodeBrowserState
	openCodeSyncQuotaLoader        openCodeGoQuotaLoader      = FetchOpenCodeGoQuota
)

func SyncOpenCodeAccount(ctx context.Context, accountID int) (*model.OpenCodeAccount, error) {
	return syncOpenCodeAccount(ctx, accountID, loadOpenCodeBrowserStateExclusively, openCodeSyncQuotaLoader)
}

func loadOpenCodeBrowserStateExclusively(ctx context.Context, accountID int) (OpenCodeBrowserState, error) {
	openCodeBrowserStateSyncMutex.Lock()
	defer openCodeBrowserStateSyncMutex.Unlock()
	return openCodeSyncBrowserStateLoader(ctx, accountID)
}

func syncOpenCodeAccount(
	ctx context.Context,
	accountID int,
	loadBrowserState openCodeBrowserStateLoader,
	loadQuota openCodeGoQuotaLoader,
) (*model.OpenCodeAccount, error) {
	account, err := model.GetOpenCodeAccountById(accountID)
	if err != nil {
		return nil, err
	}
	state, err := loadBrowserState(ctx, accountID)
	if err != nil {
		return nil, err
	}
	extracted, err := ExtractOpenCodeSecretsFromBrowserState(state)
	if err != nil {
		return nil, err
	}
	existing, err := account.DecryptSecrets()
	if err != nil {
		return nil, err
	}
	secrets := mergeOpenCodeAccountSecrets(existing, extracted.Secrets)
	account.LastExtractedAt = common.GetTimestamp()
	if snapshot, quotaErr := loadQuota(ctx, secrets.WorkspaceID, secrets.Cookie); quotaErr == nil {
		if err := applyOpenCodeGoQuotaSnapshot(account, snapshot); err != nil {
			return nil, err
		}
		account.LastQuotaCheckedAt = common.GetTimestamp()
	}
	if err := model.UpdateOpenCodeAccount(account, secrets); err != nil {
		return nil, err
	}
	return ActivateOpenCodeAccount(accountID)
}

func mergeOpenCodeAccountSecrets(existing model.OpenCodeAccountSecrets, extracted model.OpenCodeAccountSecrets) model.OpenCodeAccountSecrets {
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

func applyOpenCodeGoQuotaSnapshot(account *model.OpenCodeAccount, snapshot OpenCodeGoQuotaSnapshot) error {
	raw, err := common.Marshal(snapshot)
	if err != nil {
		return err
	}
	account.QuotaRaw = string(raw)
	if snapshot.Rolling == nil {
		account.QuotaLimit = 0
		account.QuotaUsed = 0
		return nil
	}
	account.QuotaLimit = 100
	account.QuotaUsed = int64(math.Round(snapshot.Rolling.UsagePercent))
	return nil
}
