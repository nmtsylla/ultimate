import { ROOT } from '@/sdk'
import { useEffect, useRef } from 'react'
import { api, defineWebExtension, provide, useDocOf, useUiState } from '@/sdk'
import { MessageAnswers, MessagesDoc } from '../messages/ui.tsx'
import { MessageQuestions } from './card.tsx'
import { forgetSettled, waitsOnUser } from './open.tsx'
import { sendPendingAnswers } from './pending.ts'
import { AnswerAction } from './refs.ts'
import { CARDS_KEY } from './state.tsx'
import type { CardState } from './state.tsx'

function CrossSurfaceDraftSweep() {
  const [cards, setCards] = useUiState<Record<string, CardState>>(CARDS_KEY, {})
  const messages = useDocOf(ROOT, MessagesDoc)?.messages

  useEffect(() => {
    const logAndStoredCardsLoaded = messages && Object.keys(cards).length
    if (logAndStoredCardsLoaded) setCards((old) => forgetSettled(old, messages))
  }, [cards, messages, setCards])
  return null
}

function PendingAnswers() {
  const messages = useDocOf(ROOT, MessagesDoc)?.messages
  const swept = useRef(false)
  useEffect(() => {
    if (!messages || swept.current) return
    swept.current = true
    void sendPendingAnswers(
      (messageId) => messages.some((message) => message.id === messageId && waitsOnUser(message)),
      (messageId, reply) => api.action(AnswerAction, { messageId, ...reply }),
    )
  }, [messages])
  return null
}

export default defineWebExtension({
  slots: { overlay: [CrossSurfaceDraftSweep, PendingAnswers] },
  entries: {
    'questions.asked': () => null,
    'questions.answers': () => null,
  },
  commands: [
    {
      id: 'questions.open',
      title: 'Show open questions',
      run: (context) => context.openPanel('todos'),
    },
  ],
  provides: [provide(MessageAnswers, (message) => <MessageQuestions message={message} />)],
})
