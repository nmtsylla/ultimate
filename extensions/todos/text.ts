export const TODO_TEXT_CHARS = 300

export const tooLongText = (length: number) =>
  `The to-do is ${length} characters; the limit is ${TODO_TEXT_CHARS}. Shorten it or split it.`
