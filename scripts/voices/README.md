# Bilingual voice production

This directory owns speech assets only. Story text remains in the narrative
data and snapshot renderer. No browser speech fallback or placeholder public
manifest is generated.

## Inventory and runtime contract

Run `node scripts\voices\export.mjs <external-output-directory>` after installing
the repository's existing dependencies. It writes `inventory.json`, including
source hashes, immutable content-derived entry IDs, segment IDs, source
locations, and per-language duration/cost-scale estimates.

The catalogue covers all 20 NPCs plus `player` and `narrator`: greetings,
local/belief lines, reactions, stage prompts and conditional variants, action
responses, military paragraphs for Mara/Ren/Elin, every player choice type,
inspection evidence/fallback descriptions, and pending/terminal epilogues.
Conservative default prompts are retained even where a prior choice always
selects a variant. Ordinary HUD labels, journal screens, and system error
notices are not spoken; the conquest notice is included when an NPC says it.

`tests/voice-catalogue.test.ts` asserts actual narrative snapshots against the
inventory across branch conditions, outcomes and military states. Story
composition uses blank-line paragraphs. A side epilogue's title and outcome
remain one exact block separated by a **single** newline.

The deployed `public\audio\voices\manifest.json` has this shape:

```json
{"version":1,"entries":[{"id":"stable-id","speaker":"mara","language":"ru","text":"Exact displayed paragraph","clips":[{"src":"audio/voices/ru/mara/clip.ogg","duration":4.2}]}]}
```

Lookup is the exact speaker/language/text tuple after CRLF-to-LF conversion and
outer trim only. Text and spoken IPA are separate. Runtime must preserve
single newlines and queue all clips in order. Content hashes in clip URLs
prevent a new cast revision from replacing an already loaded older clip.

## Audition gate

Use the configured Azure Speech service only. The existing speech-production
skill runtime is `C:\AI\SpeechProduction\.venv`; never place credentials in
files. The skill resolves the configured resource through Azure CLI in memory.

```powershell
$python = 'C:\AI\SpeechProduction\.venv\Scripts\python.exe'
& $python scripts\voices\prepare.py --inventory <inventory.json> --output-dir <prepared-directory>
& $python scripts\voices\audition.py --output-dir <prepared-directory>
```

The seven GA engine voices have four probes each: plain, correct, swapped
stress/phonemes, and a sentinel with unchanged visible text but a different
spoken word. Russian uses three engine timbres (only one male), English four
British English timbres. Twenty profiles are **not** twenty unique actors.
`cast.json` records controlled rate/pitch choices and realistic limitations.
`pronunciation.json` records proposed name stress, inflections and homographs.
`pronunciation-review.json` lists flagged segments for listening.

`auditions-ready.json` contains only existing playable WAVs, ready for the
parent's review studio. It is updated after each completed engine. Low
automated scores are retained, not disguised by weaker thresholds.
The parent must relay human voice/name approval before any full-corpus run.
Do not infer approval from automated PASS.

`audition-provenance.json` is the compact, credential-free record of the
completed audition gate. Regenerate it with `snapshot_metadata.py` from the
inventory, prepared manifest directory and external audition directory.
`repair_audition.py` can replace exactly one identified pronunciation defect
using a changed audition manifest; it refuses text/engine/threshold changes
and retains the original report, SSML and WAV evidence.

## Approved production

After explicit human approval, create an external approval receipt with
`approved: true`, `human_approval_reference`, `parent_session_id`, and the exact
`inventory_source_hash`, `cast_sha256`, `pronunciation_sha256` from
`source-lock.json`. A probe whose sentinel follows but whose target scores
fail additionally requires `accepted_probe_report_sha256[engine]` tied to
human listening. An engine with an ignored sentinel cannot proceed.

```powershell
& $python scripts\voices\produce.py --prepared-dir <prepared-directory> --output-dir <external-masters> --approval <approval.json> --engine ruD
```

Repeat for each engine in `cast.json`. Requests and receipts are hash-bound and
resumable. Identical audition masters are reused. No automatic resynthesis or
score chasing occurs. There is no time compression; maximum fit factor is
1.0. Raw 24 kHz mono PCM and conformed lossless masters stay outside the repo.
To repair an actual bad segment, use a new revision rather than overwriting
the approved evidence.

Acoustic scoring uses the existing film-assessment CPU implementation:

```powershell
& 'C:\AI\Wan2GP\env_uv\Scripts\python.exe' scripts\voices\assess_audio.py --audition-index <auditions-ready.json> --output <acoustic-report.json>
```

NISQA is a listening aid, not a stress, acting or semantic verdict. It does not
run on GPU or assess game-music balance.

## Publish and assert coverage

```powershell
& $python scripts\voices\publish.py --inventory <inventory.json> --production-dir <external-masters> --public-dir public
node scripts\voices\verify.mjs <inventory.json> public
```

Publishing requires **all** inventory segments, matching text/hashes, no
technical defects, and no unreviewed score flags. A human-reviewed metric
false alarm can be retained via `--review <review.json>`, containing
`accepted_segments[id]` with `accepted: true`, `audio_sha256`, and
`human_review_reference`. Technical defects cannot be overridden.
The review is recorded separately; an automated failure is never relabeled
automated PASS.

Deployment uses 24 kHz mono Vorbis quality 3, fully decoded and duration-checked.
The runtime manifest is published last. The provenance manifest records
source/cast approval, master/delivery formats, retained limitations and every
clip hash. Commit only scripts, compact metadata and compressed deployment
assets; never commit the external WAV masters or cloud credentials.
