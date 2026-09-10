from pathlib import Path
import tempfile
import unittest
import zipfile

from scripts.check_skill import validate_skill
from scripts.package_skill import package_skill


class SkillPackagingTests(unittest.TestCase):
    def make_skill(self, directory):
        skill = Path(directory) / 'example-skill'
        (skill / 'references').mkdir(parents=True)
        (skill / 'SKILL.md').write_text('---\nname: example-skill\ndescription: Explain a synthetic client.\n---\n'
                                       '# Example\nRead [notes](references/notes.md).\n', encoding='utf-8')
        (skill / 'references/notes.md').write_text('Synthetic protocol notes.\n', encoding='utf-8')
        return skill

    def test_archive_has_installable_folder_and_exact_source_contents(self):
        with tempfile.TemporaryDirectory() as directory:
            skill = self.make_skill(directory)
            first = package_skill(skill, Path(directory) / 'first.zip')
            second = package_skill(skill, Path(directory) / 'second.zip')
            self.assertEqual(first.read_bytes(), second.read_bytes())
            with zipfile.ZipFile(first) as archive:
                self.assertEqual(set(archive.namelist()), {'example-skill/SKILL.md', 'example-skill/references/notes.md'})
                self.assertEqual(archive.read('example-skill/SKILL.md'), (skill / 'SKILL.md').read_bytes())

    def test_unlisted_files_cannot_enter_the_skill_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            skill = self.make_skill(directory)
            (skill / 'credentials.json').write_text('{}')
            output = Path(directory) / 'bundle.zip'
            with self.assertRaises(ValueError):
                package_skill(skill, output)
            self.assertFalse(output.exists())

    def test_reference_cannot_escape_the_skill_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            skill = self.make_skill(directory)
            (Path(directory) / 'private.txt').write_text('synthetic')
            notes = skill / 'references/notes.md'
            notes.write_text('[outside](../../private.txt)')
            with self.assertRaises(ValueError):
                validate_skill(skill)

    def test_build_cannot_write_into_skill_source(self):
        with tempfile.TemporaryDirectory() as directory:
            skill = self.make_skill(directory)
            with self.assertRaises(ValueError):
                package_skill(skill, skill / 'bundle.zip')


if __name__ == '__main__':
    unittest.main()
