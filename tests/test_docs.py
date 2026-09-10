from pathlib import Path
import tempfile
import unittest

from scripts.check_docs import check_links


class DocumentationLinksTests(unittest.TestCase):
    def test_relative_links_resolve_from_the_document_not_the_process_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "docs").mkdir()
            (root / "README.md").write_text("Root documentation")
            document = root / "docs/guide.md"
            document.write_text("[root](../README.md) [web](https://example.com/docs) [section](#topic)")
            self.assertEqual(check_links(document, root), [])

    def test_moved_or_outside_links_are_reported_but_code_examples_are_ignored(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            document = root / "README.md"
            document.write_text("[old](old/path.md)\n[outside](../outside.md)\n```md\n[example](not-real.md)\n```\n")
            failures = check_links(document, root)
            self.assertEqual([item["line"] for item in failures], [1, 2])


if __name__ == "__main__":
    unittest.main()
