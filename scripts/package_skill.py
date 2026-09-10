"""Build a deterministic ZIP containing only the validated skill directory."""
import argparse
from pathlib import Path
import zipfile

try:
    from .check_skill import validate_skill
except ImportError:
    from check_skill import validate_skill


def package_skill(directory, output):
    directory, output = Path(directory).resolve(), Path(output).resolve()
    files = validate_skill(directory)
    if output.is_relative_to(directory):
        raise ValueError('Put build output outside the skill source directory')
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for file in files:
            name = directory.name + '/' + file.relative_to(directory).as_posix()
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            archive.writestr(info, file.read_bytes())
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--skill', type=Path, default=Path(__file__).resolve().parents[1] / 'skills/extract-proxy-subscriptions')
    parser.add_argument('--out-dir', type=Path, default=Path('dist'))
    args = parser.parse_args()
    result = package_skill(args.skill, args.out_dir / (args.skill.name + '.zip'))
    print(result)


if __name__ == '__main__':
    main()
