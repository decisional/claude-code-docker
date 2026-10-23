#!/usr/bin/env python3
"""Regression checks for cache publication, offline reuse, and launch concurrency."""
import importlib.util
import multiprocessing
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("cli_cache", Path(__file__).with_name("sync-cli-cache.py"))
cache = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cache)


def concurrent_writer(root):
    root = Path(root)
    with cache.cache_lock(root / "cli.lock"):
        if not (root / "ready").exists():
            with (root / "downloads").open("a") as log:
                log.write("download\n")
            time.sleep(0.15)
            (root / "ready").write_text("complete")


class CliCacheTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def prepare(self, version="1.2.3", platform="linux-arm64"):
        return cache.prepare_cache("claude", version, platform, "image", "container", self.root)

    @staticmethod
    def fake_download(image, stage, command, *args):
        (stage / "claude").write_text("complete Linux binary")

    def test_partial_download_is_not_published_and_retry_works(self):
        def fail(image, stage, command, *args):
            (stage / "claude").write_text("partial binary")
            raise subprocess.CalledProcessError(1, "download")
        with patch.object(cache, "seed_from_container", return_value=False), patch.object(cache, "helper", side_effect=fail):
            with self.assertRaises(subprocess.CalledProcessError):
                self.prepare()
        self.assertFalse(list(self.root.rglob(".ready.json")))
        self.assertFalse(list(self.root.rglob(".download-*")))
        with patch.object(cache, "seed_from_container", return_value=False), patch.object(cache, "helper", side_effect=self.fake_download):
            destination = self.prepare()
        self.assertTrue((destination / ".ready.json").exists())

    def test_cached_version_needs_no_download_or_helper(self):
        with patch.object(cache, "seed_from_container", return_value=False), patch.object(cache, "helper", side_effect=self.fake_download):
            destination = self.prepare()
        with patch.object(cache, "seed_from_container") as seed, patch.object(cache, "helper") as helper:
            self.assertEqual(self.prepare(), destination)
            seed.assert_not_called()
            helper.assert_not_called()

    def test_host_version_changes_and_platforms_have_separate_entries(self):
        with patch.object(cache, "seed_from_container", return_value=False), patch.object(cache, "helper", side_effect=self.fake_download):
            first = self.prepare()
            second = self.prepare("1.2.4")
            other_platform = self.prepare(platform="linux-amd64")
        self.assertEqual(len({first, second, other_platform}), 3)
        for entry in (first, second, other_platform):
            self.assertTrue((entry / ".ready.json").exists())

    def test_failed_upgrade_keeps_old_cached_release(self):
        with patch.object(cache, "seed_from_container", return_value=False), patch.object(cache, "helper", side_effect=self.fake_download):
            previous = self.prepare()
        with patch.object(cache, "seed_from_container", return_value=False), patch.object(cache, "helper", side_effect=OSError("offline")):
            with self.assertRaises(OSError):
                self.prepare("1.2.4")
        self.assertTrue((previous / ".ready.json").exists())
        self.assertFalse((previous.parent / "1.2.4").exists())

    def test_failed_validation_is_not_published(self):
        def validate_fails(image, stage, command, *args):
            if (stage / "claude").exists():
                raise subprocess.CalledProcessError(1, "wrong version")
            self.fake_download(image, stage, command, *args)
        with patch.object(cache, "seed_from_container", return_value=False), patch.object(cache, "helper", side_effect=validate_fails):
            with self.assertRaises(subprocess.CalledProcessError):
                self.prepare()
        self.assertFalse(list(self.root.rglob(".ready.json")))

    def test_missing_host_cli_keeps_installed_cli_without_download(self):
        with patch.object(cache, "host_command", side_effect=FileNotFoundError), patch.object(cache, "prepare_cache") as prepare:
            cache.sync("claude", "container", self.root)
            prepare.assert_not_called()

    def test_desktop_without_local_bin_in_path_finds_native_cli(self):
        binary = self.root / ".local/bin/claude"
        binary.parent.mkdir(parents=True)
        binary.write_text("#!/bin/sh\n")
        binary.chmod(0o755)
        with patch.object(cache.shutil, "which", return_value=None), patch.object(cache.Path, "home", return_value=self.root):
            self.assertEqual(cache.host_command("claude"), str(binary))

    def test_simultaneous_launches_publish_once(self):
        ctx = multiprocessing.get_context("fork")
        writers = [ctx.Process(target=concurrent_writer, args=(str(self.root),)) for _ in range(3)]
        for writer in writers:
            writer.start()
        for writer in writers:
            writer.join(timeout=5)
            self.assertEqual(writer.exitcode, 0)
        self.assertEqual((self.root / "downloads").read_text(), "download\n")


if __name__ == "__main__":
    unittest.main()
