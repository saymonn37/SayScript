<?php
/**
 * Per-script version history, stored on disk under `<scripts>/.history/<file>/`.
 *
 *   - Each saved version is a `<unix_millis>.js` file (numeric id = timestamp).
 *   - No-op saves (identical to the newest version) are skipped.
 *   - Each script keeps at most `cap` versions; the oldest are pruned.
 *
 * The cap is a user setting owned by the dashboard and pushed at runtime.
 */

declare(strict_types=1);

namespace SayScript;

final class HistoryStore
{
    private string $dir;
    private int $cap;

    public function __construct(string $historyDir, int $cap)
    {
        $this->dir = $historyDir;
        $this->cap = max(1, $cap);
    }

    public function setCap(int $cap): void
    {
        $this->cap = max(1, min(1000, $cap));
        $this->pruneAll();
    }

    public function getCap(): int
    {
        return $this->cap;
    }

    /** Save one version, skipping no-op saves and pruning old ones. */
    public function save(string $filename, string $code): void
    {
        $dir = $this->dirFor($filename);
        if (!is_dir($dir) && !@mkdir($dir, 0777, true) && !is_dir($dir)) {
            return; // can't create history dir — silently skip (never break a save)
        }

        // Skip if identical to the most recent version.
        $existing = $this->files($dir);
        if ($existing) {
            $newest = end($existing);
            if (@file_get_contents($dir . DIRECTORY_SEPARATOR . $newest) === $code) {
                return;
            }
        }

        // Millisecond-stamped, numeric filename; bump on the rare collision.
        $ts = (int)round(microtime(true) * 1000);
        do {
            $path = $dir . DIRECTORY_SEPARATOR . $ts . '.js';
            $ts++;
        } while (file_exists($path));
        @file_put_contents($path, $code, LOCK_EX);

        $this->prune($dir);
    }

    /** @return array<int, array{id:string,ts:int,size:int}> newest first. */
    public function listEntries(string $filename): array
    {
        $dir = $this->dirFor($filename);
        $out = [];
        foreach ($this->files($dir) as $f) {
            $id = substr($f, 0, -3); // strip ".js"
            $out[] = [
                'id'   => $id,
                'ts'   => (int)$id,
                'size' => (int)@filesize($dir . DIRECTORY_SEPARATOR . $f),
            ];
        }
        return array_reverse($out); // newest first
    }

    public function readEntry(string $filename, string $id): ?string
    {
        if (self::safeId($id) === null) {
            return null;
        }
        $path = $this->dirFor($filename) . DIRECTORY_SEPARATOR . $id . '.js';
        return is_file($path) ? (string)@file_get_contents($path) : null;
    }

    public function clear(string $filename): void
    {
        self::rrmdir($this->dirFor($filename));
    }

    public function clearAll(): void
    {
        self::rrmdir($this->dir);
    }

    /** Accept only a bare numeric history id (path-traversal guard). */
    public static function safeId($id): ?string
    {
        $id = trim((string)$id);
        return preg_match('/^\d+$/', $id) ? $id : null;
    }

    /* ----- internals ----- */

    private function dirFor(string $filename): string
    {
        return $this->dir . DIRECTORY_SEPARATOR . $filename;
    }

    /** @return string[] history filenames ("<ts>.js"), oldest first. */
    private function files(string $dir): array
    {
        if (!is_dir($dir)) {
            return [];
        }
        $files = [];
        foreach (scandir($dir) ?: [] as $entry) {
            if (preg_match('/^\d+\.js$/', $entry)) {
                $files[] = $entry;
            }
        }
        sort($files, SORT_NATURAL); // numeric stamps → chronological
        return $files;
    }

    private function prune(string $dir): void
    {
        $files = $this->files($dir);
        $excess = count($files) - $this->cap;
        for ($i = 0; $i < $excess; $i++) {
            @unlink($dir . DIRECTORY_SEPARATOR . $files[$i]);
        }
    }

    private function pruneAll(): void
    {
        if (!is_dir($this->dir)) {
            return;
        }
        foreach (scandir($this->dir) ?: [] as $entry) {
            if ($entry === '.' || $entry === '..') {
                continue;
            }
            $sub = $this->dir . DIRECTORY_SEPARATOR . $entry;
            if (is_dir($sub)) {
                $this->prune($sub);
            }
        }
    }

    /** Recursively delete a directory and its contents (best-effort). */
    private static function rrmdir(string $dir): void
    {
        if (!is_dir($dir)) {
            return;
        }
        foreach (scandir($dir) ?: [] as $entry) {
            if ($entry === '.' || $entry === '..') {
                continue;
            }
            $path = $dir . DIRECTORY_SEPARATOR . $entry;
            if (is_dir($path)) {
                self::rrmdir($path);
            } else {
                @unlink($path);
            }
        }
        @rmdir($dir);
    }
}
