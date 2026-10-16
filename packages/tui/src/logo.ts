// ELITZA wordmark — solid block glyphs so the brand reads clearly in any terminal.
const glyphs = {
  E: ["█████", "██   ", "█████", "██   ", "█████"],
  L: ["██   ", "██   ", "██   ", "██   ", "█████"],
  I: ["█████", " ██  ", " ██  ", " ██  ", "█████"],
  T: ["█████", " ██  ", " ██  ", " ██  ", " ██  "],
  Z: ["█████", "   ██", " ██  ", "██   ", "█████"],
  A: [" ███ ", "██ ██", "█████", "██ ██", "██ ██"],
} satisfies Record<string, readonly string[]>

const rows = (letters: readonly (keyof typeof glyphs)[]) =>
  Array.from({ length: glyphs.E.length }, (_, row) => letters.map((letter) => glyphs[letter][row]).join(" "))

export const logo = {
  left: rows(["E", "L", "I"]),
  right: rows(["T", "Z", "A"]),
}

// Compact mark for narrow layouts and the mini exit banner.
export const mark = glyphs.E
