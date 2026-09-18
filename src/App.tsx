import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LyricLine, RawLyricLine } from './types'

const STORAGE_KEY = 'aura-jingle-lines-v1'
const MIN_LINE_DURATION = 0.1
const WAVEFORM_BUCKETS = 2400
const WAVEFORM_HEIGHT = 140
const DEFAULT_PX_PER_SEC = 90
const MIN_PX_PER_SEC = 20
const MAX_PX_PER_SEC = 400

const AUDIO_SRC = `${import.meta.env.BASE_URL}jingle.mp3`
const TRANSCRIPT_SRC = `${import.meta.env.BASE_URL}transcript.json`

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function fmtTime(t: number): string {
  if (!Number.isFinite(t)) return '0:00.0'
  const m = Math.floor(t / 60)
  const s = t - m * 60
  return `${m}:${s.toFixed(1).padStart(4, '0')}`
}

function rawToLines(raw: RawLyricLine[]): LyricLine[] {
  return raw.map((r, i) => ({ id: i, start: r.start, end: r.end, text: r.text }))
}

type DragMode = 'move' | 'resize-left' | 'resize-right'
interface DragState {
  id: number
  mode: DragMode
  startClientX: number
  originStart: number
  originEnd: number
}

export default function App() {
  const [lines, setLines] = useState<LyricLine[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [pxPerSec, setPxPerSec] = useState(DEFAULT_PX_PER_SEC)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [loopSelected, setLoopSelected] = useState(false)
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle')
  const [showPreview, setShowPreview] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [importText, setImportText] = useState('')
  const [importError, setImportError] = useState<string | null>(null)
  const [waveformReady, setWaveformReady] = useState(false)

  const audioRef = useRef<HTMLAudioElement>(null)
  const visibleCanvasRef = useRef<HTMLCanvasElement>(null)
  const offscreenCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const dragStateRef = useRef<DragState | null>(null)
  const rafRef = useRef<number | null>(null)
  const pastRef = useRef<LyricLine[][]>([])
  const futureRef = useRef<LyricLine[][]>([])
  const draggedRef = useRef(false)
  const rowRefs = useRef<Map<number, HTMLDivElement>>(new Map())

  // ─── Load lines: prefer localStorage, fall back to bundled transcript ───
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as LyricLine[]
        if (Array.isArray(parsed) && parsed.length > 0) {
          setLines(parsed)
          return
        }
      } catch {
        // fall through to fetch
      }
    }
    fetch(TRANSCRIPT_SRC)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((raw: RawLyricLine[]) => setLines(rawToLines(raw)))
      .catch((e) => setLoadError(String(e)))
  }, [])

  // ─── Persist to localStorage on every change ───
  useEffect(() => {
    if (lines) localStorage.setItem(STORAGE_KEY, JSON.stringify(lines))
  }, [lines])

  // ─── Decode audio once for waveform peaks ───
  useEffect(() => {
    let cancelled = false
    async function build() {
      try {
        const res = await fetch(AUDIO_SRC)
        const buf = await res.arrayBuffer()
        const AudioContextCtor =
          window.AudioContext || (window as any).webkitAudioContext
        const ctx = new AudioContextCtor()
        const audioBuffer = await ctx.decodeAudioData(buf.slice(0))
        if (cancelled) return
        const channel = audioBuffer.getChannelData(0)
        const bucketSize = Math.max(1, Math.floor(channel.length / WAVEFORM_BUCKETS))
        const canvas = document.createElement('canvas')
        canvas.width = WAVEFORM_BUCKETS
        canvas.height = WAVEFORM_HEIGHT
        const ctx2d = canvas.getContext('2d')!
        ctx2d.fillStyle = '#0f1420'
        ctx2d.fillRect(0, 0, canvas.width, canvas.height)
        ctx2d.fillStyle = '#5fd0c0'
        const mid = WAVEFORM_HEIGHT / 2
        for (let b = 0; b < WAVEFORM_BUCKETS; b++) {
          const start = b * bucketSize
          let min = 0
          let max = 0
          for (let i = start; i < start + bucketSize && i < channel.length; i++) {
            const v = channel[i]
            if (v < min) min = v
            if (v > max) max = v
          }
          const yTop = mid - max * mid * 0.95
          const yBot = mid - min * mid * 0.95
          ctx2d.fillRect(b, yTop, 1, Math.max(1, yBot - yTop))
        }
        offscreenCanvasRef.current = canvas
        void ctx.close()
        setWaveformReady(true)
      } catch (e) {
        console.error('waveform build failed', e)
      }
    }
    build()
    return () => {
      cancelled = true
    }
  }, [])

  const totalWidth = Math.max(1, Math.ceil(duration * pxPerSec))

  // ─── Draw the visible (zoomed) waveform whenever zoom/duration/data changes ───
  useEffect(() => {
    const canvas = visibleCanvasRef.current
    const offscreen = offscreenCanvasRef.current
    if (!canvas || !offscreen || !waveformReady || duration === 0) return
    canvas.width = totalWidth
    canvas.height = WAVEFORM_HEIGHT
    const ctx = canvas.getContext('2d')!
    ctx.imageSmoothingEnabled = true
    ctx.drawImage(
      offscreen,
      0,
      0,
      offscreen.width,
      offscreen.height,
      0,
      0,
      totalWidth,
      WAVEFORM_HEIGHT,
    )
  }, [totalWidth, waveformReady, duration])

  // ─── Playhead animation loop while playing ───
  useEffect(() => {
    function tick() {
      const audio = audioRef.current
      if (audio) {
        setCurrentTime(audio.currentTime)
        if (loopSelected && selectedId !== null && lines) {
          const line = lines.find((l) => l.id === selectedId)
          if (line && audio.currentTime >= line.end - 0.01) {
            audio.currentTime = line.start
          }
        }
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    if (isPlaying) {
      rafRef.current = requestAnimationFrame(tick)
    }
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, loopSelected, selectedId, lines])

  const recordHistory = useCallback((snapshot: LyricLine[]) => {
    pastRef.current.push(snapshot)
    if (pastRef.current.length > 80) pastRef.current.shift()
    futureRef.current = []
  }, [])

  const undo = useCallback(() => {
    if (pastRef.current.length === 0 || !lines) return
    const prev = pastRef.current.pop()!
    futureRef.current.push(lines)
    setLines(prev)
  }, [lines])

  const redo = useCallback(() => {
    if (futureRef.current.length === 0 || !lines) return
    const next = futureRef.current.pop()!
    pastRef.current.push(lines)
    setLines(next)
  }, [lines])

  // ─── Keyboard shortcuts ───
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName
      const typing = tag === 'INPUT' || tag === 'TEXTAREA'
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
        return
      }
      if (!typing && e.code === 'Space') {
        e.preventDefault()
        togglePlay()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [undo, redo])

  function togglePlay() {
    const audio = audioRef.current
    if (!audio) return
    if (audio.paused) {
      audio.play()
      setIsPlaying(true)
    } else {
      audio.pause()
      setIsPlaying(false)
    }
  }

  function seekTo(t: number) {
    const audio = audioRef.current
    if (!audio) return
    audio.currentTime = Math.max(0, Math.min(duration, t))
    setCurrentTime(audio.currentTime)
  }

  function playFrom(t: number) {
    seekTo(t)
    audioRef.current?.play()
    setIsPlaying(true)
  }

  // ─── Timeline background click-to-seek ───
  function handleTimelineMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    if (draggedRef.current) return
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left + e.currentTarget.scrollLeft
    seekTo(x / pxPerSec)
  }

  const sortedLines = lines // already chronological

  function neighborBounds(id: number): { min: number; max: number } {
    if (!sortedLines) return { min: 0, max: duration }
    const idx = sortedLines.findIndex((l) => l.id === id)
    const prev = sortedLines[idx - 1]
    const next = sortedLines[idx + 1]
    return {
      min: prev ? prev.end : 0,
      max: next ? next.start : duration,
    }
  }

  function handleRegionMouseDown(
    e: React.MouseEvent,
    line: LyricLine,
    mode: DragMode,
  ) {
    e.preventDefault()
    e.stopPropagation()
    setSelectedId(line.id)
    if (!lines) return
    recordHistory(lines)
    draggedRef.current = false
    dragStateRef.current = {
      id: line.id,
      mode,
      startClientX: e.clientX,
      originStart: line.start,
      originEnd: line.end,
    }
    window.addEventListener('mousemove', handleWindowMouseMove)
    window.addEventListener('mouseup', handleWindowMouseUp)
  }

  const handleWindowMouseMove = useCallback((e: MouseEvent) => {
    const drag = dragStateRef.current
    if (!drag) return
    const deltaPx = e.clientX - drag.startClientX
    if (Math.abs(deltaPx) > 2) draggedRef.current = true
    const deltaSec = deltaPx / pxPerSecRef.current
    setLines((prevLines) => {
      if (!prevLines) return prevLines
      const { min, max } = neighborBoundsRef.current(drag.id)
      return prevLines.map((l) => {
        if (l.id !== drag.id) return l
        if (drag.mode === 'move') {
          const span = drag.originEnd - drag.originStart
          let newStart = drag.originStart + deltaSec
          newStart = Math.max(min, Math.min(max - span, newStart))
          return { ...l, start: newStart, end: newStart + span }
        }
        if (drag.mode === 'resize-left') {
          let newStart = drag.originStart + deltaSec
          newStart = Math.max(min, Math.min(drag.originEnd - MIN_LINE_DURATION, newStart))
          return { ...l, start: newStart }
        }
        // resize-right
        let newEnd = drag.originEnd + deltaSec
        newEnd = Math.min(max, Math.max(drag.originStart + MIN_LINE_DURATION, newEnd))
        return { ...l, end: newEnd }
      })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleWindowMouseUp = useCallback(() => {
    dragStateRef.current = null
    window.removeEventListener('mousemove', handleWindowMouseMove)
    window.removeEventListener('mouseup', handleWindowMouseUp)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keep latest pxPerSec / neighborBounds accessible inside the stable mousemove handler
  const pxPerSecRef = useRef(pxPerSec)
  useEffect(() => {
    pxPerSecRef.current = pxPerSec
  }, [pxPerSec])
  const neighborBoundsRef = useRef(neighborBounds)
  useEffect(() => {
    neighborBoundsRef.current = neighborBounds
  })

  function updateLineField(id: number, field: 'start' | 'end', value: number) {
    setLines((prev) => {
      if (!prev) return prev
      return prev.map((l) => (l.id === id ? { ...l, [field]: value } : l))
    })
  }

  function nudge(id: number, field: 'start' | 'end', delta: number) {
    if (!lines) return
    recordHistory(lines)
    const line = lines.find((l) => l.id === id)
    if (!line) return
    const { min, max } = neighborBounds(id)
    if (field === 'start') {
      const v = Math.max(min, Math.min(line.end - MIN_LINE_DURATION, line.start + delta))
      updateLineField(id, 'start', round2(v))
    } else {
      const v = Math.min(max, Math.max(line.start + MIN_LINE_DURATION, line.end + delta))
      updateLineField(id, 'end', round2(v))
    }
  }

  function handleInputCommit(id: number, field: 'start' | 'end', raw: string) {
    const v = parseFloat(raw)
    if (Number.isNaN(v) || !lines) return
    const line = lines.find((l) => l.id === id)
    if (!line) return
    const { min, max } = neighborBounds(id)
    let clamped: number
    if (field === 'start') clamped = Math.max(min, Math.min(line.end - MIN_LINE_DURATION, v))
    else clamped = Math.min(max, Math.max(line.start + MIN_LINE_DURATION, v))
    updateLineField(id, field, round2(clamped))
  }

  function handleInputFocus() {
    if (lines) recordHistory(lines)
  }

  const activeLine = useMemo(() => {
    if (!lines) return null
    return lines.find((l) => currentTime >= l.start && currentTime < l.end) ?? null
  }, [lines, currentTime])

  // Auto-scroll the list to the active line
  useEffect(() => {
    if (!activeLine) return
    const el = rowRefs.current.get(activeLine.id)
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [activeLine])

  function buildExportPayload(): string {
    if (!lines) return '[]'
    return JSON.stringify(
      lines.map((l) => ({ start: round2(l.start), end: round2(l.end), text: l.text })),
      null,
      2,
    )
  }

  async function handleExport() {
    const text = buildExportPayload()
    try {
      await navigator.clipboard.writeText(text)
      setCopyStatus('copied')
    } catch {
      setCopyStatus('error')
    }
    setShowPreview(true)
    setTimeout(() => setCopyStatus('idle'), 2500)
  }

  function handleReset() {
    if (!confirm('Reset all timings back to the original transcript? This discards your edits.')) return
    fetch(TRANSCRIPT_SRC)
      .then((r) => r.json())
      .then((raw: RawLyricLine[]) => {
        if (lines) recordHistory(lines)
        setLines(rawToLines(raw))
      })
  }

  function handleImportLoad() {
    try {
      const parsed = JSON.parse(importText) as RawLyricLine[]
      if (!Array.isArray(parsed)) throw new Error('Expected a JSON array')
      for (const item of parsed) {
        if (typeof item.start !== 'number' || typeof item.end !== 'number' || typeof item.text !== 'string') {
          throw new Error('Each item needs numeric start/end and a text string')
        }
      }
      if (lines) recordHistory(lines)
      setLines(rawToLines(parsed))
      setShowImport(false)
      setImportText('')
      setImportError(null)
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e))
    }
  }

  if (loadError) {
    return <div className="app-error">Failed to load transcript: {loadError}</div>
  }
  if (!lines) {
    return <div className="app-loading">Loading…</div>
  }

  const playheadX = currentTime * pxPerSec

  return (
    <div className="app">
      <audio
        ref={audioRef}
        src={AUDIO_SRC}
        preload="auto"
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => setIsPlaying(false)}
      />

      <header className="topbar">
        <h1>Aura Primera Jingle — Timing Editor</h1>
        <div className="controls">
          <button className="btn primary" onClick={togglePlay}>
            {isPlaying ? '⏸ Pause' : '▶ Play'}
          </button>
          <span className="time-readout">
            {fmtTime(currentTime)} / {fmtTime(duration)}
          </span>
          <label className="loop-toggle">
            <input
              type="checkbox"
              checked={loopSelected}
              onChange={(e) => setLoopSelected(e.target.checked)}
            />
            Loop selected line
          </label>
          <label className="zoom">
            Zoom
            <input
              type="range"
              min={MIN_PX_PER_SEC}
              max={MAX_PX_PER_SEC}
              value={pxPerSec}
              onChange={(e) => setPxPerSec(Number(e.target.value))}
            />
          </label>
          <button className="btn" onClick={() => setShowImport(true)}>
            Import JSON
          </button>
          <button className="btn" onClick={handleReset}>
            Reset to original
          </button>
          <button className="btn export" onClick={handleExport}>
            {copyStatus === 'copied' ? '✓ Copied!' : copyStatus === 'error' ? 'Copy failed — see below' : '📋 Export timings'}
          </button>
        </div>
      </header>

      <p className="hint">
        Drag a lyric block to move it, drag its edges to resize. Click the waveform to seek. Space
        = play/pause. ⌘/Ctrl+Z = undo. Select a line (click it) + "Loop selected line" + Play to
        audition your adjustment live while you drag.
      </p>

      <div className="timeline-scroll">
        <div
          className="timeline"
          style={{ width: totalWidth, height: WAVEFORM_HEIGHT }}
          onMouseDown={handleTimelineMouseDown}
        >
          <canvas ref={visibleCanvasRef} className="waveform-canvas" />
          {!waveformReady && <div className="waveform-loading">Decoding waveform…</div>}
          <div className="playhead" style={{ left: playheadX }} />
          {lines.map((line) => {
            const left = line.start * pxPerSec
            const width = Math.max(2, (line.end - line.start) * pxPerSec)
            const isActive = activeLine?.id === line.id
            const isSelected = selectedId === line.id
            return (
              <div
                key={line.id}
                className={`region${isSelected ? ' selected' : ''}${isActive ? ' active' : ''}`}
                style={{ left, width }}
                onMouseDown={(e) => handleRegionMouseDown(e, line, 'move')}
                onClick={(e) => {
                  e.stopPropagation()
                  if (!draggedRef.current) setSelectedId(line.id)
                }}
                title={line.text}
              >
                <div
                  className="handle handle-left"
                  onMouseDown={(e) => handleRegionMouseDown(e, line, 'resize-left')}
                />
                <span className="region-label">{line.text}</span>
                <div
                  className="handle handle-right"
                  onMouseDown={(e) => handleRegionMouseDown(e, line, 'resize-right')}
                />
              </div>
            )
          })}
        </div>
      </div>

      <div className="line-list">
        {lines.map((line, idx) => {
          const isActive = activeLine?.id === line.id
          const isSelected = selectedId === line.id
          return (
            <div
              key={line.id}
              ref={(el) => {
                if (el) rowRefs.current.set(line.id, el)
                else rowRefs.current.delete(line.id)
              }}
              className={`line-row${isSelected ? ' selected' : ''}${isActive ? ' active' : ''}`}
              onClick={() => setSelectedId(line.id)}
            >
              <span className="idx">{idx + 1}</span>
              <button className="btn tiny" onClick={() => playFrom(line.start)} title="Play from here">
                ▶
              </button>
              <span className="text">{line.text}</span>
              <div className="field">
                <button className="btn tiny" onClick={() => nudge(line.id, 'start', -0.1)}>
                  −
                </button>
                <input
                  type="number"
                  step={0.01}
                  value={round2(line.start)}
                  onFocus={handleInputFocus}
                  onChange={(e) => updateLineField(line.id, 'start', parseFloat(e.target.value))}
                  onBlur={(e) => handleInputCommit(line.id, 'start', e.target.value)}
                />
                <button className="btn tiny" onClick={() => nudge(line.id, 'start', 0.1)}>
                  +
                </button>
              </div>
              <span className="arrow">→</span>
              <div className="field">
                <button className="btn tiny" onClick={() => nudge(line.id, 'end', -0.1)}>
                  −
                </button>
                <input
                  type="number"
                  step={0.01}
                  value={round2(line.end)}
                  onFocus={handleInputFocus}
                  onChange={(e) => updateLineField(line.id, 'end', parseFloat(e.target.value))}
                  onBlur={(e) => handleInputCommit(line.id, 'end', e.target.value)}
                />
                <button className="btn tiny" onClick={() => nudge(line.id, 'end', 0.1)}>
                  +
                </button>
              </div>
              <span className="dur">{(line.end - line.start).toFixed(2)}s</span>
            </div>
          )
        })}
      </div>

      {showPreview && (
        <div className="modal-backdrop" onClick={() => setShowPreview(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Exported timings JSON</h2>
            <p>
              {copyStatus === 'copied'
                ? 'Copied to your clipboard — paste it back to Claude.'
                : 'Clipboard copy failed (browser permissions) — select all and copy manually below.'}
            </p>
            <textarea readOnly value={buildExportPayload()} onFocus={(e) => e.currentTarget.select()} />
            <button className="btn primary" onClick={() => setShowPreview(false)}>
              Close
            </button>
          </div>
        </div>
      )}

      {showImport && (
        <div className="modal-backdrop" onClick={() => setShowImport(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Import timings JSON</h2>
            <p>Paste a previously exported JSON array to continue editing it.</p>
            <textarea
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              placeholder='[{"start": 14.34, "end": 22.36, "text": "..."}, ...]'
            />
            {importError && <p className="error-text">{importError}</p>}
            <div className="modal-actions">
              <button className="btn" onClick={() => setShowImport(false)}>
                Cancel
              </button>
              <button className="btn primary" onClick={handleImportLoad}>
                Load
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
