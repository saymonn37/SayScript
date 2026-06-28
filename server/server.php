<?php
/**
 * SayScript — local development WebSocket server (bootstrap).
 *
 * Responsibilities:
 *   - Run a WebSocket server (default ws://localhost:8165) from the CLI.
 *   - Watch the `scripts/` folder for changes to *.user.js files using a
 *     non-blocking periodic poll on the ReactPHP event loop.
 *   - Serve/save script files and per-script version history.
 *
 * The actual work is split into focused classes under src/:
 *   - MetadataParser   — parses the ==UserScript== block.
 *   - ScriptRepository — reads/writes *.user.js (+ the path-traversal guard).
 *   - HistoryStore     — per-script version history under .history/.
 *   - ScriptSync       — the Ratchet WebSocket component tying it together.
 *
 * Usage:  php server.php [--port=8165] [--dir=../scripts] [--interval=1.0]
 *
 * Requires:  composer install   (cboden/ratchet)
 */

declare(strict_types=1);

require __DIR__ . '/vendor/autoload.php';
require __DIR__ . '/src/MetadataParser.php';
require __DIR__ . '/src/HistoryStore.php';
require __DIR__ . '/src/ScriptRepository.php';
require __DIR__ . '/src/ScriptSync.php';

use Ratchet\Server\IoServer;
use Ratchet\Http\HttpServer;
use Ratchet\WebSocket\WsServer;
use SayScript\ScriptRepository;
use SayScript\HistoryStore;
use SayScript\ScriptSync;

/* --------------------------------------------------------------------------
 * CLI argument parsing
 * ------------------------------------------------------------------------ */

$options = getopt('', ['port::', 'dir::', 'interval::', 'help']);

if (isset($options['help'])) {
    fwrite(STDOUT, "SayScript server\n");
    fwrite(STDOUT, "  --port=8165            WebSocket port\n");
    fwrite(STDOUT, "  --dir=../scripts       Folder containing .user.js files\n");
    fwrite(STDOUT, "  --interval=1.0         Filesystem poll interval in seconds\n");
    exit(0);
}

$port       = (int)($options['port'] ?? 8165);
$scriptsDir = $options['dir'] ?? (__DIR__ . '/../scripts');
$interval   = (float)($options['interval'] ?? 1.0);

/** Default max versions kept per script (overridable at runtime by the dashboard). */
const HISTORY_CAP_DEFAULT = 20;

$scriptsDir = rtrim($scriptsDir, '/\\');
if (!is_dir($scriptsDir)) {
    @mkdir($scriptsDir, 0777, true);
}
$scriptsDir = realpath($scriptsDir) ?: $scriptsDir;

/* --------------------------------------------------------------------------
 * Boot
 * ------------------------------------------------------------------------ */

$repo    = new ScriptRepository($scriptsDir);
$history = new HistoryStore($scriptsDir . DIRECTORY_SEPARATOR . '.history', HISTORY_CAP_DEFAULT);
$sync    = new ScriptSync($repo, $history);

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
