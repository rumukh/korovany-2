# Dialogue portraits

The canonical set is 20 NPCs and three adult male player archetypes. `catalog.json`
contains the art direction and individual descriptions. NPC portraits are keyed
by stable `npcId`, never translated names or appearance-faction. The same NPC
image is reused across all campaigns; only the player portrait changes by faction.
Vesk is the current garrison commander, Toman is a miller/councillor, and Ren is
still a working cartwright when serving as the mountain ruler's adviser.

Artwork was generated from original text descriptions using the configured Azure
OpenAI `gpt-image-2` helper. No external images or character references were sent.
The prior voice cast supplied supporting gender/age cues, not visual references
or approval of this new artwork. Unspecified NPC species are not inferred from
the renderer's appearance-faction. Only the explicitly elven player has pointed
ears. The narrator and inspection/evidence overlays have no portrait.

## Assets and provenance

- Delivery: `public\portraits\*.webp`, 320 x 320, WebP quality 84, at most 40 KB per
  image and 700 KB for the complete set. No runtime API or external host is needed.
- `public\portraits\manifest.json`: stable IDs, original prompts, model/settings,
  generation timestamps, source/delivery SHA-256 hashes and generation attribution.
  This file is provenance, not part of the dialogue's runtime bundle.
- Source PNGs and individual helper receipts: the generating session's
  `files\portrait-masters` artifact directory. Initial set:
  `C:\Users\predi\.copilot\session-state\1e60aff9-b6dc-4834-b4d8-91a352bbefbe\files\portrait-masters`.
  Masters are 1024 x 1024 and intentionally not duplicated in the web asset tree.
- Contact sheet: `portrait-masters\contact-sheet.jpg`.

## Regeneration

Requires PowerShell 7, the configured `azure-image-generation` skill helper, and
Python with Pillow for local optimization. Generation is a paid API operation.
Only concise artwork descriptions are sent; no game source or credentials are
written into the catalog, provenance or image prompts.

```powershell
.\scripts\portraits\generate.ps1 -MasterDirectory 'C:\path\to\new-masters'
python .\scripts\portraits\optimize.py 'C:\path\to\new-masters'
```

The generator runs at most three requests concurrently, preserves completed
masters, and checks their receipts before reuse. Changed prompts require a new
master directory rather than overwriting accepted images. Failed entries are
reported explicitly. Inspect every image and the contact sheet before accepting
a new set; do not regenerate merely for subjective taste.

## UI and checks

`src\ui\portraits.ts` owns the small ID catalog, base-relative asset URLs and
localized loading/error status. Ready images have empty alt text because the
speaker name or player role is adjacent. Failures remain visibly and accessibly
reported and logged; they do not remove dialogue text or buttons.
`src\ui\story.ts` renders one NPC image and one compact player image, not an image
on every choice. `portraits.css` is imported through the existing `journal.css`.

```powershell
npm run typecheck
npm test -- tests\portraits.test.ts tests\story-presentation.test.ts
$env:KOROVANY_BROWSER = '1'
$env:KOROVANY_CAPTURE_DIR = 'C:\path\to\portrait-captures'
npm test -- tests\portraits-browser.test.ts
```

The browser checks fully decode all 23 delivery images, exercise real dialogue
in all three factions and both languages at desktop and 360-pixel width, verify
scrolling, keyboard choices/focus and pause/resume, and cover missing mappings
and failed image loads. Screenshots are optional artifacts, not runtime assets.
