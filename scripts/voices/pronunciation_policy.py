"""Shared pronunciation policy; listening references are never enforcement evidence."""
from xml.etree import ElementTree

ENFORCED = "phoneme-enforced"
NATURAL = "natural-reviewed"


def pronunciation_mode(document):
    mode = document.get("pronunciation_mode", ENFORCED)
    if mode not in (ENFORCED, NATURAL):
        raise RuntimeError(f"Unknown pronunciation_mode: {mode!r}")
    return mode


def natural_metadata(segment):
    targets, expected = segment.get("target_words"), segment.get("expected_ipa")
    if (not isinstance(targets, list) or not isinstance(expected, list) or len(targets) != len(expected)
            or not all(isinstance(value, str) and value for value in targets + expected)):
        raise RuntimeError("Natural pronunciation targets need corresponding expected IPA listening references.")
    return {
        "pronunciation_mode": NATURAL, "phoneme_enforced": False,
        "required_ipa": [], "target_words": targets, "expected_ipa": expected,
        "pronunciation_review_required": bool(targets),
    }


def retain_natural_review(receipt, source):
    receipt.update(natural_metadata(source))
    if receipt["pronunciation_review_required"]:
        receipt["checks"]["pronunciation_review"] = False
        receipt["decision"] = "NEEDS_REVIEW"
    return receipt


def validate_natural_segment(segment):
    if any(segment.get(key) != value for key, value in natural_metadata(segment).items()):
        raise RuntimeError("Natural segment lost its pronunciation policy or listening references.")
    root = ElementTree.fromstring(segment["ssml"])
    namespace = "{http://www.w3.org/2001/10/synthesis}"
    if (root.tag != namespace + "speak" or len(root) != 1 or root[0].tag != namespace + "voice"
            or len(root[0]) or root[0].get("name") != segment["voice"]
            or root.text or root[0].tail or (root[0].text or "") != segment["text"]):
        raise RuntimeError("Natural SSML must preserve exact plaintext without phonemes or prosody.")


def validate_natural_receipt(receipt, source=None):
    expected = natural_metadata(source or receipt)
    if any(receipt.get(key) != value for key, value in expected.items()):
        raise RuntimeError("Natural receipt lost its pronunciation policy or listening references.")
    if expected["pronunciation_review_required"] and (
        receipt["checks"].get("pronunciation_review") is not False or receipt["decision"] == "PASS"
    ):
        raise RuntimeError("Natural pronunciation requires a persistent false review check, not automated approval.")
