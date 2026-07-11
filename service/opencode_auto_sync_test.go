package service

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestOpenCodeAutoSyncSynchronizesKeyPageWithoutAnotherStatusRequest(t *testing.T) {
	synchronized := make(chan int, 1)
	coordinator := newOpenCodeAutoSyncCoordinator(
		func(context.Context, int) (OpenCodeLoginSessionStatus, error) {
			return OpenCodeLoginSessionStatus{}, errors.New("status should not be reloaded for an initial key page")
		},
		func(_ context.Context, accountID int) error {
			synchronized <- accountID
			return nil
		},
		func(context.Context, time.Duration) bool { return true },
	)
	t.Cleanup(coordinator.stopAll)

	coordinator.track(OpenCodeLoginSessionStatus{
		AccountID: 7,
		Running:   true,
		Status:    "running",
		Page:      "keys",
		StartedAt: 1_784_300_000,
	})

	select {
	case accountID := <-synchronized:
		assert.Equal(t, 7, accountID)
	case <-time.After(time.Second):
		t.Fatal("automatic synchronization was not started")
	}
}

func TestOpenCodeAutoSyncDeduplicatesTheSameBrowserSession(t *testing.T) {
	var attempts atomic.Int32
	release := make(chan struct{})
	synchronized := make(chan struct{}, 2)
	coordinator := newOpenCodeAutoSyncCoordinator(
		func(context.Context, int) (OpenCodeLoginSessionStatus, error) {
			return OpenCodeLoginSessionStatus{}, errors.New("status should not be reloaded for an initial key page")
		},
		func(context.Context, int) error {
			attempts.Add(1)
			synchronized <- struct{}{}
			<-release
			return nil
		},
		func(context.Context, time.Duration) bool { return true },
	)
	t.Cleanup(coordinator.stopAll)
	status := OpenCodeLoginSessionStatus{
		AccountID: 7,
		Running:   true,
		Status:    "running",
		Page:      "keys",
		StartedAt: 1_784_300_000,
	}

	coordinator.track(status)
	coordinator.track(status)
	require.Eventually(t, func() bool { return len(synchronized) == 1 }, time.Second, 10*time.Millisecond)
	assert.Equal(t, int32(1), attempts.Load())
	close(release)
}

func TestOpenCodeAutoSyncDoesNotRestartACompletedBrowserSession(t *testing.T) {
	var attempts atomic.Int32
	completed := make(chan struct{}, 2)
	coordinator := newOpenCodeAutoSyncCoordinator(
		func(context.Context, int) (OpenCodeLoginSessionStatus, error) {
			return OpenCodeLoginSessionStatus{}, errors.New("status should not be reloaded for an initial key page")
		},
		func(context.Context, int) error {
			attempts.Add(1)
			completed <- struct{}{}
			return nil
		},
		func(context.Context, time.Duration) bool { return true },
	)
	t.Cleanup(coordinator.stopAll)
	status := OpenCodeLoginSessionStatus{
		AccountID: 8,
		Running:   true,
		Status:    "running",
		Page:      "keys",
		StartedAt: 1_784_300_002,
	}

	coordinator.track(status)
	select {
	case <-completed:
	case <-time.After(time.Second):
		t.Fatal("initial automatic synchronization did not complete")
	}
	require.Eventually(t, func() bool {
		coordinator.mutex.Lock()
		defer coordinator.mutex.Unlock()
		session, exists := coordinator.sessions[status.AccountID]
		return !exists || session.cancel == nil
	}, time.Second, 10*time.Millisecond)

	coordinator.track(status)
	time.Sleep(50 * time.Millisecond)
	assert.Equal(t, int32(1), attempts.Load())
}

func TestOpenCodeAutoSyncWaitsForKeyPageAndRetriesTransientFailure(t *testing.T) {
	var statusLoads atomic.Int32
	var syncAttempts atomic.Int32
	synchronized := make(chan struct{}, 1)
	coordinator := newOpenCodeAutoSyncCoordinator(
		func(context.Context, int) (OpenCodeLoginSessionStatus, error) {
			statusLoads.Add(1)
			return OpenCodeLoginSessionStatus{
				AccountID: 9,
				Running:   true,
				Status:    "running",
				Page:      "keys",
				StartedAt: 1_784_300_001,
			}, nil
		},
		func(context.Context, int) error {
			if syncAttempts.Add(1) == 1 {
				return errors.New("transient quota failure")
			}
			synchronized <- struct{}{}
			return nil
		},
		func(context.Context, time.Duration) bool { return true },
	)
	t.Cleanup(coordinator.stopAll)

	coordinator.track(OpenCodeLoginSessionStatus{
		AccountID: 9,
		Running:   true,
		Status:    "running",
		Page:      "auth",
		StartedAt: 1_784_300_001,
	})

	select {
	case <-synchronized:
		assert.Equal(t, int32(2), statusLoads.Load())
		assert.Equal(t, int32(2), syncAttempts.Load())
	case <-time.After(time.Second):
		t.Fatal("automatic synchronization did not retry")
	}
}
