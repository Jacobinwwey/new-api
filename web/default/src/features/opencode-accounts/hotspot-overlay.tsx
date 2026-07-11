import { useEffect, useRef, useState } from 'react'

import {
  mapRemoteHotspotToContainedScreenshotRect,
  type OpenCodeLoginHotspot,
  type OpenCodeLoginScreenshotImage,
} from './lib'

type OpenCodeHotspotOverlayProps = {
  hotspot: OpenCodeLoginHotspot
  screenshot: OpenCodeLoginScreenshotImage
  onClick: (hotspot: OpenCodeLoginHotspot) => void
}

export function OpenCodeHotspotOverlay(
  props: OpenCodeHotspotOverlayProps
) {
  const { hotspot, screenshot, onClick } = props
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const [style, setStyle] = useState<{
    left: number
    top: number
    width: number
    height: number
  } | null>(null)

  useEffect(() => {
    const button = buttonRef.current
    if (!button) return
    const container = button.parentElement
    if (!container) return
    const update = () => {
      setStyle(
        mapRemoteHotspotToContainedScreenshotRect(
          hotspot,
          {
            left: 0,
            top: 0,
            width: container.clientWidth,
            height: container.clientHeight,
          },
          { width: screenshot.width, height: screenshot.height }
        )
      )
    }
    update()
    const resizeObserver = new ResizeObserver(update)
    resizeObserver.observe(container)
    return () => resizeObserver.disconnect()
  }, [hotspot, screenshot.height, screenshot.width])

  const measured = style !== null
  return (
    <button
      ref={buttonRef}
      type='button'
      className='absolute z-10 overflow-hidden rounded-md border-2 border-amber-400/90 bg-amber-400/12 text-[11px] font-medium text-amber-950 shadow-sm backdrop-blur-[1px] transition hover:bg-amber-300/20'
      style={style ?? { visibility: 'hidden', pointerEvents: 'none' }}
      disabled={!measured}
      tabIndex={measured ? 0 : -1}
      aria-hidden={!measured}
      onPointerUp={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation()
        onClick(hotspot)
      }}
      title={hotspot.label}
    >
      <span className='pointer-events-none absolute inset-x-0 top-0 truncate bg-amber-400/85 px-1 py-0.5 text-left text-[10px] leading-none text-black'>
        {hotspot.label}
      </span>
    </button>
  )
}
