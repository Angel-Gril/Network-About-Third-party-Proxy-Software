"""Validate this repository's distributable skill and its local references."""
import argparse
from pathlib import Path
import re

import yaml


def validate_skill(directory):
    directory = Path(directory).resolve()
    source = (directory / 'SKILL.md').read_text(encoding='utf-8')
    match = re.match(r'\A---\r?\n(.*?)\r?\n---\r?\n', source, re.S)
    if not match:
        raise ValueError('SKILL.md needs YAML frontmatter')
    metadata = yaml.safe_load(match.group(1))
    name = metadata.get('name') if isinstance(metadata, dict) else None
    if not isinstance(name, str) or name != directory.name or len(name) > 64 or not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', name):
        raise ValueError('Skill name must match its folder and use a lowercase slug')
    if not isinstance(metadata.get('description'), str) or not metadata['description'].strip():
        raise ValueError('Skill description is required')
    files = []
    for file in sorted(directory.rglob('*')):
        if file.is_symlink() or not file.resolve().is_relative_to(directory):
            raise ValueError('Skill files must stay within the package')
        if file.is_dir():
            continue
        relative = file.relative_to(directory)
        if not (relative.as_posix() in {'SKILL.md', 'agents/openai.yaml'}
                or relative.parts[0] == 'references' and file.suffix == '.md'):
            raise ValueError('Unexpected file in this skill package: ' + relative.as_posix())
        files.append(file)
        if file.suffix == '.md':
            text = file.read_text(encoding='utf-8')
            if '[TODO:' in text:
                raise ValueError('Unfinished skill scaffold')
            for target in re.findall(r'\]\(([^)]+)\)', text):
                if target.startswith(('https://', 'http://', '#')):
                    continue
                resolved = (file.parent / target.split('#', 1)[0]).resolve()
                if not resolved.is_relative_to(directory) or not resolved.is_file():
                    raise ValueError('Missing or external skill reference: ' + target)
    interface_file = directory / 'agents/openai.yaml'
    if interface_file.exists():
        ui = yaml.safe_load(interface_file.read_text(encoding='utf-8'))['interface']
        if not 25 <= len(ui['short_description']) <= 64:
            raise ValueError('UI short description must contain 25 to 64 characters')
        if '$' + name not in ui['default_prompt']:
            raise ValueError('Default prompt must invoke the skill by name')
    return files


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', nargs='?', type=Path,
                        default=Path(__file__).resolve().parents[1] / 'skills/extract-proxy-subscriptions')
    args = parser.parse_args()
    files = validate_skill(args.directory)
    print(f'Skill valid: {len(files)} package files, local references resolved')


if __name__ == '__main__':
    main()
