<?php
/**
 * The WebSocket sync component (Ratchet).
 *
 * Orchestrates ScriptRepository (file IO) and HistoryStore (versioning), owns
 * the connected-client set + the change-detection snapshots, and translates
 * socket actions into repository/history operations and broadcasts.
 */

declare(strict_types=1);

namespace SayScript;

use Ratchet\MessageComponentInterface;
use Ratchet\ConnectionInterface;

final class ScriptSync implements MessageComponentInterface
{
    private \SplObjectStorage $clients;
    private ScriptRepository $repo;
    private HistoryStore $history;

    /** filename => ['mtime' => int, 'size' => int] used for change detection */
    private array $snapshots = [];

    public function __construct(ScriptRepository $repo, HistoryStore $history)
    {
        $this->clients = new \SplObjectStorage();
        $this->repo    = $repo;
        $this->history = $history;
        $this->snapshots = $this->repo->snapshotDir();
        $this->log("Watching: {$this->repo->dir()} (" . count($this->snapshots) . " script(s) found)");
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
                    'scripts' => array_values($this->repo->readAllScripts()),
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

            case 'fetch_history':
                $this->handleFetchHistory($from, $data);
                break;

            case 'fetch_history_entry':
                $this->handleFetchHistoryEntry($from, $data);
                break;

            case 'clear_history':
                $this->handleClearHistory($from, $data);
                break;

            case 'clear_all_history':
                $this->handleClearAllHistory($from);
                break;

            case 'set_history_cap':
                $this->handleSetHistoryCap($data);
                break;

            case 'ping':
                $this->send($from, ['type' => 'pong']);
                break;

            default:
                $this->send($from, ['type' => 'error', 'message' => "Unknown action: {$data['action']}"]);
        }
    }

    /* ----- script action handlers ----- */

    private function handleUpdate(ConnectionInterface $from, array $data): void
    {
        $filename = $this->repo->safeFilename($data['filename'] ?? '');
        if ($filename === null) {
            $this->send($from, ['type' => 'error', 'message' => 'Invalid filename']);
            return;
        }
        if (!array_key_exists('code', $data) || !is_string($data['code'])) {
            $this->send($from, ['type' => 'error', 'message' => 'Missing code']);
            return;
        }

        $bytes = $this->repo->write($filename, $data['code']);
        if ($bytes === false) {
            $this->send($from, ['type' => 'error', 'message' => "Could not write {$filename}"]);
            return;
        }

        // Refresh our snapshot so the watcher does NOT re-broadcast this write
        // back as an external change (prevents an echo / reload loop).
        $path = $this->repo->path($filename);
        $this->snapshots[$filename] = ['mtime' => filemtime($path), 'size' => filesize($path)];

        // Snapshot this version into history (skips no-op saves automatically).
        $this->history->save($filename, $data['code']);

        $script = $this->repo->readScript($filename);

        // Confirm to the saver, broadcast the fresh content to every OTHER client
        // (other dashboards + the background worker which re-injects on pages).
        $this->send($from, ['type' => 'update_ack', 'filename' => $filename, 'script' => $script]);
        $this->broadcast(['type' => 'script_changed', 'script' => $script], $from);
        $this->log("Saved from UI: {$filename} ({$bytes} bytes)");
    }

    private function handleCreate(ConnectionInterface $from, array $data): void
    {
        $filename = $this->repo->safeFilename($data['filename'] ?? '');
        if ($filename === null) {
            $this->send($from, ['type' => 'error', 'message' => 'Invalid filename']);
            return;
        }
        if ($this->repo->exists($filename)) {
            $this->send($from, ['type' => 'error', 'message' => 'File already exists']);
            return;
        }
        $code = is_string($data['code'] ?? null) ? $data['code'] : $this->repo->scaffold($filename);
        if ($this->repo->write($filename, $code) === false) {
            $this->send($from, ['type' => 'error', 'message' => "Could not create {$filename}"]);
            return;
        }
        $path = $this->repo->path($filename);
        $this->snapshots[$filename] = ['mtime' => filemtime($path), 'size' => filesize($path)];
        $this->history->save($filename, $code);
        $script = $this->repo->readScript($filename);
        $this->send($from, ['type' => 'update_ack', 'filename' => $filename, 'script' => $script]);
        $this->broadcast(['type' => 'script_changed', 'script' => $script], $from);
        $this->log("Created: {$filename}");
    }

    private function handleDelete(ConnectionInterface $from, array $data): void
    {
        $filename = $this->repo->safeFilename($data['filename'] ?? '');
        if ($filename === null) {
            $this->send($from, ['type' => 'error', 'message' => 'Invalid filename']);
            return;
        }
        $this->repo->delete($filename);
        unset($this->snapshots[$filename]);
        $this->send($from, ['type' => 'delete_ack', 'filename' => $filename]);
        $this->broadcast(['type' => 'script_deleted', 'filename' => $filename], $from);
        $this->log("Deleted: {$filename}");
    }

    /* ----- history action handlers ----- */

    private function handleFetchHistory(ConnectionInterface $from, array $data): void
    {
        $filename = $this->repo->safeFilename($data['filename'] ?? '');
        if ($filename === null) {
            $this->send($from, ['type' => 'error', 'message' => 'Invalid filename']);
            return;
        }
        $this->send($from, [
            'type'     => 'history_list',
            'filename' => $filename,
            'entries'  => $this->history->listEntries($filename),
        ]);
    }

    private function handleFetchHistoryEntry(ConnectionInterface $from, array $data): void
    {
        $filename = $this->repo->safeFilename($data['filename'] ?? '');
        $id       = HistoryStore::safeId($data['id'] ?? '');
        if ($filename === null || $id === null) {
            $this->send($from, ['type' => 'error', 'message' => 'Invalid history reference']);
            return;
        }
        $code = $this->history->readEntry($filename, $id);
        if ($code === null) {
            $this->send($from, ['type' => 'error', 'message' => 'History version not found']);
            return;
        }
        $this->send($from, [
            'type'     => 'history_entry',
            'filename' => $filename,
            'id'       => $id,
            'code'     => $code,
        ]);
    }

    private function handleClearHistory(ConnectionInterface $from, array $data): void
    {
        $filename = $this->repo->safeFilename($data['filename'] ?? '');
        if ($filename === null) {
            $this->send($from, ['type' => 'error', 'message' => 'Invalid filename']);
            return;
        }
        $this->history->clear($filename);
        $this->send($from, ['type' => 'history_cleared', 'filename' => $filename]);
        $this->log("History cleared: {$filename}");
    }

    private function handleClearAllHistory(ConnectionInterface $from): void
    {
        $this->history->clearAll();
        $this->send($from, ['type' => 'all_history_cleared']);
        $this->log("History cleared: ALL scripts");
    }

    /** The dashboard owns the history limit (a user setting); apply it live. */
    private function handleSetHistoryCap(array $data): void
    {
        $cap = (int)($data['cap'] ?? 0);
        if ($cap < 1 || $cap === $this->history->getCap()) {
            return;
        }
        $this->history->setCap($cap);
        $this->log("History cap set to {$this->history->getCap()}");
    }

    /* ----- the non-blocking watcher (called by a periodic timer) ----- */

    public function checkChanges(): void
    {
        clearstatcache();
        $current = $this->repo->snapshotDir();

        // Added or modified files
        foreach ($current as $filename => $stat) {
            $prev = $this->snapshots[$filename] ?? null;
            if ($prev === null || $prev['mtime'] !== $stat['mtime'] || $prev['size'] !== $stat['size']) {
                $script = $this->repo->readScript($filename);
                if ($script !== null) {
                    // Capture externally-made edits in history too.
                    $this->history->save($filename, (string)$script['code']);
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
