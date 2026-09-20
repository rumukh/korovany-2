"""Local-only listening page for an explicit, hash-checked voice review index."""
import argparse
import html
import json
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote, urlparse

from prepare import digest, load


def serve(index_path, port):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            route = urlparse(self.path).path
            try:
                items = load(index_path)
                if route == "/":
                    cards = []
                    groups = []
                    for item in items:
                        memberships = item.get("review_groups", ["Phoneme probes" if item["id"].startswith("probe-") else "Samples"])
                        for group in memberships:
                            if group not in groups:
                                groups.append(group)
                        label = "Previously accepted identical recording" if item.get("already_human_approved") else "Current review recording"
                        references = list(zip(item.get("target_words", []), item.get("expected_ipa", [])))
                        if not references and item.get("expected_ipa"):
                            references = list(zip([target["target"] for target in item.get("target_occurrences", [])],
                                                  item["expected_ipa"]))
                        references.extend((word, ipa) for segment in item.get("pronunciation_review_targets", [])
                                          for word, ipa in zip(segment["target_words"], segment["expected_ipa"]))
                        reference_note = ("<p>Expected IPA (listening references, not proof): "
                                          + html.escape("; ".join(f"{word}: {ipa}" for word, ipa in references)) + "</p>") if references else ""
                        cards.append(
                            f'<article data-groups="{html.escape(json.dumps(memberships), quote=True)}" '
                            f'data-language="{html.escape(item["language"], quote=True)}">'
                            f'<h2>{html.escape(item["title"])}</h2><p>{label} | '
                            f'{html.escape(item["language"])} | {html.escape(item["voice"])}</p>'
                            f'<audio controls preload="none" src="/audio/{quote(item["id"])}"></audio>'
                            f'<p>{html.escape(item["text"])}</p><p class="note">{html.escape(item["note"])}</p>'
                            f'{reference_note}'
                            f'<small>{html.escape(item["id"])}</small></article>'
                        )
                    choices = "".join(f'<option value="{html.escape(group, quote=True)}">{html.escape(group)}</option>' for group in groups)
                    page = ('<!doctype html><html lang="en"><meta charset="utf-8">'
                            '<meta name="viewport" content="width=device-width,initial-scale=1">'
                            '<title>Korovany II - recording review</title><style>'
                            'body{max-width:1000px;margin:2rem auto;padding:0 1rem;background:#152021;color:#eee9d9;'
                            'font:16px/1.5 system-ui}article{border:1px solid #647169;padding:1rem;margin:1rem 0}'
                            'h2{font-size:1.1rem}audio{width:100%}.note,small{color:#c9c2a9}</style>'
                            '<h1>Korovany II - recording review</h1>'
                            '<p><strong>Listening is separate from approval.</strong> Cast and pronunciation mode are revision-specific. New recordings '
                            'are not covered by the old final-recording approval. Automated flags remain flags. '
                            'Probe sentinel words are deliberately different from the displayed token.</p>'
                            '<p>Review retained pronunciation and recognition flags in the notes. Sentinel success '
                            'proves payload control, not naturalness or correct stress. Human decisions are recorded '
                            'separately; natural-reviewed delivery does not enforce IPA. Decisions are bound '
                            'to immutable hashes, never inferred from this player.</p>'
                            '<label>Review group <select id="group">' + choices + '<option value="">Everything</option></select></label>'
                            '<label> Language <select id="language"><option value="">Both</option>'
                            '<option value="ru">Russian</option><option value="en">English</option></select></label>'
                            '<p><label>Find text, speaker or clip ID <input id="search" type="search"></label></p>'
                            '<p id="count" role="status" aria-live="polite"></p>'
                            + "".join(cards) + '<script>'
                            'const select=document.querySelector("#group");'
                            'const language=document.querySelector("#language"),search=document.querySelector("#search");'
                            'function filter(){let visible=0;const query=search.value.trim().toLocaleLowerCase();'
                            'for(const card of document.querySelectorAll("article")){'
                            'card.hidden=(Boolean(select.value)&&!JSON.parse(card.dataset.groups).includes(select.value))'
                            '||(Boolean(language.value)&&card.dataset.language!==language.value)'
                            '||(Boolean(query)&&!card.textContent.toLocaleLowerCase().includes(query));'
                            'if(card.hidden)card.querySelector("audio").pause();else visible++;}'
                            'document.querySelector("#count").textContent=visible+" recordings shown";}'
                            'select.addEventListener("change",filter);language.addEventListener("change",filter);'
                            'search.addEventListener("input",filter);filter();'
                            'document.addEventListener("play",event=>{for(const audio of document.querySelectorAll("audio"))'
                            'if(audio!==event.target)audio.pause();},true);'
                            '</script></html>').encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "text/html; charset=utf-8")
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("Content-Length", str(len(page)))
                    self.end_headers()
                    self.wfile.write(page)
                    return
                if route.startswith("/audio/"):
                    identifier = unquote(route.removeprefix("/audio/"))
                    item = next((item for item in items if item["id"] == identifier), None)
                    if item is None:
                        self.send_error(404, "Unknown review sample")
                        return
                    path = Path(item["path"])
                    if digest(path) != item["sha256"]:
                        self.send_error(409, "Review sample changed")
                        return
                    size = path.stat().st_size
                    start, end = 0, size - 1
                    requested = self.headers.get("Range")
                    if requested:
                        match = re.fullmatch(r"bytes=(\d+)-(\d*)", requested)
                        if not match:
                            self.send_error(416, "Unsupported byte range")
                            return
                        start = int(match[1])
                        end = min(int(match[2]) if match[2] else size - 1, size - 1)
                        if start > end:
                            self.send_error(416, "Invalid byte range")
                            return
                    self.send_response(206 if requested else 200)
                    self.send_header("Content-Type", "audio/wav")
                    self.send_header("Accept-Ranges", "bytes")
                    self.send_header("Content-Length", str(end - start + 1))
                    if requested:
                        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
                    self.end_headers()
                    with path.open("rb") as stream:
                        stream.seek(start)
                        self.wfile.write(stream.read(end - start + 1))
                    return
                self.send_error(404, "Unknown review route")
            except (OSError, ValueError, KeyError) as error:
                print(f"Review request failed: {error}", flush=True)
                self.send_error(500, "Review artifact unavailable; see server log")

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(json.dumps({"url": f"http://127.0.0.1:{server.server_port}", "index": str(index_path)}), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--index", type=Path, required=True)
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    serve(args.index.resolve(), args.port)
