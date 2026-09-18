"""Narrow offline correction of target-token bookkeeping; no audio or threshold edits."""
import copy
import re


def canonical(word):
    return word.casefold().replace("’", "'")


def correct_possessive_targets(receipt, minimum=90):
    if not receipt["id"].startswith("en-") or not receipt.get("words"):
        return receipt
    source_words = re.findall(r"[^\W\d_]+(?:['’]s)?", receipt["text"])
    occurrences = receipt.get("target_occurrences", [])
    source_cursor, word_cursor, corrected, changes = 0, 0, [], []
    words = receipt["words"]
    for occurrence in occurrences:
        target = canonical(occurrence["target"])
        source_index = next((i for i in range(source_cursor, len(source_words))
                             if canonical(source_words[i]) in (target, target + "'s")), None)
        if source_index is None:
            return receipt
        source_cursor = source_index + 1
        lexeme = canonical(source_words[source_index])
        current = copy.deepcopy(occurrence)
        if lexeme == target + "'s" and occurrence["matched_word"] is None:
            match = next((i for i in range(word_cursor, len(words)) if canonical(words[i]["Word"]) == lexeme), None)
            if match is not None:
                word = words[match]
                assessment = word.get("PronunciationAssessment", {})
                score = assessment.get("AccuracyScore")
                if assessment.get("ErrorType") == "None" and isinstance(score, (int, float)):
                    current.update(matched_word=word["Word"], word_index=match, accuracy_score=score)
                    changes.append({"target": occurrence["target"], "source_lexeme": source_words[source_index],
                                    "assessment_word": word["Word"], "word_index": match, "accuracy_score": score,
                                    "reason": "Source and assessed token both include possessive suffix; original target extractor dropped it."})
        if current.get("word_index") is not None:
            word_cursor = current["word_index"] + 1
        corrected.append(current)
    if not changes:
        return receipt
    result = copy.deepcopy(receipt)
    result["target_occurrences"] = corrected
    result["checks"]["target_pronunciation"] = all(item.get("accuracy_score") is not None and item["accuracy_score"] >= minimum
                                                  for item in corrected)
    result["decision"] = "PASS" if all(result["checks"].values()) else "NEEDS_REVIEW"
    result["metric_correction"] = {
        "kind": "exact-source-possessive-token-match", "audio_unchanged_sha256": receipt["final_sha256"],
        "original_decision": receipt["decision"], "original_checks": receipt["checks"],
        "minimum_target_accuracy_unchanged": minimum, "changes": changes,
    }
    return result
