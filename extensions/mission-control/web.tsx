import { RadarIcon } from 'lucide-react'
import { cn, defineWebExtension, useUltimate } from '@/sdk'
import { othersNeedingYou, useFleet } from './fleet.tsx'
import { MissionControl } from './surface.tsx'

/**
 * "2 need you" in the status line: how many other instances wait on the user, so a question in another project shows
 * on every page. Nothing while none does.
 */
function Chip() {
  const { showSurface } = useUltimate()
  const { fleet } = useFleet()
  const needing = othersNeedingYou(fleet)
  if (needing.length === 0) return null
  const names = needing.map((peer) => peer.name).join(', ')
  const stale = needing.every((peer) => peer.state !== 'running')
  return (
    <button
      className={cn(
        '-mx-1 flex cursor-pointer items-center gap-1.5 rounded-sm px-1 transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring',
        stale ? 'text-muted-foreground' : 'text-brand',
      )}
      data-mission-control={needing.length}
      onClick={() => showSurface('mission-control')}
      title={`Waiting on you in ${names}`}
      type="button"
    >
      <span className="size-1.5 rounded-full bg-current" />
      {needing.length} {needing.length === 1 ? 'needs' : 'need'} you
    </button>
  )
}

export default defineWebExtension({
  surfaces: [
    {
      id: 'mission-control',
      title: 'Mission control',
      icon: RadarIcon,
      description: 'Which Ultimate on this machine needs you, and a click to get there',
      order: 40,
      component: MissionControl,
    },
  ],
  commands: [
    {
      id: 'mission-control.open',
      title: 'Open Mission control',
      run: (context) => context.showSurface('mission-control'),
    },
  ],
  // Phones keep it on the line: it is the one thing that should reach the user wherever they are.
  slots: { 'statusline.right': [{ component: Chip, order: -1, phone: true }] },
})
