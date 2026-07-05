package service

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestBuildOpenCodeAuthCommandSpecPassesKeyTextThroughStdin(t *testing.T) {
	spec := buildOpenCodeAuthCommandSpec("sidecar.mjs", "key", 7, "state-dir", "secret-login-text")

	assert.NotContains(t, spec.args, "secret-login-text")
	assert.NotContains(t, strings.Join(spec.args, "\x00"), "secret-login-text")
	assert.Equal(t, "secret-login-text", spec.stdin)
}
