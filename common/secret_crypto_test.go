package common

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestEncryptSecretRoundTrip(t *testing.T) {
	originalSecret := CryptoSecret
	CryptoSecret = "test-secret-key-for-opencode-account-storage"
	t.Cleanup(func() {
		CryptoSecret = originalSecret
	})

	ciphertext, err := EncryptSecret("opencode-account-material")
	require.NoError(t, err)

	assert.True(t, strings.HasPrefix(ciphertext, "v1:"))
	assert.NotContains(t, ciphertext, "opencode-account-material")

	plaintext, err := DecryptSecret(ciphertext)
	require.NoError(t, err)
	assert.Equal(t, "opencode-account-material", plaintext)
}

func TestEncryptSecretEmptyValueStaysEmpty(t *testing.T) {
	ciphertext, err := EncryptSecret("")
	require.NoError(t, err)
	assert.Empty(t, ciphertext)

	plaintext, err := DecryptSecret("")
	require.NoError(t, err)
	assert.Empty(t, plaintext)
}

func TestDecryptSecretFailsClosedWithWrongKey(t *testing.T) {
	originalSecret := CryptoSecret
	CryptoSecret = "first-test-secret-key"
	ciphertext, err := EncryptSecret("sensitive")
	require.NoError(t, err)
	t.Cleanup(func() {
		CryptoSecret = originalSecret
	})

	CryptoSecret = "second-test-secret-key"
	plaintext, err := DecryptSecret(ciphertext)
	require.Error(t, err)
	assert.Empty(t, plaintext)
}
