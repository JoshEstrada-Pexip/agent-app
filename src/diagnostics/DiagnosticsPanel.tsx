import type React from 'react'
import { useMemo, useRef, useState } from 'react'
import { Button } from '@pexip/components'
import {
  captureClear,
  captureDumpAll,
  isCaptureEnabled
} from '../genesys/capture'
import {
  clearDiagnostics,
  collectDiagnostics,
  copyText,
  isVerbose,
  setVerbose,
  type DiagnosticsContext,
  type DiagnosticsPackage
} from './diagnostics'

/**
 * Support panel: what the agent opens when asked for logs. Everything stays
 * in the browser; the agent copies the text and pastes it into a ticket.
 * Reached by clicking the build stamp, so normal agents never see it.
 */
export const DiagnosticsPanel = ({
  context,
  onClose
}: {
  context: DiagnosticsContext
  onClose: () => void
}): React.JSX.Element => {
  const [verbose, setVerboseState] = useState(isVerbose())
  const [status, setStatus] = useState<string | null>(null)
  const textRef = useRef<HTMLTextAreaElement | null>(null)

  const collect = (): DiagnosticsPackage =>
    collectDiagnostics(
      context,
      isCaptureEnabled() ? captureDumpAll() : undefined
    )
  // Snapshot shown in the box. Null after Clear until the next Copy.
  const [pkg, setPkg] = useState<DiagnosticsPackage | null>(collect)
  const text = useMemo(
    () => (pkg == null ? '' : JSON.stringify(pkg, null, 1)),
    [pkg]
  )
  const entryCount = pkg?.entryCount ?? 0
  const sessionCount = pkg?.sessionCount ?? 0

  return (
    <div className="diagnostics-panel" data-testid="diagnostics-panel">
      <button
        type="button"
        className="diagnostics-close"
        aria-label="Close"
        title="Close"
        data-testid="diag-close-x"
        onClick={onClose}
      >
        ×
      </button>
      <h2>Support diagnostics</h2>
      <dl>
        <dt>Build</dt>
        <dd data-testid="diag-build">
          {context.version != null ? `v${context.version} · ` : ''}
          {context.buildId}
        </dd>
        <dt>Call</dt>
        <dd>{context.conversationId ?? 'none'}</dd>
        <dt>Entries</dt>
        <dd data-testid="diag-entries">
          {entryCount} from {sessionCount} widget session
          {sessionCount === 1 ? '' : 's'}
        </dd>
      </dl>

      <p className="diagnostics-hint">
        Click Copy, then paste into Notepad or any text editor, save the file
        and attach it to your support ticket.
      </p>

      <label className="diagnostics-verbose">
        <input
          type="checkbox"
          checked={verbose}
          data-testid="diag-verbose"
          onChange={(e) => {
            setVerbose(e.target.checked)
            setVerboseState(e.target.checked)
            setStatus(
              e.target.checked
                ? 'Verbose logging on. Reload the interaction, reproduce the problem, then come back and copy.'
                : 'Verbose logging off.'
            )
          }}
        />
        Verbose logging (adds detail and the raw Genesys events)
      </label>

      <div className="diagnostics-actions">
        <Button
          data-testid="diag-copy"
          onClick={() => {
            // Always a fresh snapshot: the agent may have reproduced the
            // problem since the panel opened or since Clear.
            const fresh = collect()
            setPkg(fresh)
            copyText(JSON.stringify(fresh, null, 1))
              .then((ok) => {
                textRef.current?.select()
                setStatus(
                  ok
                    ? 'Copied. Paste it into your support ticket.'
                    : 'Copy blocked by the browser — the text below is selected, press Ctrl/Cmd+C.'
                )
              })
              .catch(() => undefined)
          }}
        >
          Copy
        </Button>
        <Button
          data-testid="diag-clear"
          onClick={() => {
            clearDiagnostics()
            captureClear()
            setPkg(null)
            setStatus(
              'Stored logs cleared. Reproduce the problem, then click Copy.'
            )
          }}
        >
          Clear
        </Button>
        <Button onClick={onClose} data-testid="diag-close">
          Close
        </Button>
      </div>

      {status != null && <p className="diagnostics-status">{status}</p>}

      <textarea
        ref={textRef}
        className="diagnostics-text"
        data-testid="diag-text"
        readOnly
        value={text}
        placeholder="Nothing stored yet. Click Copy to take a snapshot."
        onFocus={(e) => {
          e.target.select()
        }}
      />
    </div>
  )
}
