<?php
/**
 * SayScript — local development WebSocket server.
 *
 * Responsibilities:
 *   - Run a WebSocket server (default ws://localhost:3000) from the CLI.
 *   - Watch the `scripts/` folder for changes to *.user.js files using a
 *     non-blocking periodic poll on the ReactPHP event loop.
 *   - Parse Tampermonkey-style metadata blocks (@name, @match, @include, @icon, ...).
 *   - Expose actions over the socket:
 *        fetch_all_scripts  -> { type: "all_scripts", scripts: [...] }
 *        update_script      -> writes UI code to disk, acks the sender,
 *                              broadcasts script_changed to the other clients.
 *        create_script      -> creates a new .user.js file.
 *        delete_script      -> removes a file from disk.
 *   - Push automatic events when the filesystem changes:
 *        script_changed     { type, script }
 *        script_deleted     { type, filename }
 *
 * Usage:  php server.php [--port=3000] [--dir=../scripts] [--interval=1.0]
 *
 * Requires:  composer install   (cboden/ratchet)
 */

declare(strict_types=1);

require __DIR__ . '/vendor/autoload.php';

use Ratchet\MessageComponentInterface;
use Ratchet\ConnectionInterface;
use Ratchet\Server\IoServer;
use Ratchet\Http\HttpServer;
use Ratchet\WebSocket\WsServer;

/* --------------------------------------------------------------------------
 * CLI argument parsing
 * ------------------------------------------------------------------------ */

$options = getopt('', ['port::', 'dir::', 'interval::', 'help']);

if (isset($options['help'])) {
    fwrite(STDOUT, "SayScript server\n");
    fwrite(STDOUT, "  --port=3000            WebSocket port\n");
    fwrite(STDOUT, "  --dir=../scripts       Folder containing .user.js files\n");
    fwrite(STDOUT, "  --interval=1.0         Filesystem poll interval in seconds\n");
    exit(0);
}

$port       = (int)($options['port'] ?? 3000);
$scriptsDir = $options['dir'] ?? (__DIR__ . '/../scripts');
$interval   = (float)($options['interval'] ?? 1.0);

$scriptsDir = rtrim($scriptsDir, '/\\');
if (!is_dir($scriptsDir)) {
    @mkdir($scriptsDir, 0777, true);
}
$scriptsDir = realpath($scriptsDir) ?: $scriptsDir;

/* --------------------------------------------------------------------------
 * The sync component
 * ------------------------------------------------------------------------ */

final class ScriptSync implements MessageComponentInterface
{
    private \SplObjectStorage $clients;
    private string $dir;

    /** filename => ['mtime' => int, 'size' => int] used for change detection */
    private array $snapshots = [];

    public function __construct(string $dir)
    {
        $this->clients = new \SplObjectStorage();
        $this->dir     = $dir;
        $this->snapshots = $this->snapshotDir();
        $this->log("Watching: {$this->dir} (" . count($this->snapshots) . " script(s) found)");
    }

    /* ----- connection lifecycle ----- */

    public function onOpen(ConnectionInterface $conn): void
    {
        $this->clients->attach($conn);
        $this->log("Client connected (#{$conn->resourceId}). Total: " . $this->clients->count());
    }

    public function onClose(ConnectionInterface $conn): void
    {
        $this->clients->detach($conn);
        $this->log("Client disconnected (#{$conn->resourceId}). Total: " . $this->clients->count());
    }

    public function onError(ConnectionInterface $conn, \Exception $e): void
    {
        $this->log("Socket error (#{$conn->resourceId}): " . $e->getMessage());
        $conn->close();
    }

    public function onMessage(ConnectionInterface $from, $msg): void
    {
        $data = json_decode((string)$msg, true);
        if (!is_array($data) || !isset($data['action'])) {
            $this->send($from, ['type' => 'error', 'message' => 'Malformed message']);
            return;
        }

        switch ($data['action']) {
            case 'fetch_all_scripts':
                $this->send($from, [
                    'type'    => 'all_scripts',
                    'scripts' => array_values($this->readAllScripts()),
                ]);
                break;

            case 'update_script':
                $this->handleUpdate($from, $data);
                break;

            case 'create_script':
                $this->handleCreate($from, $data);
                break;

            case 'delete_script':
                $this->handleDelete($from, $data);
                break;

            case 'ping':
                $this->send($from, ['type' => 'pong']);
                break;

            default:
                $this->send($from, ['type' => 'error', 'message' => "Unknown action: {$data['action']}"]);
        }
    }

    /* ----- action handlers ----- */

    private function handleUpdate(ConnectionInterface $from, array $data): void
    {
        $filename = $this->safeFilename($data['filename'] ?? '');
        if ($filename === null) {
            $this->send($from, ['type' => 'error', 'message' => 'Invalid filename']);
            return;
        }
        if (!array_key_exists('code', $data) || !is_string($data['code'])) {
            $this->send($from, ['type' => 'error', 'message' => 'Missing code']);
            return;
        }

        $path = $this->dir . DIRECTORY_SEPARATOR . $filename;
        $bytes = @file_put_contents($path, $data['code'], LOCK_EX);
        if ($bytes === false) {
            $this->send($from, ['type' => 'error', 'message' => "Could not write {$filename}"]);
            return;
        }
        clearstatcache(true, $path);

        // Refresh our snapshot so the watcher does NOT re-broadcast this write
        // back as an external change (prevents an echo / reload loop).
        $this->snapshots[$filename] = ['mtime' => filemtime($path), 'size' => filesize($path)];

        $script = $this->readScript($filename);

        // Confirm to the saver, broadcast the fresh content to every OTHER client
        // (other dashboards + the background worker which re-injects on pages).
        $this->send($from, ['type' => 'update_ack', 'filename' => $filename, 'script' => $script]);
        $this->broadcast(['type' => 'script_changed', 'script' => $script], $from);
        $this->log("Saved from UI: {$filename} ({$bytes} bytes)");
    }

    private function handleCreate(ConnectionInterface $from, array $data): void
    {
        $filename = $this->safeFilename($data['filename'] ?? '');
        if ($filename === null) {
            $this->send($from, ['type' => 'error', 'message' => 'Invalid filename']);
            return;
        }
        $path = $this->dir . DIRECTORY_SEPARATOR . $filename;
        if (file_exists($path)) {
            $this->send($from, ['type' => 'error', 'message' => 'File already exists']);
            return;
        }
        $code = is_string($data['code'] ?? null) ? $data['code'] : $this->scaffold($filename);
        if (@file_put_contents($path, $code, LOCK_EX) === false) {
            $this->send($from, ['type' => 'error', 'message' => "Could not create {$filename}"]);
            return;
        }
        clearstatcache(true, $path);
        $this->snapshots[$filename] = ['mtime' => filemtime($path), 'size' => filesize($path)];
        $script = $this->readScript($filename);
        $this->send($from, ['type' => 'update_ack', 'filename' => $filename, 'script' => $script]);
        $this->broadcast(['type' => 'script_changed', 'script' => $script], $from);
        $this->log("Created: {$filename}");
    }

    private function handleDelete(ConnectionInterface $from, array $data): void
    {
        $filename = $this->safeFilename($data['filename'] ?? '');
        if ($filename === null) {
            $this->send($from, ['type' => 'error', 'message' => 'Invalid filename']);
            return;
        }
        $path = $this->dir . DIRECTORY_SEPARATOR . $filename;
        if (file_exists($path)) {
            @unlink($path);
        }
        unset($this->snapshots[$filename]);
        $this->send($from, ['type' => 'delete_ack', 'filename' => $filename]);
        $this->broadcast(['type' => 'script_deleted', 'filename' => $filename], $from);
        $this->log("Deleted: {$filename}");
    }

    /* ----- the non-blocking watcher (called by a periodic timer) ----- */

    public function checkChanges(): void
    {
        clearstatcache();
        $current = $this->snapshotDir();

        // Added or modified files
        foreach ($current as $filename => $stat) {
            $prev = $this->snapshots[$filename] ?? null;
            if ($prev === null || $prev['mtime'] !== $stat['mtime'] || $prev['size'] !== $stat['size']) {
                $script = $this->readScript($filename);
                if ($script !== null) {
                    $this->broadcast(['type' => 'script_changed', 'script' => $script]);
                    $this->log("Disk change detected: {$filename} -> pushed to " . $this->clients->count() . " client(s)");
                }
            }
        }

        // Removed files
        foreach ($this->snapshots as $filename => $_) {
            if (!isset($current[$filename])) {
                $this->broadcast(['type' => 'script_deleted', 'filename' => $filename]);
                $this->log("Disk delete detected: {$filename}");
            }
        }

        $this->snapshots = $current;
    }

    /* ----- filesystem helpers ----- */

    /** @return array<string, array{mtime:int,size:int}> */
    private function snapshotDir(): array
    {
        $out = [];
        foreach ($this->listFiles() as $filename) {
            $path = $this->dir . DIRECTORY_SEPARATOR . $filename;
            $out[$filename] = ['mtime' => (int)@filemtime($path), 'size' => (int)@filesize($path)];
        }
        return $out;
    }

    /** @return string[] bare filenames ending in .user.js */
    private function listFiles(): array
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

    /** @return array<string, array> */
    private function readAllScripts(): array
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

    private function readScript(string $filename): ?array
    {
        $path = $this->dir . DIRECTORY_SEPARATOR . $filename;
        if (!is_file($path)) {
            return null;
        }
        $code = (string)@file_get_contents($path);
        $meta = $this->parseMeta($code);

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

    /**
     * Parse a Tampermonkey ==UserScript== metadata block.
     */
    private function parseMeta(string $code): array
    {
        $meta = [
            'name' => null, 'namespace' => null, 'version' => null, 'description' => null,
            'icon' => null, 'matches' => [], 'includes' => [], 'excludes' => [],
            'run_at' => 'document-idle', 'requires' => [], 'grants' => [],
        ];

        if (!preg_match('#==UserScript==(.*?)==/UserScript==#s', $code, $m)) {
            return $meta;
        }

        foreach (preg_split('/\r\n|\r|\n/', $m[1]) as $line) {
            if (!preg_match('/^\s*\/\/\s*@([\w-]+)\s+(.*?)\s*$/', $line, $mm)) {
                continue;
            }
            $key = strtolower($mm[1]);
            $val = $mm[2];
            switch ($key) {
                case 'name':        $meta['name']        ??= $val; break;
                case 'namespace':   $meta['namespace']   ??= $val; break;
                case 'version':     $meta['version']     ??= $val; break;
                case 'description': $meta['description'] ??= $val; break;
                case 'icon':
                case 'iconurl':
                case 'defaulticon': $meta['icon'] ??= $val; break;
                case 'match':       $meta['matches'][]  = $val; break;
                case 'include':     $meta['includes'][] = $val; break;
                case 'exclude':     $meta['excludes'][] = $val; break;
                case 'run-at':      $meta['run_at']     = $val; break;
                case 'require':     $meta['requires'][] = $val; break;
                case 'grant':       $meta['grants'][]   = $val; break;
            }
        }
        return $meta;
    }

    private function scaffold(string $filename): string
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
    private function safeFilename(string $name): ?string
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

    /* ----- transport helpers ----- */

    private function send(ConnectionInterface $conn, array $payload): void
    {
        $conn->send(json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
    }

    private function broadcast(array $payload, ?ConnectionInterface $except = null): void
    {
        $json = json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        foreach ($this->clients as $client) {
            if ($except !== null && $client === $except) {
                continue;
            }
            $client->send($json);
        }
    }

    private function log(string $msg): void
    {
        fwrite(STDOUT, '[' . date('H:i:s') . "] {$msg}\n");
    }
}

/* --------------------------------------------------------------------------
 * Boot
 * ------------------------------------------------------------------------ */

$sync   = new ScriptSync($scriptsDir);
$server = IoServer::factory(
    new HttpServer(new WsServer($sync)),
    $port,
    '0.0.0.0'
);

// Non-blocking filesystem watcher: a periodic timer on the React event loop.
$server->loop->addPeriodicTimer($interval, static function () use ($sync) {
    $sync->checkChanges();
});

fwrite(STDOUT, "================================================\n");
fwrite(STDOUT, "  SayScript server running\n");
fwrite(STDOUT, "  WebSocket : ws://localhost:{$port}\n");
fwrite(STDOUT, "  Scripts   : {$scriptsDir}\n");
fwrite(STDOUT, "  Poll      : {$interval}s\n");
fwrite(STDOUT, "  Press Ctrl+C to stop.\n");
fwrite(STDOUT, "================================================\n");

$server->run();
