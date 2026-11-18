import { ROOT } from '@/sdk'
import { useEffect } from 'react'
import { ActionError, api, defineWebExtension, provide, useDocOf, useUiState } from '@/sdk'
import { ignoring } from '../../lib/errors.ts'
import { MessageAnswers, MessagesDoc } from '../messages/ui.tsx'
import { MessageQuestions } from './card.tsx'
import { forgetSettled } from './open.tsx'
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
  useEffect(() => {
    void sendPendingAnswers((messageId, reply) =>
      api
        .action(AnswerAction, { messageId, ...reply })
        .catch(ignoring((error: unknown) => error instanceof ActionError && error.status !== 0)),
    )
  }, [])
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
