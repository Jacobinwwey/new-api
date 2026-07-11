import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { OpenCodeHotspotOverlay } from './hotspot-overlay'

describe('OpenCode hotspot overlay', () => {
  test('mounts an inert button before client layout is measured', () => {
    const html = renderToStaticMarkup(
      createElement(OpenCodeHotspotOverlay, {
        hotspot: {
          id: 'google-fixture',
          label: 'Continue with Google',
          provider: 'google',
          x: 450,
          y: 446,
          width: 380,
          height: 40,
        },
        screenshot: {
          imageBase64: 'fixture',
          width: 1279,
          height: 812,
          hotspots: [],
        },
        onClick() {},
      })
    )

    assert.match(html, /^<button/)
    assert.match(html, /visibility:hidden/)
    assert.match(html, /pointer-events:none/)
    assert.match(html, /disabled=""/)
    assert.match(html, /Continue with Google/)
  })
})
