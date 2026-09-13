# The Hollow Road: score, regional beds and effects

The local bank in `public/audio/soundtrack` contains eight original instrumental
compositions (15 minutes), eight 32-second regional ambience loops and 24 mono
effects. Dialogue is a separate production and is not part of this manifest.
No third-party recordings, artist imitation, sampled dialogue or invented
supernatural utterances are used here.

## Runtime contract

`manifest.json` has `version: 1` and `music`, `ambience`, `sfx` arrays. Every entry
has `id`, `src`, `duration` (seconds) and `loop`. Resolve `src` relative to the
public root/base URL, not relative to the manifest. The files are high-quality
Ogg Vorbis at 48 kHz: stereo for music/ambience, mono for spatial effects.

| Group | IDs |
| --- | --- |
| Music, looping | `title` (120s), `road` (150s), `mystery` (120s), `combat` (120s), `fortress` (120s) |
| Music, one-shot | `ending-commons`, `ending-compact`, `ending-cinder` (90s each) |
| Ambience, looping | `heartlands`, `greenmarch`, `fens`, `salt-coast`, `ash-steppe`, `crownlands`, `frostspine`, `hollowvale` |
| SFX, one-shot | `attack-elf`, `attack-guard`, `attack-villain`, `hit`, `kill`, `pickup`, `capture`, `delivery`, `raid`, `convoy`, `repair`, `upgrade`, `ability-elf`, `ability-guard`, `ability-villain`, `fortress`, `victory`, `defeat`, `click`, `step-dirt`, `step-stone`, `dodge`, `discover`, `inspect` |

World region IDs `fenlands`, `saltcoast`, `ashsteppe` map to sound IDs `fens`,
`salt-coast`, `ash-steppe`. The other five match directly. Music/SFX namespaces
are separate, so both may contain `fortress`.

The musical palette is close bowed viola/cello, dry plucked strings, wood and
leather-frame percussion, sparse protective bells and glass harmonics. The
three epilogues respectively resolve toward communal warmth, an uneasy compact
and bare-road resolve. None contains voices. Environmental beds distinguish
pasture, orchard canopy, reeds/water, surf/rigging, ash, foundry, mountain
wind and empty-valley shutters/well water. Effects distinguish material,
register, envelope and gesture rather than reusing notification beeps.

## Mastering and provenance

`score-cues.json` retains the complete production captions, requested durations,
fixed seeds and musical metadata. `soundtrack-provenance.json` records each
source/master/delivery SHA-256, codec, native sample rate, channels, model,
request, task ID, static mastering gain, peak/RMS measurements and loop metrics.
Paths in provenance refer to the production workstation, not runtime fetch URLs.

Source score FLACs and unabridged ACE result JSONs are retained under
`C:\AI\ACE-Step-1.5\outputs`, with prefix
`korovany2-hollow-road-20260913-`. Acoustic source WAVs, mastered lossless FLACs,
per-asset metadata and the local review playlist are retained under
`C:\AI\ACE-Step-1.5\outputs\korovany2-hollow-road-20260913`.
These large archival files are intentionally outside Git. Do not remove them
as temporary files. The repository contains compact runtime copies.

Music uses ACE-Step `acestep-v15-xl-sft`, the `acestep-5Hz-lm-1.7B` planner with
vLLM, 50 ODE steps, guidance 7, INT8 weight-only quantization, Flash
Attention 2, CPU offload and DiT CPU offload, batch size one. Music is never
substituted by offline synthesis if a model render is missing or failed.

**Parameter-forwarding disclosure:** the upstream Gradio route used for the
completed `title` and `road` cues ignored the helper's requested timestep
`shift=3`, using its own default `shift=1`. Those genuine 50-step compositions
are preserved rather than silently relabelled or speculatively rerendered.
Their provenance records requested and actual shift separately. Subsequent
cues use the supported Python API with explicit `shift=3`, verified against
its returned actual parameters.

Loop sources include four extra seconds. A four-second equal-power tail/head
overlap is rotated to the end, leaving the natural source sample sequence
across the repeat boundary and preserving the advertised duration. The
high-pass filter is warmed with the preceding tail. Endings use a short entry
fade and a 2.5-second exit taper; they do not loop. Short effects use small
edge tapers and material-specific natural decays.

Music targets -21 LUFS with a -2.5 dBTP ceiling; environmental beds target
-31 LUFS with a -6 dBTP ceiling. Effects use -25 dBFS RMS with a -3 dBTP ceiling,
because integrated LUFS gating is undefined for some sub-400ms transients.
Only static gain is applied: no loudness-pumping compressor or hard limiter.
Mix/ducking/spatialization is the runtime's responsibility. Vorbis quality is
6 for music, 4 for ambience and 5 for effects.

Checks fully decode the files, require audible finite signals and headroom,
compare exact container duration and native format, estimate 4x true peak and
inspect sample/100ms-level discontinuity at loop boundaries. Some very short
Vorbis files lose a 128-sample priming block in FFmpeg's native decoder; both
container and decoded durations are recorded, with a maximum 256-sample
tolerance. This is not used to excuse a truncated composition.

These are newly produced game assets, not a claim that model output has an
exclusive copyright or that the repository has a new redistribution license.
The repository's existing licensing position remains unchanged.

## Reproduction

Use the already configured local ACE-Step installation and virtual environment,
Python 3.10+ with numpy/scipy, and ffmpeg/ffprobe with libvorbis. No npm
dependency or runtime service is needed to play the committed files.

```powershell
# Recheck model availability and competing local inference before starting.
& "$HOME\.copilot\skills\ace-step-music\scripts\generate-music.ps1" -CheckOnly

# CPU-only authoring and mastering, independent of model generation.
python -B .\scripts\audio\produce_soundtrack.py --acoustic

# Sequential full-quality jobs; use -Cue title for the production sample.
# Existing exact-recipe masters are reused, never overwritten by a new model run.
.\scripts\audio\render-score.ps1 -MasterAfterEach -Finalize

# Remaster any selected existing originals without running the model again.
python -B .\scripts\audio\produce_soundtrack.py --music title road
python -B .\scripts\audio\produce_soundtrack.py --validate --review-samples
```

The final manifest operation is strict: every requested asset and its archived
source/master must exist and match their recorded hashes. It never writes an
apparently complete manifest with absent music. `--review-samples` alone writes
a playlist of only the finished assets for audition before the full bank is
complete. Re-rendering acoustic files is deterministic for the recorded
numpy/scipy versions; codec/build or platform changes can change file hashes.
Model seeds capture the exact request but do not promise cross-hardware bitwise
identity.

`-MasterAfterEach` publishes each successful cue and refreshes the external
audition playlist before starting the next model job. `-Finalize` writes the
complete manifest only after the bank is complete; omit it if generating just
one sample or if the acoustic bank has not yet been authored.

Run only one local GPU model generation at a time. This does not restrict
browser previews, WebGL, CPU audio processing or the user's review studio.
Never terminate another session's model, browser or review service to render
these cues.

The wrapper launches `render_score_local.py` in a fresh ACE virtual-environment
process for each new cue. This uses ACE's supported `GenerationParams`,
`GenerationConfig` and `generate_music` interfaces, rather than the Gradio
parameter adapter. The completed 1.7B vLLM semantic plan is archived, then its
planner runtime is unloaded before diffusion. Planning is not skipped or
reduced; freeing its no-longer-needed weights avoids simultaneous VRAM
residency. Both required DiT CPU-offload settings remain enabled. The process
exits after saving the result, preventing residency buildup between cues.

The supported `ACESTEP_GENERATION_TIMEOUT=5400` environment variable is set
before importing ACE. The upstream default of 600 seconds expired during the
first title attempt. A later long-lived Gradio service also exhausted the
extended deadline during `mystery`. These failed requests never reached VAE
decode/file persistence. Their abandoned workers were separately identified
and cleaned up, with failure logs retained in the external archive. Never
immediately submit another model job into a timed-out worker. The local runner
refuses to start while either model-service port is listening; it never stops
another service itself.
