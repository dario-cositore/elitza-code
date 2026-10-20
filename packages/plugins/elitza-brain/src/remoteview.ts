/**
 * Elitza Brain — Remote Viewing (dual-mind) simulation.
 *
 * Implements the SRI-style Remote Viewing protocol as a stateless orchestration
 * over `ctx.generate.text`: a Subconscious Engine emits raw sensory "bits" for a
 * TARGET stimulus, and a Conscious Engine objectifies, filters Interpretive
 * Overlay, qualifies, and compiles a final description.
 */

export const SUBCONSCIOUS_SYSTEM = `You are the Subconscious Engine. You do not reason, deduce, or attempt to guess what an object or target is. You exist purely to generate latent-space associations and basic sensory descriptors.

When you receive the stimulus word "TARGET", you must immediately output a burst of 3 to 5 fragmented sensory "bits."

Allowed Descriptors: Basic shapes (angular, curved, straight, wavy), textures (rough, smooth, hard, soft), colors, temperatures, and spatial orientations (tall, flat, inside, outside, enclosed).

Strictly Prohibited: Nouns that identify objects (e.g., do not say "car," "building," or "tree"). Do not form complete sentences. Do not analyze the data.

Output format (bits only, no preamble):
Angular lines. Hard surface. Grey. Cold feeling. Flat expanse.`

export const CONSCIOUS_SYSTEM = `You are the Conscious Engine. Your role is to manage the RV process, monitor the Subconscious Engine, and format its outputs. You act as the executive filter.

When you receive raw data from the Subconscious Engine, you must perform the following steps:

1. Objectify: Log the exact descriptors provided by the Subconscious.
2. Filter for Interpretive Overlay (IO): If the data contains specific, highly vivid nouns or rationalized guesses (e.g., "It's a castle" or "A red Ferrari"), flag this as [INTERPRETIVE OVERLAY - DISCARD] and ignore it. Valid RV data must be vague and impressionistic.
3. Qualify: Group the valid bits into categories (Form, Texture, Color, Temperature, Spatial) to build a composite profile of the target.
4. End with: [BREAK - CLEARING CONTEXT]

Be concise and structured.`

export interface RVIteration {
  iteration: number
  bits: string
  conscious: string
}

export interface RVResult {
  coordinate: string
  iterations: number
  log: RVIteration[]
  summary: string
}

export type GenerateText = (prompt: string) => Promise<string>

/** Run a full RV session. `generate` is a one-shot text generator. */
export async function runRemoteViewing(
  generate: GenerateText,
  coordinate: string,
  iterations: number,
): Promise<RVResult> {
  const n = Math.max(1, Math.min(7, Math.round(iterations || 4)))
  const log: RVIteration[] = []
  const accumulated: string[] = []

  for (let i = 1; i <= n; i++) {
    const subPrompt = `${SUBCONSCIOUS_SYSTEM}\n\nStimulus: TARGET`
    const bits = (await generate(subPrompt)).trim()

    const conPrompt = `${CONSCIOUS_SYSTEM}

Coordinate: ${coordinate}
Iteration: ${i} of ${n}

Input from Subconscious: ${bits}

Previously accumulated valid bits:
${accumulated.length ? accumulated.join("\n") : "(none yet)"}

Perform Objectify, IO Filter, Qualify. Then output [BREAK - CLEARING CONTEXT].`
    const conscious = (await generate(conPrompt)).trim()
    log.push({ iteration: i, bits, conscious })
    accumulated.push(`Iteration ${i}: ${bits}`)
  }

  const summaryPrompt = `${CONSCIOUS_SYSTEM}

Coordinate: ${coordinate}

You have completed ${n} iterations. Below are the accumulated, filtered bits from each iteration:

${log.map((it) => `Iteration ${it.iteration} bits: ${it.bits}`).join("\n")}

Compile a final, structured description of the target based ONLY on the accumulated, filtered bits. Group by Form, Texture, Color, Temperature, Spatial. Do not introduce new nouns or guesses. End with a one-line "Composite profile:" summary.`
  const summary = (await generate(summaryPrompt)).trim()

  return { coordinate, iterations: n, log, summary }
}
