package service

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/common"
)

const (
	openCodeAutoSyncPollInterval   = 2 * time.Second
	openCodeAutoSyncOperationLimit = 60 * time.Second
	openCodeAutoSyncSessionLimit   = 30 * time.Minute
	openCodeAutoSyncMaxAttempts    = 5
)

type openCodeLoginStatusLoader func(context.Context, int) (OpenCodeLoginSessionStatus, error)
type openCodeAccountSynchronizer func(context.Context, int) error
type openCodeAutoSyncDelay func(context.Context, time.Duration) bool

type openCodeTrackedSession struct {
	startedAt int64
	cancel    context.CancelFunc
}

type openCodeAutoSyncCoordinator struct {
	mutex       sync.Mutex
	sessions    map[int]openCodeTrackedSession
	loadStatus  openCodeLoginStatusLoader
	synchronize openCodeAccountSynchronizer
	wait        openCodeAutoSyncDelay
}

var openCodeAccountAutoSync = newOpenCodeAutoSyncCoordinator(
	loadOpenCodeLoginSessionStatus,
	func(ctx context.Context, accountID int) error {
		_, err := SyncOpenCodeAccount(ctx, accountID)
		return err
	},
	waitForOpenCodeAutoSyncDelay,
)

func newOpenCodeAutoSyncCoordinator(
	loadStatus openCodeLoginStatusLoader,
	synchronize openCodeAccountSynchronizer,
	wait openCodeAutoSyncDelay,
) *openCodeAutoSyncCoordinator {
	return &openCodeAutoSyncCoordinator{
		sessions:    make(map[int]openCodeTrackedSession),
		loadStatus:  loadStatus,
		synchronize: synchronize,
		wait:        wait,
	}
}

func (coordinator *openCodeAutoSyncCoordinator) track(status OpenCodeLoginSessionStatus) {
	if !isTrackableOpenCodeLoginSession(status) {
		return
	}
	coordinator.mutex.Lock()
	if current, exists := coordinator.sessions[status.AccountID]; exists {
		if current.startedAt == status.StartedAt {
			coordinator.mutex.Unlock()
			return
		}
		if current.cancel != nil {
			current.cancel()
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), openCodeAutoSyncSessionLimit)
	coordinator.sessions[status.AccountID] = openCodeTrackedSession{
		startedAt: status.StartedAt,
		cancel:    cancel,
	}
	coordinator.mutex.Unlock()

	go coordinator.run(ctx, status)
}

func (coordinator *openCodeAutoSyncCoordinator) stop(accountID int) {
	coordinator.mutex.Lock()
	defer coordinator.mutex.Unlock()
	if session, exists := coordinator.sessions[accountID]; exists {
		if session.cancel != nil {
			session.cancel()
		}
		delete(coordinator.sessions, accountID)
	}
}

func (coordinator *openCodeAutoSyncCoordinator) stopAll() {
	coordinator.mutex.Lock()
	defer coordinator.mutex.Unlock()
	for accountID, session := range coordinator.sessions {
		if session.cancel != nil {
			session.cancel()
		}
		delete(coordinator.sessions, accountID)
	}
}

func (coordinator *openCodeAutoSyncCoordinator) run(ctx context.Context, initialStatus OpenCodeLoginSessionStatus) {
	defer coordinator.finish(initialStatus.AccountID, initialStatus.StartedAt)
	status := initialStatus
	syncAttempts := 0
	for {
		if status.Page == "keys" {
			attemptContext, cancel := context.WithTimeout(ctx, openCodeAutoSyncOperationLimit)
			err := coordinator.synchronize(attemptContext, status.AccountID)
			cancel()
			if err == nil {
				common.SysLog(fmt.Sprintf("OpenCode account %d synchronized automatically", status.AccountID))
				return
			}
			syncAttempts++
			if syncAttempts >= openCodeAutoSyncMaxAttempts {
				common.SysError(fmt.Sprintf("OpenCode automatic synchronization exhausted retries for account %d", status.AccountID))
				return
			}
			common.SysError(fmt.Sprintf("OpenCode automatic synchronization will retry for account %d", status.AccountID))
			if !coordinator.wait(ctx, openCodeAutoSyncRetryDelay(syncAttempts)) {
				return
			}
		} else if !coordinator.wait(ctx, openCodeAutoSyncPollInterval) {
			return
		}

		loadContext, cancel := context.WithTimeout(ctx, openCodeAutoSyncOperationLimit)
		nextStatus, err := coordinator.loadStatus(loadContext, status.AccountID)
		cancel()
		if err != nil {
			continue
		}
		if !sameOpenCodeLoginSession(initialStatus, nextStatus) {
			return
		}
		status = nextStatus
	}
}

func (coordinator *openCodeAutoSyncCoordinator) finish(accountID int, startedAt int64) {
	coordinator.mutex.Lock()
	defer coordinator.mutex.Unlock()
	if current, exists := coordinator.sessions[accountID]; exists && current.startedAt == startedAt {
		if current.cancel != nil {
			current.cancel()
		}
		coordinator.sessions[accountID] = openCodeTrackedSession{startedAt: startedAt}
	}
}

func sameOpenCodeLoginSession(expected OpenCodeLoginSessionStatus, actual OpenCodeLoginSessionStatus) bool {
	return isTrackableOpenCodeLoginSession(actual) &&
		actual.AccountID == expected.AccountID &&
		actual.StartedAt == expected.StartedAt &&
		expected.AccountID > 0 &&
		expected.StartedAt > 0
}

func isTrackableOpenCodeLoginSession(status OpenCodeLoginSessionStatus) bool {
	return status.AccountID > 0 &&
		status.StartedAt > 0 &&
		status.Running &&
		status.Status == "running"
}

func openCodeAutoSyncRetryDelay(failedAttempts int) time.Duration {
	delay := 5 * time.Second
	for attempt := 1; attempt < failedAttempts && delay < time.Minute; attempt++ {
		delay *= 2
	}
	if delay > time.Minute {
		return time.Minute
	}
	return delay
}

func waitForOpenCodeAutoSyncDelay(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
