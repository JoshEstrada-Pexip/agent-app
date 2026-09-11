import type React from 'react'
import { Icon, IconTypes, Video } from '@pexip/components'

import './SelfView.scss'

interface SelfViewProps {
  /** Local (processed) camera stream; undefined whenever video is muted. */
  localStream: MediaStream | undefined
  /** Muted tile title, e.g. "Camera off" / "Video muted". */
  offTitle: string
  /** Muted tile detail, e.g. "Customer can't see you" / "On hold". */
  offDetail: string
}

/**
 * The agent's own picture, docked in the call strip. It is never hidden and
 * never moves: what this tile shows is what the customer gets. Muted video
 * keeps the same footprint with the crossed camera and the reason in words
 * (the same glyph the toolbar button uses), so "hidden" can never be
 * mistaken for "off".
 */
export const SelfView = ({
  localStream,
  offTitle,
  offDetail
}: SelfViewProps): React.JSX.Element => {
  const off = localStream == null
  return (
    <div
      className={`SelfView ${off ? 'camera-off' : 'camera-on'}`}
      data-testid="SelfView"
      data-state={off ? 'off' : 'on'}
    >
      {off ? (
        <div className="self-view-off" data-testid="self-view-off">
          <Icon className="self-view-icon" source={IconTypes.IconVideoOff} />
          <strong>{offTitle}</strong>
          <span>{offDetail}</span>
        </div>
      ) : (
        <>
          <Video
            className="self-view-video"
            srcObject={localStream}
            isMirrored={true}
            muted={true}
          />
          <p className="self-view-caption" data-testid="self-view-caption">
            Customer can see you
          </p>
        </>
      )}
    </div>
  )
}
