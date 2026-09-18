# Bilingual voice production

This directory owns speech assets only. Story text remains in the narrative
data and snapshot renderer. No browser speech fallback or placeholder public
manifest is generated.

## Approved three-faction recording

On 2026-09-18, the user explicitly selected **"Approve the complete recording
with documented flags; integrate it"** after the separate final-recording review.
This release is bound to review-lock SHA-256
`374e61d2a6461380a0c511775915fdf4db47ed5e39ab796afbaffdd4edb909a4`
and source inventory
`aae9981aee2e22e981957764e2071aeb5cb8cb0a24b7355287a4a8be4e23ad99`.
It accepts the unchanged complete recording with disclosed caveats, not a claim
that every flagged line was individually heard. No release-time resynthesis,
time compression, or threshold lowering was performed.

The recording contains **1,332 blocks / 3,772 segment references / 3,115 unique
Ogg clips**, with 666 blocks per language. Unique speech is 9,498.72121 seconds
(about 158.3 minutes), and the mono 24 kHz Vorbis quality-3 payload is 70,827,433
bytes. Of the unique masters, 1,370 reuse historical approved audio, 30 reuse the
new accepted samples, and 1,715 were additionally generated. Historical Oggs and
all final staged clips are copied byte-for-byte for local integration.

All masters and delivery clips pass technical checks. **403 automated metric
flags remain**: 135 were covered by acceptance of exact unchanged recordings
and 268 were new at the final review. Sixty-three exact-source possessive-token
bookkeeping corrections retain original evidence and thresholds. Full-file ASR
corroborated 183 flagged references, without treating recognition as approval.
Short Russian `Нет.` and `Да.` remain NoMatch cases; the English chapter
`I. Walls That Burn` was transcribed as `One wolves that burn`, not asserted to
be a proven speaking error. These and name/chapter/function-word alignment
caveats were disclosed before the final decision.

CPU NISQA covered 44 complete speaker/language representatives, with a minimum
score of 4.4438. The unchanged historical Russian Ivet block retains its earlier
accepted 3.8962 score and a separate listening entry. The new representative
scores do not erase that caveat or certify pronunciation, acting or every line.
Current `public\audio\voices\provenance.json` retains the exact release response,
scope, frozen lock, all metric flags, source/cast settings and Ogg hashes.

The current extractor reads `getFactionStory` from the local checkout, not the
historical global story or remote narrative. It covers all three factions, nine
terminal epilogues, selected intermediate main-story decisions, and all side
outcomes. Military speech preserves its exact single-newline checklist. The
catalogue enumerates only reachable completion projections: orders precede
supply/delivery, guard defense precedes those tasks, the pursuit quarry requires
the protected delivery and supplied palace, and the commander follows readiness.

The frozen faction inventory contains 1,332 bilingual blocks and 3,772
segment references. Exact speaker/text/engine/SSML/quality deduplication yields
3,115 renders: 1,370 reuse historical approved masters and 1,745 belong to this
new production, including its 30 accepted sample masters. Shared render
receipts and clip URLs avoid recording the same military requirement repeatedly.
`reuse.py` verifies the old informed release, frozen master index, and every
candidate WAV/SSML hash before carrying over anything. A new line never inherits
old listening approval merely because it has the same speaker.
Use `publish.py --stage-only --reused-staging <historical-staging-root>` to copy
matching historical Oggs without re-encoding; both their encoded hashes and
lossless master hashes must match.

The cast is unchanged. The new regular Russian `Марой` inflection retains the
approved stress of `Мара`; English `read` uses audited past/present contexts.
Unknown contexts fail preparation instead of silently choosing a pronunciation.
`prepare.py --samples <selectors.json>` selects finite representative new lines
without changing the approved cast file. It records the preparer and selection
hashes alongside all manifests. The current selectors are retained in
`faction-samples.json`; the selectors inside the unchanged cast file describe
the historical corpus only. `review.py --index <auditions-ready.json> --port
<local-port>` provides a loopback-only, hash-checked listening page.

The user's regeneration request authorizes generation using the established
cast; it is not final listening approval. Fresh flagged probe reports still need
explicit, hash-bound human acceptance. A generation receipt for this workflow
uses `approval_kind: "existing-cast-regeneration"` and binds `reuse_plan_sha256`.
Pass the same plan to `produce.py --reuse-plan` and `qa_corpus.py --reuse-plan`.
Publishing this new corpus requires its own informed final recording release
even if all automated scores pass. Pending that decision, only external
`publish.py --stage-only` output is permitted.

Voice playback shares one gesture-unlocked `Soundscape` with the published
recorded soundtrack, regional ambience and effects. Master, music, ambience,
effects and voices have independent persistent gains; dialogue ducks music.
Effects and voices share one bounded 24 MiB decoded-audio cache, while music and
ambience stream. There is no duplicate voice transport or browser speech
synthesis. Player choices precede NPC replies, with narrator
inspection/ending queues, bounded decoded-audio caching, explicit missing-asset
warnings, and cancellation on scene, focus, pause, language and lifecycle changes.
Transport fixtures run with `KOROVANY_BROWSER=1` and
`tests\voice-browser.test.ts`; they are explicitly not speech acceptance.
After final authorized publication, also set `KOROVANY_VOICE_ASSETS=1` and run
`tests\voice-assets-browser.test.ts`: every unique Ogg is fully decoded with
native-sample-rate-aware Vorbis priming tolerance, and actual RU/EN dialogue and
all nine ending queues run through the production transport.
Before human release, the same real-media suite may set `KOROVANY_VOICE_STAGING`
to the external staging root. Its isolated HTTP server exposes the complete
staging index only to that test; it writes no runtime manifest and cannot publish
or approve recordings.

Final QA provides 44 speaker/language representative blocks plus a separate
`campaign-index.json` containing all faction openings and nine ending roots in
both languages. These are complete recorded blocks, not replacement prose.

## Historical released recording (not new-corpus approval)

The final recording was explicitly approved on 2026-09-16: "Approve the final
recording with the documented flags; integrate it". This separate informed
release covers the unchanged frozen recording, not merely the earlier cast
auditions. The provenance distinguishes receipt capture time from the unavailable
exact user-message timestamp.

The previous release contained **698 blocks / 2,265 clips**, with 349 blocks per
language and all 20 NPCs plus player/narrator. Its unique spoken duration is
6,417.392448 seconds (about 107 minutes); the Ogg payload is 48,229,701 bytes.
Seventy previously auditioned segment masters were reused verbatim.
No final-release resynthesis or time compression was performed.

The recording retains **227 automated flags**, including eight previously
approved audition segments and 219 new flags accepted in the final release.
They are not relabeled automated PASS, and release acceptance does not claim
that every flagged line was individually heard. Thirty-two exact English
possessive-token bookkeeping corrections preserve the original evidence.
Short Russian words/names, function-word alignment, and spoken chapter numbers
remain recognition caveats. CPU acoustic scoring covered 44 speaker/language
representative blocks: Russian Ivet scored about 3.90 MOS, while the other 43
scored above 4.7. These scores do not certify words, stress, or acting.

Its original release evidence, line-sized lossless masters, SSML, assessment
receipts, frozen listening indices and complete master hashes remain unchanged
in the historical external production archive. New-corpus approval is separate.

## Inventory and runtime contract

Run `node scripts\voices\export.mjs <external-output-directory>` after installing
the repository's existing dependencies. It writes `inventory.json`, including
source hashes, immutable content-derived entry IDs, segment IDs, source
locations, and per-language duration/cost-scale estimates.

The catalogue covers all 20 NPCs plus `player` and `narrator`: greetings,
local/belief lines, reactions, stage prompts and conditional variants, action
responses, military paragraphs for Toman/Vesk/Ren/Elin and finale speakers,
every player choice type, inspection evidence/fallback descriptions, and
all nine terminal epilogues.
Conservative default prompts are retained even where a prior choice always
selects a variant. Ordinary HUD labels, journal screens, and system error
notices are not spoken. Current military status is included when appended to
the finale's spoken prompt.

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
& $python scripts\voices\prepare.py --inventory <inventory.json> --output-dir <prepared-directory> --samples scripts\voices\faction-samples.json
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
resumable. `--workers 2` runs bounded independent requests; the maximum is eight
workers per process. Receipts are emitted immediately and final reports retain
manifest order. Failed request IDs are recorded explicitly for a later resume.
Identical audition masters **and their assessment** are reused. New assessment
results are cached before independent transcription so a network interruption
does not discard completed work. No automatic resynthesis or
score chasing occurs. There is no time compression; maximum fit factor is
1.0. Raw 24 kHz mono PCM and conformed lossless masters stay outside the repo.
To repair an actual bad segment, use a new revision rather than overwriting
the approved evidence.

Run `python scripts\voices\test_pipeline.py` for offline approval/concurrency/
resume regression checks. These use a mock backend, not Azure.

Acoustic scoring uses the existing film-assessment CPU implementation:

```powershell
& 'C:\AI\Wan2GP\env_uv\Scripts\python.exe' scripts\voices\assess_audio.py --audition-index <auditions-ready.json> --output <acoustic-report.json>
```

NISQA is a listening aid, not a stress, acting or semantic verdict. It does not
run on GPU or assess game-music balance.

`qa_corpus.py` checks every persisted master/SSML hash, preserves automated
flags, and builds playable review and whole-block representative indexes.
Its approval carry-forward applies only to byte-identical audition masters.
`metric_evidence.py` corrects one proven bookkeeping issue offline: an English
target such as `Raut` assessed as the exact source possessive `Raut's` is not a
missing name. Original scores/checks remain in the correction record; the
unchanged minimum target score still applies. No new audio is made.
`transcribe_flags.py` supports one cached full-file Azure ASR pass when a
single-utterance result appears incomplete. A repeated recognition result is
evidence, not an automatic pronunciation or human-listening approval.

`freeze_review.py --qa-dir <qa> --asr-dir <asr> --production-dir <masters>
--output-dir <new-review>` freezes listening indices, corroboration, retained
metrics, and all final master hashes. The final review lock can bind an informed
human decision accepting unchanged recordings with disclosed metric limitations;
that is not a claim that every raw flag was individually heard or automatically
passed. `record_release.py --review-dir <frozen-review> --decision <relayed-human.json>
--output <release-review.json>` requires that explicit decision and verifies its
lock before generating hash-bound acceptance records.

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

While an informed release decision is pending, `publish.py --stage-only` may
encode and decode-check clips **outside the repository**. It writes only
`staging-index.json`, never a runtime manifest or final provenance. After approval,
normal publishing with `--review <release-review.json> --staged-dir <staging-public>`
validates and copies the exact staged Oggs without synthesizing or re-encoding.
The normal publish guard still applies to every retained metric flag.

Deployment uses 24 kHz mono Vorbis quality 3, fully decoded and duration-checked.
Existing hash-addressed Oggs are verified and reused on resume, never blindly
re-encoded. The runtime manifest is published last. The provenance manifest records
source/cast approval, master/delivery formats, retained limitations and every
clip hash. Commit only scripts, compact metadata and compressed deployment
assets; never commit the external WAV masters or cloud credentials.
