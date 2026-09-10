"""Check publishable Git files without echoing potentially sensitive matches."""
import argparse
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
from urllib.parse import urlsplit

PRIVATE_PARTS = {'exports', 'fb_export', 'private', '.local', '.vps-work', '.gstack', '.wrangler',
                 'data', 'cache', 'state', 'sessions', 'backups', 'node_modules', '__pycache__'}
PRIVATE_SUFFIXES = {'.pem', '.key', '.pfx', '.p12', '.dpapi', '.exe', '.dll', '.asar', '.zip', '.tgz', '.log', '.pyc'}
PRIVATE_NAMES = {'account.json', 'credentials.json', 'session.json', 'tokens.json', 'appsettings.json'}
URL = re.compile(r'(?:https?|vless|vmess|trojan|ss)://[^\s<>"\x27`]+')
PATTERNS = {
    'private-key': re.compile(r'-{5}BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-{5}'),
    'github-token': re.compile(r'\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})\b'),
    'personal-windows-path': re.compile(r'(?i)\b[A-Z]:[\\/]{1,2}Users[\\/]{1,2}(?!Public\b|Default\b|YOUR_USER\b|USERNAME\b|<)[^\\/\s"\x27]+'),
}


def example_host(host):
    return (host in {'localhost', 'example.com', 'example.net', 'example.org'}
            or host.endswith(('.example', '.invalid', '.test', '.example.com', '.example.net', '.example.org'))
            or host.startswith(('192.0.2.', '198.51.100.', '203.0.113.')))


def findings_for(name, data, extra_denied=()):
    path = PurePosixPath(name)
    result = []
    if (any(part.lower() in PRIVATE_PARTS for part in path.parts) or path.suffix.lower() in PRIVATE_SUFFIXES
            or path.name.lower() in PRIVATE_NAMES
            or (path.name.startswith(('.env', '.dev.vars')) and not path.name.endswith('.example'))):
        result.append({'path': name, 'line': 0, 'rule': 'private-or-generated-path'})
    if b'\0' in data:
        result.append({'path': name, 'line': 0, 'rule': 'unexpected-binary-file'})
        return result
    content = data.decode('utf-8-sig', errors='replace')
    for line_number, line in enumerate(content.splitlines(), 1):
        for label, pattern in PATTERNS.items():
            if pattern.search(line):
                result.append({'path': name, 'line': line_number, 'rule': label})
        if any(value and value in line for value in extra_denied):
            result.append({'path': name, 'line': line_number, 'rule': 'private-publication-marker'})
        for match in URL.finditer(line):
            raw = match.group(0)
            try:
                uri = urlsplit(raw)
                host = (uri.hostname or '').lower()
            except ValueError:
                continue
            if not host or any(marker in host for marker in ('$', '{', '}')) or example_host(host):
                continue
            sensitive = (uri.scheme in {'vless', 'vmess', 'trojan', 'ss'}
                         or re.search(r'/s/[A-Za-z0-9_-]{24,}/', uri.path)
                         or re.search(r'(?:^|&)(?:token|key|cred|password|access_token)=[A-Za-z0-9._~%+/-]{16,}', uri.query, re.I))
            if sensitive:
                result.append({'path': name, 'line': line_number, 'rule': 'credential-bearing-url'})
    return result


def scan_repository(root, staged=False, extra_denied=()):
    root = Path(root).resolve()
    command = ['git', 'ls-files', '-z', '--cached']
    if not staged:
        command += ['--others', '--exclude-standard']
    result = subprocess.run(command, cwd=root, check=True, capture_output=True)
    names = sorted(set(name.decode('utf-8') for name in result.stdout.split(b'\0') if name))
    findings = []
    for name in names:
        path = root / name
        if staged:
            mode = subprocess.check_output(['git', 'ls-files', '--stage', '--', name], cwd=root)
            if mode.startswith(b'120000 '):
                findings.append({'path': name, 'line': 0, 'rule': 'symlink-requires-review'})
                continue
            data = subprocess.check_output(['git', 'show', ':' + name], cwd=root)
        else:
            if path.is_symlink() or not path.resolve().is_relative_to(root):
                findings.append({'path': name, 'line': 0, 'rule': 'symlink-requires-review'})
                continue
            if not path.exists():
                continue
            data = path.read_bytes()
        findings.extend(findings_for(name, data, extra_denied))
    return names, findings


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--staged', action='store_true', help='Inspect the complete Git index, not working copies')
    args = parser.parse_args()
    names, findings = scan_repository(args.root, args.staged)
    print(json.dumps({'files_checked': len(names), 'findings': findings}, ensure_ascii=False, indent=2))
    return 1 if findings else 0


if __name__ == '__main__':
    raise SystemExit(main())
