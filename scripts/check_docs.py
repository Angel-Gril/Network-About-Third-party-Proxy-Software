"""Check local Markdown links against the repository's actual files."""
import argparse
import json
from pathlib import Path
import re
import subprocess
from urllib.parse import unquote, urlsplit


def check_links(document, root):
    document, root = Path(document).resolve(), Path(root).resolve()
    findings = []
    fenced = False
    for number, line in enumerate(document.read_text(encoding="utf-8-sig").splitlines(), 1):
        if line.lstrip().startswith(("```", "~~~")):
            fenced = not fenced
            continue
        if fenced:
            continue
        for match in re.finditer(r"\]\((<[^>]+>|[^\s)]+)(?:\s+[^)]*)?\)", line):
            target = match.group(1).strip("<>")
            uri = urlsplit(target)
            if uri.scheme in {"https", "http", "mailto"} or not uri.path:
                continue
            resolved = (document.parent / unquote(uri.path)).resolve()
            if uri.scheme or not resolved.is_relative_to(root) or not resolved.exists():
                findings.append({"path": document.relative_to(root).as_posix(), "line": number, "target": target})
    return findings


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    root = args.root.resolve()
    names = subprocess.check_output(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd=root
    ).split(b"\0")
    documents = sorted({root / name.decode("utf-8") for name in names if name.endswith(b".md")})
    findings = [finding for document in documents if document.exists() for finding in check_links(document, root)]
    print(json.dumps({"documents_checked": len(documents), "broken_links": findings}, ensure_ascii=False, indent=2))
    return 1 if findings else 0


if __name__ == "__main__":
    raise SystemExit(main())
