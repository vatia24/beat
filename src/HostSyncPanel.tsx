import { useEffect, useMemo, useRef, useState } from 'react'
import type { RoomSnapshot } from './protocol'
import {
  interDeviceEstimateMs,
  signedErrorMs,
  type StoredSample,
  type TimingMethod,
} from './sync-diagnostics'

const timingLabels: Record<TimingMethod, string> = {
  timestamp: 'გამომავალი დრო',
  latency: 'დაყოვნების შეფასება',
  unavailable: 'უცნობი',
}

const stateLabels: Record<string, string> = {
  LOADING: 'იტვირთება',
  DECODING: 'იშიფრება',
  LOCKED: 'ხმა ჩართე',
  INTERRUPTED: 'გაჩერებული',
  HIDDEN: 'ფონური რეჟიმი',
  WAITING: 'საათი',
  READY: 'მზადაა',
  PAUSED: 'პაუზა',
  SCHEDULED: 'სტარტი',
  PLAYING: 'უკრავს',
  ENDED: 'დასრულდა',
  ERROR: 'შეცდომა',
}

const waitLabels = { decode: 'ფაილის მომზადება', audio: 'ხმის ჩართვა', clock: 'საათის სინქრონიზაცია' }

function msText(value: number | null) {
  if (value === null || !Number.isFinite(value)) return '—'
  return (value > 0 ? '+' : '') + Math.round(value) + ' ms'
}

interface Props {
  room: RoomSnapshot
  roster: { participantId: string; role: 'host' | 'guest' }[]
  samples: Map<string, StoredSample>
  nowMs: number | null
}

export default function HostSyncPanel({ room, roster, samples, nowMs }: Props) {
  const [open, setOpen] = useState(false)
  const [measurements, setMeasurements] = useState({ total: 0, errors: [] as number[] })
  const latest = useRef({ room, roster, samples, nowMs })
  latest.current = { room, roster, samples, nowMs }
  useEffect(() => { setMeasurements({ total: 0, errors: [] }) }, [room.file?.id, room.version])
  useEffect(() => {
    const timer = window.setInterval(() => {
      const { room, roster, samples, nowMs } = latest.current
      if (nowMs === null || !room.playing) return
      const candidates = roster.map(member => samples.get(member.participantId)).filter((s): s is StoredSample =>
        !!s && s.payload.state === 'PLAYING' && s.payload.version === room.version &&
        nowMs - s.receivedAt <= 8000 && signedErrorMs(room, s.payload, s.sampleServerMs) !== null)
      if (candidates.length < 2) return
      const [a, b] = candidates
      const estimate = interDeviceEstimateMs(room, a, b, nowMs)
      if (estimate.deltaMs === null) return
      const qualified = nowMs >= room.anchorServerMs + 10000 &&
        a.payload.timingMethod === 'timestamp' && b.payload.timingMethod === 'timestamp'
      setMeasurements(old => ({ total: old.total + 1,
        errors: qualified ? [...old.errors, Math.abs(estimate.deltaMs!)] : old.errors }))
    }, 5000)
    return () => window.clearInterval(timer)
  }, [])
  const ranked = [...measurements.errors].sort((a, b) => a - b)
  const p95 = ranked.length ? ranked[Math.ceil(0.95 * ranked.length) - 1] : null
  const rows = useMemo(() => {
    return roster.map(member => {
      const stored = samples.get(member.participantId)
      const payload = stored?.payload
      const err = payload && stored ? signedErrorMs(room, payload, stored.sampleServerMs, false) : null
      const residual = payload && stored ? signedErrorMs(room, payload, stored.sampleServerMs, true) : null
      return { member, stored, payload, err, residual }
    })
  }, [roster, samples, room])

  const pairs = useMemo(() => {
    const eligible = rows.filter(r => r.payload?.state === 'PLAYING' && r.err !== null)
    if (eligible.length < 2) return null
    const a = eligible[0]!.stored!
    const b = eligible[1]!.stored!
    return nowMs === null ? null : interDeviceEstimateMs(room, a, b, nowMs)
  }, [rows, room, nowMs])
  const ageSeconds = (sample?: StoredSample) => sample && nowMs !== null
    ? Math.max(0, (nowMs - (sample.sampleServerMs ?? sample.receivedAt)) / 1000) : null

  return (
    <section className="panel sync-panel">
      <button type="button" className="sync-toggle" onClick={() => setOpen(v => !v)} aria-expanded={open}>
        <h2 className="panel-title">მონაწილეთა სინქრონიზაცია</h2>
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <>
          <p className="status-note">
            ზომვები მხოლოდ საჩვენებლადაა და არა მართავს სხვა ტელეფონებს. აცდენის შედარება თითოეული
            მოწყობილობის საკუთარ დროზე ხდება.
          </p>
          <div className="sync-table" role="table">
            <div className="sync-head" role="row">
              <span role="columnheader">მონაწილე</span>
              <span role="columnheader">მდგომარეობა</span>
              <span role="columnheader">პოზიცია</span>
              <span role="columnheader">შეფასებული აცდენა</span>
              <span role="columnheader">დარჩენილი აცდენა</span>
              <span role="columnheader">საათი</span>
              <span role="columnheader">გამომავალი</span>
            </div>
            {rows.map(({ member, stored, payload, err, residual }) => (
              <div key={member.participantId} className="sync-row" role="row">
                <span role="cell">
                  {member.role === 'host' ? 'მასპინძელი' : 'სტუმარი'} ({member.participantId.slice(0, 4)})
                </span>
                <span role="cell">
                  {ageSeconds(stored) !== null && ageSeconds(stored)! > 8 ? 'მოძველებული' : !payload
                    ? 'კავშირს ელოდება'
                  : payload.waitFor && !payload.startReady
                      ? waitLabels[payload.waitFor]
                      : (stateLabels[payload.state] ?? payload.state)}
                </span>
                <span role="cell">
                  {payload?.mediaSec === null || payload?.mediaSec === undefined
                    ? '—'
                    : payload.mediaSec.toFixed(1) + ' წმ'}
                </span>
                <span role="cell">{ageSeconds(stored) !== null && ageSeconds(stored)! <= 8 ? msText(err) : '-'}</span>
                <span role="cell">{ageSeconds(stored) !== null && ageSeconds(stored)! <= 8 ? msText(residual) : '-'}</span>
                <span role="cell">{payload?.clockFresh ? 'ახალი' : 'მოძველებული'}</span>
                <span role="cell">
                  {payload ? timingLabels[payload.timingMethod] : '—'}
                  {payload && ` · ${(payload.playbackRate * 100).toFixed(2)}%`}
                  {ageSeconds(stored) !== null && ` · ${ageSeconds(stored)!.toFixed(1)} წმ`}
                  {payload && payload.manualOffsetMs !== 0 && ` · გასწ. ${msText(payload.manualOffsetMs)}`}
                </span>
              </div>
            ))}
          </div>
          <p className="status-note">შეფასებული სხვაობის 95-ე პროცენტილი: {msText(p95)} · შესაფერისი {measurements.errors.length} / {measurements.total} შემოწმებიდან</p>
          <button type="button" className="btn btn-secondary" onClick={() => setMeasurements({ total: 0, errors: [] })}>გაზომვის განულება</button>
          {pairs && (
            <p className="status-note">
              ორ მოწყობილობას შორის სხვაობა ({pairs.quality}): {msText(pairs.deltaMs)}
            </p>
          )}
        </>
      )}
    </section>
  )
}
