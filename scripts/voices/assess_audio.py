"""Audio-only use of film-assessment's non-intrusive CPU speech scorer."""
import argparse
import os
import subprocess
import sys
from pathlib import Path

from prepare import digest, load, save


def assess(index_path, output, skill):
    os.environ["CUDA_VISIBLE_DEVICES"] = ""
    sys.path.insert(0, str(skill / "scripts"))
    import assess_film

    index = load(index_path)
    paths = [Path(item["path"]) for item in index if not item["id"].startswith("probe-")]
    before = {str(path): digest(path) for path in paths}
    eligible, not_scored = [], []
    for path in paths:
        duration = float(subprocess.run([
            "ffprobe", "-v", "error", "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1", str(path),
        ], check=True, capture_output=True, text=True).stdout.strip())
        if duration < 4:
            not_scored.append({"path": str(path), "duration": duration, "reason": "Below NISQA's four-second minimum; not padded or repeated."})
        else:
            eligible.append(path)
    scores = assess_film.assess_nisqa(eligible)
    after = {str(path): digest(path) for path in paths}
    if before != after:
        raise RuntimeError("Acoustic scoring changed the input masters.")
    save(output, {
        "version": 1, "device": "cpu", "method": "film-assessment.assess_nisqa",
        "decision": "NEEDS_HUMAN_LISTENING", "audio_sha256": before, "scores": scores, "not_scored": not_scored,
        "limitations": "NISQA is a non-intrusive acoustic signal, not acting, semantic or lexical-stress validation. No film motion or final-mix claim applies to these speech-only auditions.",
    })
    print(f"CPU acoustic scoring saved for {len(eligible)} auditions; {len(not_scored)} too short: {output}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--audition-index", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--skill-root", type=Path, default=Path.home() / ".copilot" / "skills" / "film-assessment")
    args = parser.parse_args()
    assess(args.audition_index.resolve(), args.output.resolve(), args.skill_root.resolve())
