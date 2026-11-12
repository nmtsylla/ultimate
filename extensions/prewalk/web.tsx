/**
 * Prewalk in the browser: a quiet composer-toolbar chip while a handoff is armed (`prewalk → fast · model`), with an
 * inline cancel, and a compact family chooser (toolbar click or ⌘K "Prewalk…") that arms on selection.
 */
import { CheckIcon, FootprintsIcon, XIcon } from 'lucide-react'
import { useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  api,
  cn,
  defineWebExtension,
  errorMessage,
  getConversation,
  useConversation,
  useDialog,
  useDoc,
} from '@/sdk'
import { familyTitle, refName } from '../../lib/families.ts'
import { FamilyDot, runsOn, useFamilies } from '../models/ui.tsx'
import type { FamilyView } from '../models/ui.tsx'
import { ArmAction, DisarmAction, PrewalkDoc } from './refs.ts'
import type { PrewalkState } from './refs.ts'

type Armed = NonNullable<PrewalkState['armed']>

const toolbarButton =
  'flex h-7 max-w-56 shrink-0 items-center gap-1.5 rounded-md px-2 font-mono text-[11.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground'

/** The chooser popover of conversation `id`'s toolbar; the ⌘K command opens the shown conversation's. */
const chooseDialog = (id: number | undefined) => `prewalk.choose.${id}`

/** `fast · deepseek-v4.1-flash · high`; an explicit pin shows `provider/modelId` instead of the family. */
function targetLabel(armed: Armed) {
  const model = refName(armed.target)
  return [
    armed.family ?? model,
    ...(armed.family ? [armed.target.modelId] : []),
    ...(armed.thinking ? [armed.thinking] : []),
  ].join(' · ')
}

const modelIdOf = (ref: string) => ref.slice(ref.indexOf('/') + 1)
/** The thinking level a family runs at (as `models` shows it): its own, or Pi's default for a following family. */
const thinkingOf = (family: FamilyView) =>
  family.thinking ?? (family.model ? undefined : family.followsThinking)

function PrewalkControl() {
  const id = useConversation((conversation) => conversation.id)
  const armed = useDoc(PrewalkDoc)?.armed
  const families = useFamilies()
  const [open, setOpen] = useDialog(chooseDialog(id))
  const [error, setError] = useState<string>()

  const arm = (target: string) => {
    if (id === undefined) return
    setError(undefined)
    api.action(ArmAction, { conversation: id, target }).then(
      () => setOpen(false),
      (failure: unknown) => setError(errorMessage(failure)),
    )
  }
  const disarm = () => {
    if (id === undefined) return
    setError(undefined)
    api.action(DisarmAction, { conversation: id }).then(
      () => setOpen(false),
      (failure: unknown) => setError(errorMessage(failure)),
    )
  }

  return (
    <span className="flex min-w-0 shrink items-center" data-prewalk>
      <Popover
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) setError(undefined)
        }}
        open={open}
      >
        <PopoverTrigger asChild>
          <button
            aria-label={
              armed
                ? `Prewalk armed: switch to ${targetLabel(armed)} after the first planned edit. Choose another target.`
                : 'Prewalk: hand off to another model after the first planned edit'
            }
            className={cn(toolbarButton, 'min-w-0')}
            title={
              armed
                ? `After the first planned edit, this conversation switches once to ${targetLabel(armed)}`
                : 'Prewalk: after the first planned edit, switch once to a cheaper model'
            }
            type="button"
          >
            <FootprintsIcon
              className={cn('size-3.5 shrink-0', armed && 'text-brand')}
              aria-hidden
            />
            {armed && (
              <span className="truncate text-foreground/85">prewalk → {targetLabel(armed)}</span>
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-1 font-mono" side="top">
          <div className="px-2 pt-1 pb-1.5 section-label">
            {armed ? 'Hand off to' : 'Prewalk: switch once after the first planned edit'}
          </div>
          {(families?.families ?? []).map((family) => (
            <button
              className="flex h-7 w-full items-center gap-2 rounded-sm px-2 text-left text-[12px] transition-colors hover:bg-accent"
              key={family.name}
              onClick={() => arm(family.name)}
              type="button"
            >
              <CheckIcon
                className={cn(
                  'size-3.5 shrink-0',
                  armed?.family === family.name ? 'text-brand' : 'opacity-0',
                )}
              />
              <FamilyDot color={family.color} />
              <span className="shrink-0 font-sans text-foreground">{familyTitle(family.name)}</span>
              <span className="ml-auto min-w-0 truncate pl-2 text-[11px] text-muted-foreground">
                {[runsOn(family) && modelIdOf(runsOn(family)!), thinkingOf(family)]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </button>
          ))}
          <div className="mt-1 flex min-h-7 items-center gap-2 border-t border-border/70 px-2 pt-1.5 pb-1 text-[11px]">
            {error ? (
              <span className="min-w-0 text-error" role="alert">
                {error}
              </span>
            ) : (
              armed && (
                <button
                  className="cursor-pointer text-muted-foreground transition-colors hover:text-foreground"
                  onClick={disarm}
                  type="button"
                >
                  Cancel the handoff
                </button>
              )
            )}
          </div>
        </PopoverContent>
      </Popover>
      {armed && id !== undefined && (
        <button
          aria-label={`Cancel the prewalk handoff to ${targetLabel(armed)}`}
          className="-ml-1 flex h-7 shrink-0 items-center rounded-md px-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          onClick={disarm}
          title="Cancel the handoff"
          type="button"
        >
          <XIcon className="size-3.5" aria-hidden />
        </button>
      )}
    </span>
  )
}

export default defineWebExtension({
  slots: { 'composer.toolbar': [PrewalkControl] },
  commands: [
    {
      id: 'prewalk.choose',
      title: 'Prewalk…',
      run: (context) => {
        const { id, loading } = getConversation(context.conversationId)
        if (!loading && id !== undefined) context.open(chooseDialog(id))
      },
    },
  ],
})
