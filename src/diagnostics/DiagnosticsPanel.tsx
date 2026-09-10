import type React from 'react'
import { useMemo, useRef, useState } from 'react'
import { Button } from '@pexip/components'
import { captureDumpAll, isCaptureEnabled } from '../genesys/capture'
import {
  clearDiagnostics,
  collectDiagnostics,
  copyText,
  diagnosticsFileName,
  downloadText,
  isVerbose,
  setVerbose,
  type DiagnosticsContext
} from './diagnostics'

/**
 * Support panel: what the agent opens when asked for logs. Everything stays
 * in the browser; the agent copies or downloads the file and sends it.
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

  const pkg = useMemo(
    () =>
      collectDiagnostics(
        context,
        isCaptureEnabled() ? captureDumpAll() : undefined
      ),
    [context]
  )
  const text = useMemo(() => JSON.stringify(pkg, null, 1), [pkg])

  return (
    <div className="diagnostics-panel" data-testid="diagnostics-panel">
      <h2>Support diagnostics</h2>
      <dl>
        <dt>Build</dt>
        <dd data-testid="diag-build">{pkg.build}</dd>
        <dt>Call</dt>
        <dd>{pkg.conversationId ?? 'none'}</dd>
        <dt>Entries</dt>
        <dd data-testid="diag-entries">
          {pkg.entryCount} from {pkg.sessionCount} widget session
          {pkg.sessionCount === 1 ? '' : 's'}
        </dd>
      </dl>

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
            copyText(text)
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
          data-testid="diag-download"
          onClick={() => {
            const ok = downloadText(diagnosticsFileName(pkg), text)
            setStatus(
              ok
                ? 'Saved to your downloads.'
                : 'Download blocked here — use Copy instead.'
            )
          }}
        >
          Download
        </Button>
        <Button
          data-testid="diag-clear"
          onClick={() => {
            clearDiagnostics()
            setStatus('Stored logs cleared.')
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
        onFocus={(e) => {
          e.target.select()
        }}
      />
    </div>
  )
}
