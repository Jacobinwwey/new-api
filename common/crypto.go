package common

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"strings"

	"golang.org/x/crypto/bcrypt"
)

const secretCiphertextVersion = "v1:"

const (
	SecretEncryptionKeySourceCryptoSecret          = "crypto_secret"
	SecretEncryptionKeySourceSessionSecretFallback = "session_secret_fallback"
)

func GenerateHMACWithKey(key []byte, data string) string {
	h := hmac.New(sha256.New, key)
	h.Write([]byte(data))
	return hex.EncodeToString(h.Sum(nil))
}

func GenerateHMAC(data string) string {
	h := hmac.New(sha256.New, []byte(CryptoSecret))
	h.Write([]byte(data))
	return hex.EncodeToString(h.Sum(nil))
}

func EncryptSecret(plaintext string) (string, error) {
	if plaintext == "" {
		return "", nil
	}
	block, err := aes.NewCipher(secretEncryptionKey())
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	sealed := gcm.Seal(nonce, nonce, []byte(plaintext), nil)
	return secretCiphertextVersion + base64.StdEncoding.EncodeToString(sealed), nil
}

func DecryptSecret(ciphertext string) (string, error) {
	if ciphertext == "" {
		return "", nil
	}
	if !strings.HasPrefix(ciphertext, secretCiphertextVersion) {
		return "", errors.New("unsupported secret ciphertext version")
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(ciphertext, secretCiphertextVersion))
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(secretEncryptionKey())
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(raw) < gcm.NonceSize() {
		return "", errors.New("invalid secret ciphertext")
	}
	nonce := raw[:gcm.NonceSize()]
	payload := raw[gcm.NonceSize():]
	plaintext, err := gcm.Open(nil, nonce, payload, nil)
	if err != nil {
		return "", err
	}
	return string(plaintext), nil
}

func secretEncryptionKey() []byte {
	sum := sha256.Sum256([]byte(CryptoSecret))
	return sum[:]
}

func SecretEncryptionKeySource() string {
	if strings.TrimSpace(os.Getenv("CRYPTO_SECRET")) != "" {
		return SecretEncryptionKeySourceCryptoSecret
	}
	return SecretEncryptionKeySourceSessionSecretFallback
}

func Password2Hash(password string) (string, error) {
	passwordBytes := []byte(password)
	hashedPassword, err := bcrypt.GenerateFromPassword(passwordBytes, bcrypt.DefaultCost)
	return string(hashedPassword), err
}

func ValidatePasswordAndHash(password string, hash string) bool {
	err := bcrypt.CompareHashAndPassword([]byte(hash), []byte(password))
	return err == nil
}
