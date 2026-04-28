import React from 'react'
import type { VimTextInputProps } from '../types/textInputTypes.js'
import type { TextHighlight } from '../utils/textHighlighting.js'

export type Props = VimTextInputProps & {
  highlights?: TextHighlight[]
}

export default function VimTextInput(_props: Props): React.ReactNode {
  return null
}
