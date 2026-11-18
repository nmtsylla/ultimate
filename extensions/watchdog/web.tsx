import { AlertCircleIcon, RotateCcwIcon } from 'lucide-react'
import { useState } from 'react'
import {
  api,
  defineWebExtension,
  errorMessage,
  renderEntry,
  useConversation,
  useTranscript,
  useUltimate,
} from '@/sdk'
import { MessageResponse } from '@/components/ai/message'
import { isInput } from '../../lib/entries.ts'
import { ConversationRef } from '../conversations/ui.tsx'
import { FailureEntry, IdleEntry } from './entries.ts'
import { RetryAction } from './refs.ts'

export default defineWebExtension({
  entries: {
    'watchdog.failure': renderEntry(FailureEntry, function FailureCard({ entry }) {
      const failure = entry.data
      const { switchConversation, conversationId } = useUltimate()
      const busy = useConversation((conversation) => conversation.busy)
      const answered = useTranscript().some(
        (candidate) => candidate.id > entry.id && isInput(candidate),
      )
      const [retry, setRetry] = useState<'idle' | 'retrying' | 'done'>('idle')
      const [problem, setProblem] = useState<string>()
      const retryable =
        failure.failedTask !== undefined &&
        failure.conversation === conversationId &&
        !busy &&
        !answered &&
        retry === 'idle'
      return (
        <section className="min-w-0 rounded-md border border-border border-l-2 border-l-destructive/60 bg-muted/20">
          <header className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
            <AlertCircleIcon className="size-3.5 text-destructive" />
            <button
              type="button"
              className="min-w-0 cursor-pointer text-foreground hover:underline"
              onClick={() => switchConversation(failure.conversation)}
            >
              <ConversationRef id={failure.conversation} title={failure.title} />
            </button>
            <span>run failed</span>
            {retryable && (
              <button
                type="button"
                title="Run this turn again from where it stopped"
                className="ml-auto flex cursor-pointer items-center gap-1 hover:text-foreground"
                onClick={async () => {
                  setRetry('retrying')
                  await api
                    .action(RetryAction, {
                      conversation: failure.conversation,
                      failedTask: failure.failedTask as number,
                    })
                    .then(() => setRetry('done'))
                    .catch((error: unknown) => {
                      setProblem(errorMessage(error))
                      setRetry('idle')
                    })
                }}
              >
                <RotateCcwIcon className="size-3" />
                retry
              </button>
            )}
            {retry === 'retrying' && <span className="ml-auto">resuming</span>}
          </header>
          <div className="space-y-2 px-3 py-3 text-[13px] leading-relaxed">
            <p className="whitespace-pre-wrap text-destructive">{failure.error}</p>
            <p className="font-mono text-[11px] text-muted-foreground">last step: {failure.step}</p>
            {failure.hint && <MessageResponse>{failure.hint}</MessageResponse>}
            {failure.retried && (
              <p className="text-[11px] text-muted-foreground">after one automatic retry</p>
            )}
            {problem && (
              <p className="font-mono text-[11px] break-words text-destructive">{problem}</p>
            )}
          </div>
        </section>
      )
    }),
    'watchdog.idle': renderEntry(IdleEntry, ({ entry }) => (
      <p className="whitespace-pre-line font-mono text-[11px] text-muted-foreground">
        {entry.data.text}
      </p>
    )),
  },
})
