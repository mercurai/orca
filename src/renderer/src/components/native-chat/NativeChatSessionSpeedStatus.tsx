import type { SessionOptionDescriptor } from '../../../../shared/native-chat-session-options'
import { nativeChatSessionSpeedLabels } from './native-chat-session-speed-labels'

/** Speed facts belong beside the control, including support failures that a tooltip would hide. */
export function NativeChatSessionSpeedStatus(props: {
  descriptor: SessionOptionDescriptor
}): React.JSX.Element | null {
  const labels = nativeChatSessionSpeedLabels(props.descriptor)
  if (!labels) {
    return null
  }
  return (
    <div className="flex flex-col gap-0.5 px-2 pb-1 text-xs text-muted-foreground">
      <div>{labels.nextTurn}</div>
      <div>{labels.support}</div>
      {labels.applied ? <div>{labels.applied}</div> : null}
      <div>{labels.processing}</div>
    </div>
  )
}
