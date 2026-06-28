<?php
/**
 * Reads and writes the `*.user.js` files in the watched scripts directory.
 *
 * Owns all filesystem access + the path-traversal guard. Parsing is delegated
 * to MetadataParser. Change-detection state (snapshots) lives in ScriptSync.
 */

declare(strict_types=1);

namespace SayScript;

final class ScriptRepository
{
    private string $dir;

    public function __construct(string $dir)
    {
        $this->dir = $dir;
    }

    public function dir(): string
    {
        return $this->dir;
    }

    public function path(string $filename): string
    {
        return $this->dir . DIRECTORY_SEPARATOR . $filename;
    }

    public function exists(string $filename): bool
    {
        return file_exists($this->path($filename));
    }

    /** @return string[] bare filenames ending in .user.js (sorted naturally) */
    public function listFiles(): array
    {
        $files = [];
        foreach (scandir($this->dir) ?: [] as $entry) {
            if ($entry === '.' || $entry === '..') {
                continue;
            }
            if (is_file($this->dir . DIRECTORY_SEPARATOR . $entry) && str_ends_with($entry, '.user.js')) {
                $files[] = $entry;
            }
        }
        sort($files, SORT_NATURAL | SORT_FLAG_CASE);
        return $files;
    }

    /** @return array<string, array{mtime:int,size:int}> */
    public function snapshotDir(): array
    {
        $out = [];
        foreach ($this->listFiles() as $filename) {
            $path = $this->dir . DIRECTORY_SEPARATOR . $filename;
            $out[$filename] = ['mtime' => (int)@filemtime($path), 'size' => (int)@filesize($path)];
        }
        return $out;
    }

    /** @return array<string, array> */
    public function readAllScripts(): array
    {
        $out = [];
        foreach ($this->listFiles() as $filename) {
            $s = $this->readScript($filename);
            if ($s !== null) {
                $out[$filename] = $s;
            }
        }
        return $out;
    }

    public function readScript(string $filename): ?array
    {
        $path = $this->path($filename);
        if (!is_file($path)) {
            return null;
        }
        $code = (string)@file_get_contents($path);
        $meta = MetadataParser::parse($code);

        return [
            'filename'    => $filename,
            'name'        => $meta['name'] ?? $filename,
            'namespace'   => $meta['namespace'],
            'version'     => $meta['version'],
            'description' => $meta['description'],
            'icon'        => $meta['icon'],
            'matches'     => $meta['matches'],
            'includes'    => $meta['includes'],
            'excludes'    => $meta['excludes'],
            'runAt'       => $meta['run_at'],
            'requires'    => $meta['requires'],
            'grants'      => $meta['grants'],
            'code'        => $code,
            'mtime'       => (int)@filemtime($path),
            'size'        => (int)@filesize($path),
        ];
    }

    /** Write file contents; returns bytes written or false. */
    public function write(string $filename, string $code): int|false
    {
        $bytes = @file_put_contents($this->path($filename), $code, LOCK_EX);
        if ($bytes !== false) {
            clearstatcache(true, $this->path($filename));
        }
        return $bytes;
    }

    public function delete(string $filename): void
    {
        $path = $this->path($filename);
        if (file_exists($path)) {
            @unlink($path);
        }
    }

    public function scaffold(string $filename): string
    {
        $name = preg_replace('/\.user\.js$/', '', $filename);
        return "// ==UserScript==\n"
            . "// @name        {$name}\n"
            . "// @namespace   sayscript\n"
            . "// @version     1.0.0\n"
            . "// @description new script\n"
            . "// @match       *://*/*\n"
            . "// @grant       none\n"
            . "// @run-at      document-idle\n"
            . "// ==/UserScript==\n\n"
            . "(function () {\n  'use strict';\n  console.log('Hello from {$name}');\n})();\n";
    }

    /** Reject anything that is not a bare *.user.js filename (path traversal guard). */
    public function safeFilename(string $name): ?string
    {
        $name = trim($name);
        if ($name === '' || $name !== basename($name)) {
            return null; // blocks path traversal / separators
        }
        if (!str_ends_with($name, '.user.js')) {
            return null;
        }
        // Allow Unicode names (e.g. "Pełna lista …"), spaces and dashes — as in
        // Tampermonkey backups — but reject path separators and control chars.
        if (preg_match('#[/\\\\\x00-\x1f]#u', $name)) {
            return null;
        }
        return $name;
    }
}
