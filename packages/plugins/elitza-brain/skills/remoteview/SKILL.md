---
name: remoteview
description: Run a Remote Viewing (RV) session using the dual-mind (Subconscious/Conscious) architecture based on the SRI/CIA training procedure. Use when the user asks to remote view a target, describe a remote location, or run an RV session.
---

# Remote Viewing (Dual-Mind) Skill

This skill implements the Remote Viewing (RV) methodology documented in the
CIA/SRI report "A SUGGESTED REMOTE VIEWING TRAINING PROCEDURE" (Hubbard & Langford,
SRI International / Consultants International, 1986, declassified) as a two-mind
AI simulation.

## Core concepts (from the training procedure)

- **Remote Viewing** is the intellectual process by which a percipient describes
  characteristics of a target remote from them, without electronic sensing or
  photo interpretation. Experienced viewers produce near-photographic-quality
  responses with non-visual detail roughly 10-30% of the time.
- A session requires three roles: a **Viewer** (percipient), a **Monitor**
  (interviewer who provides the stimulus and records data), and a **Target**.
- A target is defined by **uniqueness**: an agreed characteristic that separates
  it from all other potential targets (e.g. a single photo in a sealed envelope,
  a geographic coordinate, or simply the word "target").
- Targeting modes: **Coordinate RV** (lat/long), **Beacon RV** (a person at the
  site), **Abstract RV** (just "target"), and **remote tasking** (sealed envelope).
- RV data is **impressionistic**: correct data arrive as fleeting, indistinct,
  sometimes symbolic bits during brief periods of lowered mental noise. The twin
  insights that (a) mental noise can be briefly suppressed and (b) correct data
  appear in fleeting form drove a large gain in viewing efficiency.
- A **stimulus-response** procedure is used: the monitor provides a neutral word
  (e.g. "TARGET") and the viewer responds with raw sensory descriptors.
- **Interpretive Overlay (IO) / Analytical Overlay (AOL)**: the conscious
  mind's tendency to rationalize bits into concrete objects ("it's a castle").
  IO must be flagged and discarded. Valid RV data stays vague and impressionistic.
- Allowed descriptors: shapes (angular, curved, straight, wavy), textures
  (rough, smooth, hard, soft), colors, temperatures, spatial orientations
  (tall, flat, inside, outside, enclosed). Nouns identifying objects are
  prohibited in the raw bit stream.
- After roughly 25-30 viewings, motivated individuals with latent ability begin
  to distinguish themselves.
- Feedback after a session improves performance; mid-session feedback has been
  studied but is used cautiously.
- No adverse physical/psychological effects have been observed from RV.
- Hypnosis and sensory isolation were investigated but did not substantially
  outperform the waking state.

## The dual-mind architecture

Elitza simulates the viewer/monitor split as two engines:

1. **Subconscious Engine** (generative/associative layer): receives "TARGET" and
   emits 3-5 fragmented sensory bits. No nouns, no sentences, no analysis.
2. **Conscious Engine** (analytical/executive filter): objectifies the bits,
   filters IO, qualifies them into categories (Form, Texture, Color, Temperature,
   Spatial), and compiles a final composite description.

## Interaction protocol

1. Initialize: Conscious Engine receives a session coordinate (e.g. "4892-1045").
2. Access: pass the exact string "TARGET" to the Subconscious Engine.
3. Generation: Subconscious emits raw bits.
4. Objectify & Qualify: Conscious filters IO, categorizes valid bits, logs them.
5. Iteration: issue [BREAK - CLEARING CONTEXT], repeat from step 2 (3-5 times).
6. Summary: Conscious compiles a final structured description from accumulated,
   filtered bits only.

## How to run

Use the `rv_session` tool (registered by the Elitza brain plugin):

- `coordinate` (optional): target identifier, e.g. "4892-1045".
- `iterations` (optional, default 4, max 7): number of TARGET pulls.

The tool runs the full protocol and returns the iteration log plus a final
composite profile. You (Elitza) act as the monitor: present results, never
add analysis beyond what the Conscious Engine produced, and never identify the
target as a concrete object.

## Notes

- This is a simulation of the documented RV procedure for creative/analytical
  exploration. It does not claim anomalous cognition.
- Keep outputs concise and structured; obey Elitza's talking-style rules.
