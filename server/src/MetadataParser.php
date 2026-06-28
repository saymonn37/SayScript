<?php
/**
 * Parses a Tampermonkey-style ==UserScript== metadata block.
 *
 * Pure, stateless: give it the file contents, get back a normalized meta array.
 */

declare(strict_types=1);

namespace SayScript;

final class MetadataParser
{
    /**
     * @return array{
     *   name: ?string, namespace: ?string, version: ?string, description: ?string,
     *   icon: ?string, matches: string[], includes: string[], excludes: string[],
     *   run_at: string, requires: string[], grants: string[]
     * }
     */
    public static function parse(string $code): array
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
}
