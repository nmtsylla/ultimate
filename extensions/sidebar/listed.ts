import type { ConversationId } from '@earendil-works/pi-durable'
export const topLevelRows = <T extends { id: number; parentConversationId?: ConversationId }>(
  conversations: readonly T[],
  unlisted: ReadonlySet<number>,
) =>
  conversations.filter(
    (conversation) =>
      conversation.parentConversationId === undefined && !unlisted.has(conversation.id),
  )

export const landerRows = (
  topLevel: readonly { id: number; label?: string }[],
  known: readonly number[],
) => {
  const landers = topLevel.filter((conversation) => conversation.label === 'lander')
  const landerId =
    known.find((id) => landers.some((conversation) => conversation.id === id)) ?? landers.at(-1)?.id
  return {
    landerId,
    stray: new Set(
      landers
        .filter((conversation) => landerId !== undefined && conversation.id !== landerId)
        .map((conversation) => conversation.id),
    ),
  }
}
