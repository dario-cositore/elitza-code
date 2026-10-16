import { TextAttributes } from "@opentui/core"
import { For, type JSX } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "../context/theme"
import { logo, mark } from "../logo"

export function Logo() {
  const theme = useTheme()
  const dimensions = useTerminalDimensions()

  const renderLine = (line: string): JSX.Element[] =>
    Array.from(line).map((char) => (
      <text fg={theme.brand.base} attributes={TextAttributes.BOLD} selectable={false}>
        {char}
      </text>
    ))

  const stack = (lines: readonly string[]) => (
    <For each={lines}>{(line) => <box flexDirection="row">{renderLine(line)}</box>}</For>
  )

  return (
    <box>
      {dimensions().height < 12 ? null : dimensions().width < 22 ? (
        stack(mark)
      ) : dimensions().width < 44 ? (
        <>
          {stack(logo.left.slice(1))}
          {stack(logo.right.slice(1))}
        </>
      ) : (
        <For each={logo.left}>
          {(line, index) => (
            <box flexDirection="row" gap={1}>
              <box flexDirection="row">{renderLine(line)}</box>
              <box flexDirection="row">{renderLine(logo.right[index()])}</box>
            </box>
          )}
        </For>
      )}
    </box>
  )
}
