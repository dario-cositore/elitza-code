export * as ElitzaWorkerd from "./workerd"

import { Layer } from "effect"
import type { Config, Scope } from "effect"
import { WorkerdProfile } from "../internal/workerd"
import { Elitza } from "./elitza"

export type Configuration = WorkerdProfile.Configuration

export interface CreateOptions<R = never> extends WorkerdProfile.Options {
  readonly log?: Elitza.CreateOptions["log"]
  readonly plugins?: Elitza.CreateOptions["plugins"]
  readonly workspaceProviders?: Elitza.CreateOptions["workspaceProviders"]
  readonly instances?: Elitza.CreateOptions<R>["instances"]
}

export const create = <R = never>({ log, plugins, workspaceProviders, instances, ...options }: CreateOptions<R>) => {
  const profile = WorkerdProfile.make(options)
  return Elitza.create(
    { ...profile.options, log, plugins, workspaceProviders, instances },
    { overrides: profile.replacements },
  )
}

export const layer = <R = never>(
  options: CreateOptions<R>,
): Layer.Layer<Elitza.Service, Config.ConfigError | Error, Exclude<R, Scope.Scope>> =>
  Layer.effect(Elitza.Service, create(options))

export type Interface = Elitza.Interface
export type Requirements = Scope.Scope
