import { logo } from "../logo"

const reset = "\x1b[0m"
const bold = "\x1b[1m"
const dim = "\x1b[90m"
const brand = "\x1b[1;38;2;250;178;131m"

function wordmark(pad = "") {
  return logo.left.map((line, index) => `${pad}${brand}${line} ${logo.right[index] ?? ""}${reset}`)
}

export function sessionEpilogue(input: { title: string; sessionID?: string }) {
  const weak = (text: string) => `${dim}${text.padEnd(10, " ")}${reset}`
  return [
    ...wordmark("  "),
    "",
    `  ${weak("Session")}${bold}${input.title}${reset}`,
    `  ${weak("Continue")}${bold}elitza -s ${input.sessionID}${reset}`,
    "",
  ].join("\n")
}
