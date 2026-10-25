import { TextareaRenderable } from "@opentui/core"
import { Keymap } from "../context/keymap"
import { useTheme } from "../context/theme"
import { DialogFooter, DialogHeader, DialogLayout, useDialog, type DialogSize } from "./dialog"
import { Show, createEffect, createSignal, onMount, type JSX } from "solid-js"
import { Spinner } from "../component/spinner"
import { useConfig } from "../config"
import { useRenderer } from "@opentui/solid"

export type DialogPromptAction = {
  title: string
  /** Keymap command id, bound while the prompt input is focused and shown in the footer. */
  command: string
  /** Keymap command title, e.g. for help listings. Defaults to `title`. */
  commandTitle?: string
  onTrigger: (prompt: { setValue: (value: string) => void }) => void
}

export type DialogPromptProps = {
  title: string
  size?: DialogSize
  description?: () => JSX.Element
  placeholder?: string
  value?: string
  /** Masks the input as it is typed and keeps the real value out of the buffer. */
  secret?: boolean
  busy?: boolean
  busyText?: string
  actions?: DialogPromptAction[]
  onConfirm?: (value: string) => void
  onCancel?: () => void
}

const MASK = "•"

export function DialogPrompt(props: DialogPromptProps) {
  const dialog = useDialog()
  const renderer = useRenderer()
  const theme = useTheme().surface("dialog")
  const config = useConfig().data
  const [textareaTarget, setTextareaTarget] = createSignal<TextareaRenderable>()
  const [real, setReal] = createSignal(props.value ?? "")
  let textarea: TextareaRenderable

  function confirm() {
    if (props.busy) return
    props.onConfirm?.(props.secret ? real() : textarea.plainText)
  }

  // Secret mode keeps the true value in `real` and only ever shows bullets:
  // every content change is re-masked, which also clears the undo history so
  // a stray undo cannot reveal the key. Editing is expected to happen at the
  // end of the line (the prompt starts there); the setup wizard verifies the
  // stored key with a live ping, which catches any mismatch.
  function syncSecret() {
    if (!textarea || textarea.isDestroyed) return
    const shown = textarea.plainText
    if (shown === MASK.repeat(real().length)) return
    let next = real()
    if (shown.length > next.length) next += shown.slice(next.length)
    else if (shown.length < next.length) next = next.slice(0, shown.length)
    else next = shown
    setReal(next)
    textarea.setText(MASK.repeat(next.length))
    textarea.gotoLineEnd()
  }

  const handle = {
    setValue(value: string) {
      textarea.setText(value)
      textarea.gotoLineEnd()
    },
  }

  Keymap.createLayer(() => ({
    mode: "modal",
    target: textareaTarget,
    enabled: textareaTarget() !== undefined && !props.busy,
    // Dialog form semantics must win over the global managed textarea input layer.
    priority: 1,
    commands: [
      {
        id: "dialog.prompt.submit",
        title: "Submit dialog prompt",
        group: "Dialog",
        run: confirm,
      },
      ...(props.actions ?? []).map((action) => ({
        id: action.command,
        title: action.commandTitle ?? action.title,
        group: "Dialog",
        run: () => action.onTrigger(handle),
      })),
    ],
  }))

  Keymap.createLayer(() => ({
    mode: "modal",
    enabled: props.onCancel !== undefined,
    priority: 1,
    commands: [
      {
        bind: "escape",
        title: "Back",
        group: "Dialog",
        run: () => {
          if (renderer.getSelection()) {
            renderer.clearSelection()
            return
          }
          if (!props.busy) props.onCancel?.()
        },
      },
    ],
  }))

  onMount(() => {
    dialog.setSize(props.size ?? "medium")
    if (props.secret && props.value) {
      setReal(props.value)
      textarea.setText(MASK.repeat(props.value.length))
    }
    setTimeout(() => {
      if (!textarea || textarea.isDestroyed) return
      if (props.busy) return
      textarea.focus()
    }, 1)
    textarea.gotoLineEnd()
  })

  createEffect(() => {
    if (!textarea || textarea.isDestroyed) return
    const traits = props.busy
      ? {
          suspend: true,
          status: "BUSY",
        }
      : {}
    textarea.traits = traits
    if (props.busy) {
      textarea.blur()
      return
    }
    textarea.focus()
  })

  return (
    <DialogLayout
      header={
        <DialogHeader
          title={props.title}
          onClose={() => {
            if (!props.busy) (props.onCancel ?? dialog.clear)()
          }}
        />
      }
      footer={
        <Show when={!props.busy} fallback={<text fg={theme.text.muted}>processing…</text>}>
          <DialogFooter
            actions={[
              { title: "submit", command: "dialog.prompt.submit", onTrigger: confirm },
              ...(props.actions ?? []).map((action) => ({
                title: action.title,
                command: action.command,
                onTrigger: () => action.onTrigger(handle),
              })),
            ]}
          />
        </Show>
      }
    >
      <box gap={1}>
        {props.description?.()}
        <textarea
          height={1}
          wrapMode="none"
          ref={(val: TextareaRenderable) => {
            textarea = val
            setTextareaTarget(val)
            val.onContentChange = props.secret ? syncSecret : undefined
          }}
          initialValue={props.value}
          placeholder={props.placeholder ?? "Enter text"}
          placeholderColor={theme.text.muted}
          textColor={props.busy ? theme.text.formfield.disabled : theme.text.formfield.base}
          focusedTextColor={props.busy ? theme.text.formfield.disabled : theme.text.formfield.base}
          cursorColor={props.busy ? theme.background.formfield.disabled : theme.text.base}
          cursorStyle={config.cursor}
        />
        <Show when={props.busy}>
          <Spinner color={theme.text.muted}>{props.busyText ?? "Working…"}</Spinner>
        </Show>
      </box>
    </DialogLayout>
  )
}
