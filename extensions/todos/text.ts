/** A to-do's text: the limit and why a longer one is refused, shared by the tool, the action and the panel. */

/** The longest to-do text, in characters. */
export const TODO_TEXT_CHARS = 300

/** Why a to-do of `length` characters was refused, counted on the trimmed text. */
export const tooLongText = (length: number) =>
  `The to-do is ${length} characters; the limit is ${TODO_TEXT_CHARS}. Shorten it or split it.`
