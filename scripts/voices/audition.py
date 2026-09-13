"""Run only the finite audition/probe set; no full-corpus synthesis entry point."""
import argparse
import subprocess
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

from prepare import digest, load, save


def audition(root, skill):
    index = load(root / "audition-index.json")
    lock = load(root / "source-lock.json")
    reports = {}
    ready = []
    for manifest in sorted((root / "manifests").glob("audition-*.json")):
        if digest(manifest) != lock["manifest_sha256"][manifest.name]:
            raise RuntimeError(f"Manifest changed after preparation: {manifest.name}")
        engine = manifest.stem.removeprefix("audition-")
        output = root / "engines" / engine
        report_path = output / "production-report.json"
        if not report_path.exists():
            output.parent.mkdir(parents=True, exist_ok=True)
            with (root / f"{engine}.log").open("w", encoding="utf-8") as log:
                result = subprocess.run([sys.executable, str(skill / "scripts" / "speech_production.py"),
                                         "--manifest", str(manifest), "--output-dir", str(output)],
                                        stdout=log, stderr=subprocess.STDOUT)
            if result.returncode not in (0, 2) or not report_path.exists():
                raise RuntimeError(f"Audition interrupted for {engine}; see {root / (engine + '.log')}")
        report = load(report_path)
        source = load(manifest)
        if report.get("default_voice") != source["default_voice"]:
            raise RuntimeError(f"Audition report engine mismatch: {engine}")
        for segment in source["segments"]:
            recorded = next(s for s in report["segments"] if s["id"] == segment["id"])
            if recorded["text"] != segment["text"] or Path(recorded["ssml_path"]).read_text(encoding="utf-8") != segment["ssml"]:
                raise RuntimeError(f"Audition report source mismatch: {segment['id']}")
        reports[engine] = {
            "decision": report["decision"], "capability_probe": report["capability_probe"],
            "summary": report["summary"], "report_path": str(report_path),
            "report_sha256": digest(report_path),
        }
        for role in [item for item in index if item["engine"] == engine]:
            chunks = []
            for identifier in role["segment_ids"]:
                segment = next(s for s in report["segments"] if s["id"] == identifier)
                path = Path(segment["final_path"])
                if digest(path) != segment["final_sha256"]:
                    raise RuntimeError(f"Changed audition segment {identifier}")
                samples, rate = sf.read(path, dtype="float32", always_2d=True)
                if rate != 48000 or samples.size == 0:
                    raise RuntimeError(f"Unexpected audition format {identifier}")
                chunks.extend([samples, np.zeros((round(0.16 * rate), samples.shape[1]), dtype="float32")])
            base_target = Path(role["path"])
            target = base_target.with_stem(f"{base_target.stem}-{digest(report_path)[:10]}")
            target.parent.mkdir(parents=True, exist_ok=True)
            sf.write(target, np.concatenate(chunks[:-1]), 48000, subtype="PCM_24")
            flagged = [s["id"] for s in report["segments"] if s["id"] in role["segment_ids"] and s["decision"] != "PASS"]
            ready.append({k: v for k, v in role.items() if k not in ("segment_ids", "engine")} | {
                "path": str(target), "sha256": digest(target), "automated_flagged_ids": flagged,
                "note": role["note"] + (" Automated review flags: " + ", ".join(flagged) if flagged else ""),
            })
        for variant, item in report["capability_probe"]["variants"].items():
            ready.append({
                "id": f"probe-{engine}-{variant}", "title": f"{report['default_voice']} - {variant} phoneme probe",
                "language": report["language"][:2], "voice": report["default_voice"],
                "path": item["audio_path"], "text": load(manifest)["capability_probe"]["reference_text"],
                "kind": "voice", "sha256": item["audio_sha256"],
                "note": f"Probe, not story audio. ASR: {item['transcription']}. Engine sentinel followed: "
                        f"{report['capability_probe']['sentinel_followed']}. Human stress/name listening required.",
            })
        save(root / "auditions-ready.json", ready)
        save(root / "audition-report.json", {"version": 1, "engines": reports, "human_approval": "pending"})
        print(f"{engine}: {report['decision']}; playable roles/probes available: {len(ready)}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--skill-root", type=Path, default=Path.home() / ".copilot" / "skills" / "speech-production")
    args = parser.parse_args()
    audition(args.output_dir.resolve(), args.skill_root.resolve())
