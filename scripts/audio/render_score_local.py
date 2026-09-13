"""One full-quality score cue per process using the installed ACE Python API.

The vLLM planner is unloaded after its completed semantic plan, before diffusion.
This preserves planning quality without retaining two model runtimes in VRAM.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import gc
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import uuid


ACE = Path(r"C:\AI\ACE-Step-1.5")
RECIPE = json.loads(Path(__file__).with_name("score-cues.json").read_text(encoding="utf-8"))
ARCHIVE = ACE / "outputs" / RECIPE["production"]
os.environ["ACESTEP_GENERATION_TIMEOUT"] = "5400"
sys.path.insert(0, str(ACE))


def save_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def port_is_listening(port: int) -> bool:
    with socket.socket() as probe:
        probe.settimeout(2)
        return probe.connect_ex(("127.0.0.1", port)) == 0


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("cue", choices=[item["id"] for item in RECIPE["cues"]])
    args = parser.parse_args()
    cue = next(item for item in RECIPE["cues"] if item["id"] == args.cue)
    output = ACE / "outputs" / f"{RECIPE['production']}-{cue['id']}.flac"
    metadata_path = output.with_suffix(".json")
    if output.exists() or metadata_path.exists():
        raise RuntimeError(f"Refusing to overwrite an existing original: {output}")
    if port_is_listening(7860) or port_is_listening(7865):
        raise RuntimeError("A model service is listening; do not overlap another model generation.")
    ARCHIVE.mkdir(parents=True, exist_ok=True)
    runner_hash = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    runner_archive = ARCHIVE / "tooling" / f"render-score-{runner_hash}.py"
    runner_archive.parent.mkdir(parents=True, exist_ok=True)
    if not runner_archive.exists():
        shutil.copyfile(__file__, runner_archive)
    os.chdir(ARCHIVE)

    import numpy as np
    import torch
    from acestep.handler import AceStepHandler
    from acestep.inference import GenerationConfig, GenerationParams, generate_music
    from acestep.llm_inference import LLMHandler

    if not torch.cuda.is_available() or "4070 Ti SUPER" not in torch.cuda.get_device_name():
        raise RuntimeError("The validated 16GB GPU is unavailable.")

    class SingleUsePlanner(LLMHandler):
        def generate_with_stop_condition(self, *arguments, **keywords):
            result = super().generate_with_stop_condition(*arguments, **keywords)
            if not result.get("success"):
                raise RuntimeError(f"Semantic planning failed: {result.get('error')}")
            if not result.get("audio_codes"):
                raise RuntimeError("Semantic planner returned no audio codes.")
            save_json(ARCHIVE / "plans" / f"{cue['id']}.json", {
                "model": RECIPE["planner"], "backend": "vllm", "seed": cue["seed"],
                "metadata": result["metadata"], "audio_codes": result["audio_codes"],
                "time_costs": result.get("extra_outputs", {}).get("time_costs", {}),
            })
            before = torch.cuda.memory_allocated()
            self.unload()
            gc.collect()
            torch.cuda.synchronize()
            torch.cuda.empty_cache()
            if self.llm is not None or self.llm_initialized:
                raise RuntimeError("Completed planner did not unload; refusing overlapping model residency.")
            print(f"PLANNER_UNLOADED allocated_before={before} allocated_after={torch.cuda.memory_allocated()}", flush=True)
            return result

    dit = AceStepHandler()
    status, success = dit.initialize_service(
        project_root=str(ACE), config_path=RECIPE["model"], device="cuda",
        use_flash_attention=True, compile_model=False, offload_to_cpu=True,
        offload_dit_to_cpu=True, quantization="int8_weight_only",
    )
    if not success:
        raise RuntimeError(f"XL-SFT initialization failed: {status}")
    if dit.quantization != "int8_weight_only" or not dit.offload_to_cpu or not dit.offload_dit_to_cpu:
        raise RuntimeError("Required quantization/offload settings were not retained.")
    planner = SingleUsePlanner()
    status, success = planner.initialize(
        checkpoint_dir=str(ACE / "checkpoints"), lm_model_path=RECIPE["planner"],
        backend="vllm", device="cuda", offload_to_cpu=True,
    )
    if not success or planner.llm_backend != "vllm":
        raise RuntimeError(f"Required vLLM planner initialization failed: {status}")

    duration = cue["duration"] + cue["crossfade"]
    params = GenerationParams(
        task_type="text2music", caption=cue["prompt"], lyrics="[Instrumental]", instrumental=True,
        bpm=cue["bpm"], duration=duration, keyscale=cue["key"], timesignature=cue["meter"],
        vocal_language="en", inference_steps=50, guidance_scale=7.0, shift=3.0,
        infer_method="ode", seed=cue["seed"], thinking=True, use_cot_caption=True,
        use_cot_language=True, use_constrained_decoding=True,
    )
    config = GenerationConfig(
        batch_size=1, allow_lm_batch=False, use_random_seed=False,
        seeds=[cue["seed"]], lm_batch_chunk_size=1, audio_format="flac",
    )
    result = generate_music(dit_handler=dit, llm_handler=planner, params=params, config=config,
                            save_dir=str(ARCHIVE / "native" / cue["id"]))
    if not result.success or len(result.audios) != 1:
        raise RuntimeError(f"Score generation failed: {result.error or result.status_message}")
    audio = result.audios[0]
    actual = audio["params"]
    for key, expected in {"seed": cue["seed"], "inference_steps": 50, "shift": 3.0,
                          "guidance_scale": 7.0, "infer_method": "ode"}.items():
        if actual[key] != expected:
            raise RuntimeError(f"Actual generated parameter differs: {key}={actual[key]}")
    shutil.copyfile(audio["path"], output)
    probe = json.loads(subprocess.check_output(
        ["ffprobe", "-v", "error", "-show_entries",
         "format=duration,format_name:stream=codec_type,codec_name,sample_rate,channels",
         "-of", "json", str(output)], text=True,
    ))
    data = subprocess.check_output(["ffmpeg", "-v", "error", "-i", str(output), "-f", "f32le", "-"])
    samples = np.frombuffer(data, dtype="<f4")
    peak = float(np.max(np.abs(samples)))
    if not np.all(np.isfinite(samples)) or peak < .001 or peak >= .9999:
        raise RuntimeError("Generated source is empty, silent, nonfinite or clipping.")
    if abs(float(probe["format"]["duration"]) - duration) > .01:
        raise RuntimeError("Generated source has the wrong duration.")
    request = {
        "prompt": cue["prompt"], "lyrics": "[Instrumental]", "thinking": True,
        "use_format": False, "model": RECIPE["model"], "vocal_language": "en",
        "audio_duration": duration, "inference_steps": 50, "guidance_scale": 7.0,
        "use_random_seed": False, "seed": cue["seed"], "batch_size": 1,
        "task_type": "text2music", "infer_method": "ode", "shift": 3.0,
        "audio_format": "flac", "use_tiled_decode": True, "lm_model_path": RECIPE["planner"],
        "lm_backend": "vllm", "constrained_decoding": True, "use_cot_caption": True,
        "use_cot_language": True, "bpm": cue["bpm"], "key_scale": cue["key"],
        "time_signature": cue["meter"],
    }
    save_json(metadata_path, {
        "task_id": str(uuid.uuid4()), "generated_at": datetime.now(timezone.utc).isoformat(),
        "request": request, "actual_parameters": actual, "result": {
            "file": str(output), "native_file": audio["path"], "seed": cue["seed"],
        }, "probe": probe, "maximum_volume_db": 20 * float(np.log10(peak)),
        "generation_route": "supported ACE Python API, one cue per process",
        "planner_unloaded_before_diffusion": True,
        "runner_sha256": runner_hash, "runner_path": str(runner_archive),
    })
    print(f"FINAL_AUDIO={output}\nMETADATA={metadata_path}\nSEED={cue['seed']}", flush=True)


if __name__ == "__main__":
    main()
