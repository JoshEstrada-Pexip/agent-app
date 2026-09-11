import type React from 'react'

export const Bar = (props: any): React.JSX.Element => (
  <div {...props}>{props.children}</div>
)
export const Box = (props: any): React.JSX.Element => (
  <div {...props}>{props.children}</div>
)
export const Button = (props: any): React.JSX.Element => <button {...props} />
export const CenterLayout = (props: any): React.JSX.Element => (
  <div>{props.children}</div>
)
export const FontVariant = jest.fn()
export const Icon = (props: any): React.JSX.Element => {
  // span: the real Icon renders an <svg>, which (like span) is valid inside <p>
  const { colorScheme, ...newProps } = props
  return <span {...newProps} />
}
export const IconTypes = {
  IconBlock: 'Icon',
  IconGroup: 'Icon',
  IconLeave: 'Icon',
  IconPause: 'Icon',
  IconVideoOff: 'Icon',
  IconWaiting: 'Icon',
  IconWarningRound: 'Icon'
}
export const InteractiveElement = (props: any): React.JSX.Element => (
  <button {...props}>{props.children}</button>
)
export const Modal = (props: any): React.JSX.Element => {
  const { isOpen, withCloseButton, ...newProps } = props
  return <div {...newProps}>{props.children}</div>
}
export const notificationToastSignal = { emit: jest.fn() }
export const NotificationToast = (props: any): React.JSX.Element => (
  <div {...props}>{props.children}</div>
)
export const Select = (props: any): React.JSX.Element => {
  const {
    labelModifier,
    sizeModifier,
    onValueChange,
    isFullWidth,
    iconType,
    value,
    ...newProps
  } = props
  return (
    <select
      {...newProps}
      value={value ?? ''}
      onChange={(ev) => onValueChange(ev)}
    >
      {props.options.map((option: any) => (
        <option key={option.id} value={option.id}>
          {option.label}
        </option>
      ))}
    </select>
  )
}
export const Spinner = (props: any): React.JSX.Element => {
  const { colorScheme, ...newProps } = props
  return <div {...newProps}></div>
}
export const Text = (props: any): React.JSX.Element => {
  const { htmlTag, ...newProps } = props
  return <div {...newProps}>{props.children}</div>
}
export const TextHeading = (props: any): React.JSX.Element => (
  <h3>{props.text}</h3>
)
export const Video = (): React.JSX.Element => <div />
