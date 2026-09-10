import type React from 'react'
import { Icon, type IconTypes } from '@pexip/components'

/** Full-window informational pane (no call, on hold, another window, ...). */
export const StatePane = ({
  id,
  icon,
  title,
  children
}: {
  id: string
  icon: (typeof IconTypes)[keyof typeof IconTypes]
  title: string
  children?: React.ReactNode
}): React.JSX.Element => (
  <div className={`state-pane ${id}`} data-testid={id}>
    <Icon className="state-pane-icon" source={icon} />
    <h1>{title}</h1>
    {children}
  </div>
)
