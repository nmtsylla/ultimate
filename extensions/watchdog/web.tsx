import { AlertCircleIcon, RotateCcwIcon } from 'lucide-react'
import { useState } from 'react'
import {
  api,
  attention,
  Card,
  defineWebExtension,
  errorMessage,
  renderEntry,
  useConversation,
  useTranscript,
  useUltimate,
} from '@/sdk'
import { MessageResponse } from '@/components/ai/message'
import { Button } from '@/components/ui/button'
import { isInput } from '../../lib/entries.ts'
import { ConversationRef } from '../conversations/ui.tsx'
import { FailureEntry, IdleEntry } from './entries.ts'
import { RetryAction } from './refs.ts'

const FailureCard = renderEntry(FailureEntry, function FailureCard({ entry }) {
  const failure = entry.data
  const { switchConversation, conversationId } = useUltimate()
  const busy = useConversation((conversation) => conversation.busy)
  const answered = useTranscript().some(
    (candidate) => candidate.id > entry.id && isInput(candidate),
  )
  const [retry, setRetry] = useState<'idle' | 'retrying' | 'done'>('idle')
  const [problem, setProblem] = useState<string>()
  const offersRetry =
    failure.failedTask !== undefined &&
    failure.conversation === conversationId &&
    !busy &&
    !answered &&
    retry !== 'done'
  return (
    <Card className="border-l-destructive/60">
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
      </header>
      <div className="space-y-2 px-3 py-3 text-[13px] leading-relaxed">
        <p className="whitespace-pre-wrap text-destructive">{failure.error}</p>
        <p className="font-mono text-[11px] text-muted-foreground">last step: {failure.step}</p>
        {failure.hint && <MessageResponse>{failure.hint}</MessageResponse>}
        {failure.retried && <p className="text-[11px] text-muted-foreground">after one retry</p>}
        {problem && <p className="font-mono text-[11px] break-words text-destructive">{problem}</p>}
      </div>
      {offersRetry && (
        <footer className="flex items-center justify-between gap-2 border-t border-border/60 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
          <span>{retry === 'retrying' ? 'resuming' : 'nothing resumes it by itself'}</span>
          <Button
            className="h-7 font-sans text-[12px]"
            disabled={retry === 'retrying'}
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
            size="sm"
            variant="outline"
          >
            <RotateCcwIcon className="size-3" />
            Retry
          </Button>
        </footer>
      )}
    </Card>
  )
})

export default defineWebExtension({
  entries: {
    'watchdog.failure': attention(FailureCard),
    'watchdog.idle': renderEntry(IdleEntry, ({ entry }) => (
      <p className="whitespace-pre-line font-mono text-[11px] text-muted-foreground">
        {entry.data.text}
      </p>
    )),
  },
})
