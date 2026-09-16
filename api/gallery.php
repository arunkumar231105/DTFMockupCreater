<?php
// ═══════════════════════════════════════════════════════════════════════════════
// GALLERY — Design Studio ka apna page: customer ki files dekho aur mark karo.
//
// Upload ya edit yahan se nahi hota. Sirf mark:
//   SRC · REF · WRK · FNL · FNLA · DOCS   → file customer ke sahi folder me MOVE hoti hai
//                                           aur standard naam leti hai (AW-<CLIENT>-<NNNN>-<TYPE>)
//   RECEIVED                              → receive_customer_orders/<customer>/  (index se bahar)
//   TRASH                                 → Trash/<customer>/<YYYY-MM>/          (index se bahar)
//   DUPLICATE                             → file nahi hilti, sirf group banta hai
//   derive (REF se SRC)                   → REF waisa hi rehta hai; nayi SRC file NAYE number
//                                           ke saath banti hai, aur link likha jata hai
//
// Numbering wahi hai jo PrintShop ki vault chalati hai: design ka number sirf tab milta
// hai jab file ke paas na ho (client code ka sab se bara number + 1), aur WRK/FNL/FNLA
// ka version kabhi dobara use nahi hota. Ek client ki numbering ek waqt me ek hi
// request karti hai (advisory lock), taake do log ek hi number na le lein.
//
// Har kaam — kaamyab ya nakaam — gallery.marks me likha jata hai: file, purana aur
// naya mark, purana aur naya path, kis ne, kab.
// ═══════════════════════════════════════════════════════════════════════════════

require_once __DIR__ . '/auth-helpers.php';

header('Content-Type: application/json');
header('Cache-Control: private, no-store');

$user = requireAuth();
if (($user['role'] ?? '') !== 'superadmin' && !in_array('gallery', $user['page_access'] ?? [], true)) {
    http_response_code(403);
    echo json_encode(['success' => false, 'error' => 'You do not have access to the Gallery']);
    exit;
}
$actor = trim(($user['full_name'] ?? '') ?: ($user['username'] ?? '') ?: ($user['email'] ?? 'user'));
$action = $_GET['action'] ?? '';
$db = getDB();

// ── Small helpers ──────────────────────────────────────────────────────────────
function respond($data, $status = 200) {
    http_response_code($status);
    echo json_encode(['success' => $status < 400, 'data' => $data]);
    exit;
}
function fail($status, $message) {
    http_response_code($status);
    echo json_encode(['success' => false, 'error' => $message]);
    exit;
}
function jsonBody() {
    $b = json_decode(file_get_contents('php://input'), true);
    return is_array($b) ? $b : [];
}
function isUuid($v) {
    return is_string($v) && preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i', $v);
}
function uuidArray(array $ids) {
    $ids = array_values(array_unique(array_filter($ids, 'isUuid')));
    return '{' . implode(',', $ids) . '}';
}

// ── Nextcloud (WebDAV) ─────────────────────────────────────────────────────────
function ncConfig() {
    static $cfg = null;
    if ($cfg) return $cfg;
    $url = rtrim(trim(getenv('NEXTCLOUD_URL') ?: ''), '/');
    $u = trim(getenv('NEXTCLOUD_USER') ?: '');
    $p = trim(getenv('NEXTCLOUD_APP_PASSWORD') ?: '');
    if (!$url || !$u || !$p) fail(503, 'Nextcloud is not configured for Design Studio');
    return $cfg = ['root' => $url . '/remote.php/dav/files/' . rawurlencode($u), 'user' => $u, 'pass' => $p];
}
function ncUrl($rel) {
    $parts = array_filter(explode('/', trim($rel, '/')), 'strlen');
    return ncConfig()['root'] . '/' . implode('/', array_map('rawurlencode', $parts));
}
function ncRequest($method, $rel, array $headers = [], $body = null, $timeout = 60) {
    $cfg = ncConfig();
    $ch = curl_init(ncUrl($rel));
    curl_setopt_array($ch, [
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_USERPWD => $cfg['user'] . ':' . $cfg['pass'],
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_TIMEOUT => $timeout,
    ]);
    if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
    $resp = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $err = curl_error($ch);
    curl_close($ch);
    if ($resp === false) throw new RuntimeException('Nextcloud is not reachable: ' . $err);
    return [$status, $resp];
}
function ncEnsureFolder($rel) {
    $cur = '';
    foreach (array_filter(explode('/', trim($rel, '/')), 'strlen') as $part) {
        $cur = $cur === '' ? $part : "$cur/$part";
        [$s] = ncRequest('MKCOL', $cur, [], null, 30);
        if (!in_array($s, [201, 405], true)) throw new RuntimeException("Could not create folder $cur ($s)");
    }
}
// 'moved' | 'taken' (target exists) | 'gone' (source missing)
function ncMove($from, $to) {
    [$s] = ncRequest('MOVE', $from, ['Destination: ' . ncUrl($to), 'Overwrite: F']);
    if (in_array($s, [201, 204], true)) return 'moved';
    if ($s === 412) return 'taken';
    if ($s === 404) return 'gone';
    throw new RuntimeException("Nextcloud refused the move ($s)");
}
function ncGet($rel) {
    [$s, $b] = ncRequest('GET', $rel, [], null, 180);
    return $s === 200 ? $b : null;
}
// 'ok' | 'taken'
function ncPutIfAbsent($rel, $bytes, $mime) {
    [$s] = ncRequest('PUT', $rel, ['Content-Type: ' . $mime, 'If-None-Match: *'], $bytes, 180);
    if (in_array($s, [200, 201, 204], true)) return 'ok';
    if ($s === 412) return 'taken';
    throw new RuntimeException("Upload failed ($s)");
}

// ── Folder and naming rules (same as the vault) ────────────────────────────────
const STAGE_FOLDER_RE = '/^(references?|reference_files|refs?|artworks?|working|versions?|mock-?ups?|sent|outgoing|gang-?sheets?|finals?|final_files|production|combos?|documents?|thumb(nail)?s?|ai[ _-]?artwork)$/i';

// mark => where it goes, the suffix in the name, whether it carries a version number
const STAGES = [
    'SRC'  => ['match' => '^(references?|reference_files)$', 'folder' => 'references',  'suffix' => 'SRC',  'versioned' => false, 'type' => 'reference', 'status' => 'Source Received'],
    'REF'  => ['match' => '^(references?|reference_files)$', 'folder' => 'references',  'suffix' => 'REF',  'versioned' => false, 'type' => 'reference', 'status' => 'Reference Received'],
    'WRK'  => ['match' => '^artworks?$',                     'folder' => 'Artworks',    'suffix' => 'WRK',  'versioned' => true,  'type' => 'artwork',   'status' => 'In Design'],
    'FNL'  => ['match' => '^(final_files|finals?)$',         'folder' => 'final_files', 'suffix' => 'FNL',  'versioned' => true,  'type' => 'artwork',   'status' => 'Pending Approval'],
    'FNLA' => ['match' => '^(final_files|finals?)$',         'folder' => 'final_files', 'suffix' => 'FNLA', 'versioned' => true,  'type' => 'artwork',   'status' => 'Approved'],
    'DOCS' => ['match' => '^documents?$',                    'folder' => 'Documents',   'suffix' => 'DOC',  'versioned' => false, 'type' => null,        'status' => 'Document'],
];
const TRASH_ROOT = 'Trash';
const RECEIVED_ROOT = 'receive_customer_orders';

// "Leads 2.0/<customer>/references/x.jpg" -> "Leads 2.0/<customer>"
function customerFolder($path) {
    $parts = array_values(array_filter(explode('/', $path), 'strlen'));
    foreach ($parts as $i => $p) {
        if ($i > 0 && preg_match(STAGE_FOLDER_RE, $p)) return implode('/', array_slice($parts, 0, $i));
    }
    return implode('/', array_slice($parts, 0, -1));
}
function customerSegment($path) {
    $parts = array_values(array_filter(explode('/', $path), 'strlen'));
    $seg = $parts[1] ?? ($parts[0] ?? 'Unsorted');
    $seg = trim(preg_replace('/[\\\\\/\x00]/', '_', $seg));
    return $seg !== '' ? $seg : 'Unsorted';
}
function extOf($fileName) {
    $ext = strtolower(pathinfo($fileName, PATHINFO_EXTENSION));
    return preg_match('/^[a-z0-9]{1,8}$/', $ext) ? $ext : 'png';
}
function mimeOf($ext) {
    return ['jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg', 'png' => 'image/png', 'webp' => 'image/webp',
            'gif' => 'image/gif', 'pdf' => 'application/pdf', 'ai' => 'application/postscript',
            'svg' => 'image/svg+xml', 'psd' => 'image/vnd.adobe.photoshop'][$ext] ?? 'application/octet-stream';
}

// The customer's existing folder for this stage (a customer may say "reference_files").
function stageFolder(PDO $db, $base, array $stage) {
    $st = $db->prepare("SELECT split_part(substr(parent_path, length(:b1) + 2), '/', 1) AS folder, count(*) AS n
        FROM public.artwork_vault_assets
        WHERE source = 'nextcloud' AND strpos(parent_path, :b2 || '/') = 1
          AND split_part(substr(parent_path, length(:b3) + 2), '/', 1) ~* :re
        GROUP BY 1 ORDER BY 2 DESC LIMIT 1");
    $st->execute([':b1' => $base, ':b2' => $base, ':b3' => $base, ':re' => $stage['match']]);
    $row = $st->fetch();
    return $base . '/' . ($row['folder'] ?? $stage['folder']);
}

// Client code: from the file's own code, else the code this customer's files already
// use, else a new one derived from the folder name and checked for collisions.
function clientCode(PDO $db, array $a, $base) {
    if (!empty($a['artwork_code'])) {
        $seg = explode('-', $a['artwork_code'])[1] ?? '';
        if ($seg !== '') return strtoupper($seg);
    }
    $st = $db->prepare("SELECT split_part(artwork_code, '-', 2) AS code, count(*) AS n
        FROM public.artwork_vault_assets
        WHERE source = 'nextcloud' AND artwork_code IS NOT NULL
          AND (strpos(path, :base || '/') = 1
               OR (CAST(:cid AS uuid) IS NOT NULL AND customer_id = CAST(:cid2 AS uuid))
               OR (CAST(:lid AS uuid) IS NOT NULL AND lead_id = CAST(:lid2 AS uuid)))
        GROUP BY 1 ORDER BY 2 DESC LIMIT 1");
    $st->execute([':base' => $base, ':cid' => $a['customer_id'], ':cid2' => $a['customer_id'],
                  ':lid' => $a['lead_id'], ':lid2' => $a['lead_id']]);
    $row = $st->fetch();
    if (!empty($row['code'])) return strtoupper($row['code']);

    $name = preg_replace('/^[0-9]+_/', '', basename($base));
    $letters = substr(preg_replace('/[^A-Z]/', '', strtoupper($name)), 0, 3);
    $letters = str_pad($letters ?: 'GEN', 3, 'X');
    $st = $db->prepare("SELECT DISTINCT split_part(artwork_code, '-', 2) AS code FROM public.artwork_vault_assets WHERE artwork_code LIKE :pfx");
    $st->execute([':pfx' => "AW-$letters%"]);
    $used = array_map('strtoupper', array_column($st->fetchAll(), 'code'));
    for ($n = 1; $n < 100; $n++) {
        $candidate = $letters . str_pad((string)$n, 2, '0', STR_PAD_LEFT);
        if (!in_array($candidate, $used, true)) return $candidate;
    }
    throw new RuntimeException("No free client code remains for $letters");
}

// Next design number for a client — the highest across every stage, plus one.
function nextPieceNumber(PDO $db, $client) {
    $st = $db->prepare("SELECT COALESCE(MAX(NULLIF(split_part(artwork_code, '-', 3), '')::int), 0) AS hi
        FROM public.artwork_vault_assets
        WHERE artwork_code LIKE :pfx AND split_part(artwork_code, '-', 3) ~ '^[0-9]{4}$'");
    $st->execute([':pfx' => "AW-$client-%"]);
    return str_pad((string)((int)$st->fetch()['hi'] + 1), 4, '0', STR_PAD_LEFT);
}

// Next version for this design at this stage. Never reused.
function nextVersion(PDO $db, $code, $suffix) {
    $prefix = preg_quote($code, '/') . '\\-' . preg_quote($suffix, '/');
    $st = $db->prepare("SELECT COALESCE(MAX(COALESCE(NULLIF(substring(file_name FROM :re1), '')::int, 1)), 0) AS hi
        FROM public.artwork_vault_assets WHERE source = 'nextcloud' AND file_name ~ :re2");
    $st->execute([':re1' => "^{$prefix}([0-9]+)", ':re2' => "^{$prefix}[0-9]*\\."]);
    return (int)$st->fetch()['hi'] + 1;
}

function lockClient(PDO $db, $client) {
    $db->prepare("SELECT pg_advisory_xact_lock(hashtext(:k))")->execute([':k' => "gallery-code-$client"]);
}

function loadAsset(PDO $db, $id, $forUpdate = false) {
    $st = $db->prepare("SELECT a.*,
            COALESCE(c.name, l.customer_name, split_part(a.path, '/', 2)) AS entity_name,
            CASE WHEN a.customer_id IS NOT NULL THEN 'c:' || a.customer_id
                 WHEN a.lead_id IS NOT NULL THEN 'l:' || a.lead_id
                 ELSE 'p:' || split_part(a.path, '/', 1) || '/' || split_part(a.path, '/', 2) END AS entity_key
        FROM public.artwork_vault_assets a
        LEFT JOIN public.customers c ON c.id = a.customer_id
        LEFT JOIN public.leads l ON l.id = a.lead_id
        WHERE a.id = CAST(:id AS uuid)" . ($forUpdate ? ' FOR UPDATE OF a' : ''));
    $st->execute([':id' => $id]);
    return $st->fetch() ?: null;
}

function recordMark(PDO $db, array $a, array $f) {
    $st = $db->prepare("INSERT INTO gallery.marks
        (asset_id, new_asset_id, customer_key, customer_name, artwork_code, from_mark, to_mark,
         from_path, to_path, from_file_name, to_file_name, note, marked_by, status, error)
        VALUES (CAST(:asset_id AS uuid), CAST(:new_asset_id AS uuid), :customer_key, :customer_name, :artwork_code,
                :from_mark, :to_mark, :from_path, :to_path, :from_file_name, :to_file_name, :note, :marked_by, :status, :error)");
    $st->execute([
        ':asset_id' => $a['id'], ':new_asset_id' => $f['new_asset_id'] ?? null,
        ':customer_key' => $a['entity_key'] ?? null, ':customer_name' => $a['entity_name'] ?? null,
        ':artwork_code' => $f['artwork_code'] ?? ($a['artwork_code'] ?? null),
        ':from_mark' => $a['lifecycle_code'] ?? null, ':to_mark' => $f['to_mark'],
        ':from_path' => $a['path'] ?? null, ':to_path' => $f['to_path'] ?? null,
        ':from_file_name' => $a['file_name'] ?? null, ':to_file_name' => $f['to_file_name'] ?? null,
        ':note' => $f['note'] ?? null, ':marked_by' => $f['marked_by'],
        ':status' => $f['status'] ?? 'done', ':error' => $f['error'] ?? null,
    ]);
}

// Point the index row at the file's new home. The vault's own watcher may already have
// indexed the new path in the moment after the move; then that row is kept and ours goes.
function repointRow(PDO $db, array $a, array $fields) {
    $db->exec('SAVEPOINT gallery_repoint');
    try {
        $st = $db->prepare("UPDATE public.artwork_vault_assets
            SET path = :path, source_key = :key, parent_path = :parent, file_name = :name,
                artwork_code = :code, lifecycle_code = :life, asset_type = :type, status = :status,
                naming_convention_valid = TRUE, source_modified_at = NOW(), updated_at = NOW()
            WHERE id = CAST(:id AS uuid)");
        $st->execute([':path' => $fields['path'], ':key' => $fields['path'], ':parent' => $fields['parent'],
                      ':name' => $fields['name'], ':code' => $fields['code'], ':life' => $fields['life'],
                      ':type' => $fields['type'], ':status' => $fields['status'], ':id' => $a['id']]);
        $db->exec('RELEASE SAVEPOINT gallery_repoint');
        return $a['id'];
    } catch (PDOException $e) {
        if ($e->getCode() !== '23505') throw $e;
        $db->exec('ROLLBACK TO SAVEPOINT gallery_repoint');
        $st = $db->prepare("SELECT id FROM public.artwork_vault_assets WHERE source = 'nextcloud' AND source_key = :key");
        $st->execute([':key' => $fields['path']]);
        $other = $st->fetchColumn();
        $db->prepare("DELETE FROM public.artwork_vault_assets WHERE id = CAST(:id AS uuid)")->execute([':id' => $a['id']]);
        $db->prepare("UPDATE public.artwork_vault_assets
            SET artwork_code = :code, lifecycle_code = :life, asset_type = :type, status = :status,
                naming_convention_valid = TRUE, updated_at = NOW() WHERE id = CAST(:id AS uuid)")
           ->execute([':code' => $fields['code'], ':life' => $fields['life'], ':type' => $fields['type'],
                      ':status' => $fields['status'], ':id' => $other]);
        return $other;
    }
}

// ── One file → one mark ────────────────────────────────────────────────────────
function markOne(PDO $db, $id, $mark, $actor) {
    $db->beginTransaction();
    try {
        $a = loadAsset($db, $id, true);
        if (!$a) throw new RuntimeException('This file is no longer in the vault');
        if (($a['source'] ?? '') !== 'nextcloud') throw new RuntimeException('Only Nextcloud files can be marked');

        // TRASH and RECEIVED leave the watched folders, so the index row goes with them.
        if ($mark === 'TRASH' || $mark === 'RECEIVED') {
            $segment = customerSegment($a['path']);
            $dest = $mark === 'TRASH' ? TRASH_ROOT . "/$segment/" . date('Y-m') : RECEIVED_ROOT . "/$segment";
            ncEnsureFolder($dest);
            $ext = pathinfo($a['file_name'], PATHINFO_EXTENSION);
            $stem = $ext !== '' ? substr($a['file_name'], 0, -(strlen($ext) + 1)) : $a['file_name'];
            $target = null;
            $result = 'taken';
            for ($n = 1; $n <= 50 && $result === 'taken'; $n++) {
                $name = $n === 1 ? $a['file_name'] : ($stem . "-$n" . ($ext !== '' ? ".$ext" : ''));
                $target = "$dest/$name";
                $result = ncMove($a['path'], $target);
            }
            if ($result === 'taken') throw new RuntimeException('No free name in ' . $dest);
            $db->prepare("DELETE FROM public.artwork_vault_assets WHERE id = CAST(:id AS uuid)")->execute([':id' => $a['id']]);
            recordMark($db, $a, [
                'to_mark' => $mark, 'to_path' => $result === 'gone' ? null : $target,
                'to_file_name' => $result === 'gone' ? null : basename($target),
                'note' => $result === 'gone' ? 'File was already missing in Nextcloud; index row removed' : null,
                'marked_by' => $actor,
            ]);
            $db->commit();
            return ['id' => $a['id'], 'new_id' => null, 'file_name' => basename($target), 'path' => $result === 'gone' ? null : $target];
        }

        $stage = STAGES[$mark];
        $base = customerFolder($a['path']);
        $folder = stageFolder($db, $base, $stage);
        $ext = extOf($a['file_name']);

        $code = !empty($a['artwork_code']) ? strtoupper($a['artwork_code']) : null;
        if (!$code) {
            $client = clientCode($db, $a, $base);
            lockClient($db, $client);
            $code = "AW-$client-" . nextPieceNumber($db, $client);
        }

        // Candidate names in order; the first one Nextcloud accepts wins.
        $candidates = [];
        if ($stage['versioned']) {
            $v = nextVersion($db, $code, $stage['suffix']);
            for ($i = 0; $i < 50; $i++) $candidates[] = "$code-{$stage['suffix']}" . str_pad((string)($v + $i), 2, '0', STR_PAD_LEFT) . ".$ext";
        } else {
            $candidates[] = "$code-{$stage['suffix']}.$ext";
            for ($i = 2; $i < 50; $i++) $candidates[] = "$code-{$stage['suffix']}" . str_pad((string)$i, 2, '0', STR_PAD_LEFT) . ".$ext";
        }

        ncEnsureFolder($folder);
        $target = null;
        foreach ($candidates as $name) {
            $path = "$folder/$name";
            if ($path === $a['path']) { $target = $path; break; }      // already right
            $r = ncMove($a['path'], $path);
            if ($r === 'moved') { $target = $path; break; }
            if ($r === 'gone') throw new RuntimeException('The file is missing in Nextcloud');
        }
        if (!$target) throw new RuntimeException('No free file name was found in ' . $folder);

        // The vault has no document stage or type: a document keeps its type and loses its stage.
        $life = $mark === 'DOCS' ? null : $mark;
        $type = $stage['type'] ?? $a['asset_type'];
        $newId = repointRow($db, $a, [
            'path' => $target, 'parent' => $folder, 'name' => basename($target), 'code' => $code,
            'life' => $life, 'type' => $type, 'status' => $stage['status'],
        ]);
        recordMark($db, $a, [
            'to_mark' => $mark, 'new_asset_id' => $newId !== $a['id'] ? $newId : null,
            'artwork_code' => $code, 'to_path' => $target, 'to_file_name' => basename($target),
            'marked_by' => $actor,
        ]);
        $db->commit();
        return ['id' => $a['id'], 'new_id' => $newId, 'file_name' => basename($target), 'path' => $target, 'artwork_code' => $code];
    } catch (Throwable $e) {
        if ($db->inTransaction()) $db->rollBack();
        throw $e;
    }
}

// ── REF → a new SRC with its own number ────────────────────────────────────────
function deriveOne(PDO $db, $id, $actor) {
    $a = loadAsset($db, $id);
    if (!$a) throw new RuntimeException('This file is no longer in the vault');
    if (($a['source'] ?? '') !== 'nextcloud') throw new RuntimeException('Only Nextcloud files can be used');
    $bytes = ncGet($a['path']);
    if ($bytes === null) throw new RuntimeException('The reference file could not be read from Nextcloud');

    $stage = STAGES['SRC'];
    $base = customerFolder($a['path']);
    $ext = extOf($a['file_name']);

    $db->beginTransaction();
    try {
        $folder = stageFolder($db, $base, $stage);
        $client = clientCode($db, $a, $base);
        lockClient($db, $client);
        ncEnsureFolder($folder);

        $code = null;
        $target = null;
        $piece = (int)nextPieceNumber($db, $client);
        for ($i = 0; $i < 25; $i++) {
            $code = "AW-$client-" . str_pad((string)($piece + $i), 4, '0', STR_PAD_LEFT);
            $path = "$folder/$code-SRC.$ext";
            if (ncPutIfAbsent($path, $bytes, $a['mime_type'] ?: mimeOf($ext)) === 'ok') { $target = $path; break; }
        }
        if (!$target) throw new RuntimeException('No free design number was found');

        $insert = $db->prepare("INSERT INTO public.artwork_vault_assets
            (source, source_key, path, parent_path, file_name, mime_type, file_size_bytes, asset_type,
             artwork_code, lifecycle_code, naming_convention_valid, status, version_no,
             lead_id, customer_id, order_id, sales_agent_id, designer_id, sender_name,
             source_modified_at, last_seen_at, updated_at)
            VALUES ('nextcloud', :key, :path, :parent, :name, :mime, :size, 'reference',
                    :code, 'SRC', TRUE, 'Source Received', 0,
                    CAST(:lead AS uuid), CAST(:cust AS uuid), CAST(:ord AS uuid), CAST(:agent AS uuid), CAST(:designer AS uuid), :sender,
                    NOW(), NOW(), NOW())
            ON CONFLICT (source, source_key) DO UPDATE
               SET artwork_code = EXCLUDED.artwork_code, lifecycle_code = 'SRC', asset_type = 'reference',
                   status = 'Source Received', naming_convention_valid = TRUE, updated_at = NOW()
            RETURNING id");
        $insert->execute([
            ':key' => $target, ':path' => $target, ':parent' => $folder, ':name' => basename($target),
            ':mime' => $a['mime_type'] ?: mimeOf($ext), ':size' => strlen($bytes), ':code' => $code,
            ':lead' => $a['lead_id'], ':cust' => $a['customer_id'], ':ord' => $a['order_id'],
            ':agent' => $a['sales_agent_id'], ':designer' => $a['designer_id'], ':sender' => $a['sender_name'],
        ]);
        $childId = $insert->fetchColumn();

        $db->prepare("INSERT INTO gallery.links (parent_asset_id, parent_artwork_code, child_asset_id, child_artwork_code, created_by)
            VALUES (CAST(:p AS uuid), :pc, CAST(:c AS uuid), :cc, :by) ON CONFLICT DO NOTHING")
           ->execute([':p' => $a['id'], ':pc' => $a['artwork_code'], ':c' => $childId, ':cc' => $code, ':by' => $actor]);
        recordMark($db, $a, [
            'to_mark' => 'SRC', 'new_asset_id' => $childId, 'artwork_code' => $code,
            'to_path' => $target, 'to_file_name' => basename($target),
            'note' => 'New source extracted from ' . $a['file_name'], 'marked_by' => $actor,
        ]);
        $db->commit();
        return ['parent_id' => $a['id'], 'id' => $childId, 'file_name' => basename($target), 'path' => $target, 'artwork_code' => $code];
    } catch (Throwable $e) {
        if ($db->inTransaction()) $db->rollBack();
        if (!empty($target)) { try { ncRequest('DELETE', $target, [], null, 30); } catch (Throwable $ignored) {} }
        throw $e;
    }
}

// The vault's watcher polls Nextcloud for recently changed files every few seconds.
// When it lists a new file just before the gallery moves it, it writes a row for
// the old path a moment later. Rows left at a path the gallery moved a file away
// from in the last quarter hour are removed once Nextcloud confirms nothing is there.
function reapStaleRows(PDO $db) {
    $st = $db->query("SELECT DISTINCT a.id, a.path
        FROM gallery.marks m
        JOIN public.artwork_vault_assets a ON a.source = 'nextcloud' AND a.source_key = m.from_path
        WHERE m.status = 'done' AND m.marked_at > NOW() - INTERVAL '15 minutes'
          AND m.to_path IS DISTINCT FROM m.from_path AND m.to_mark <> 'DUPLICATE'
        LIMIT 50");
    $removed = 0;
    foreach ($st->fetchAll() as $row) {
        try {
            [$status] = ncRequest('PROPFIND', $row['path'], ['Depth: 0'], null, 20);
            if ($status !== 404) continue;
            $removed += $db->prepare("DELETE FROM public.artwork_vault_assets WHERE id = CAST(:id AS uuid)")
                ->execute([':id' => $row['id']]) ? 1 : 0;
        } catch (Throwable $e) { /* try again on the next call */ }
    }
    return $removed;
}

// ── Routes ─────────────────────────────────────────────────────────────────────
try {
    if ($action === 'mark') {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') fail(405, 'POST required');
        $in = jsonBody();
        $mark = strtoupper((string)($in['mark'] ?? ''));
        $allowed = array_merge(array_keys(STAGES), ['RECEIVED', 'TRASH']);
        if (!in_array($mark, $allowed, true)) fail(400, 'Unknown mark — expected ' . implode(', ', $allowed));
        $ids = array_values(array_unique(array_filter($in['ids'] ?? [], 'isUuid')));
        if (!$ids) fail(400, 'Select at least one file');
        if (count($ids) > 200) fail(400, 'Mark at most 200 files at a time');

        $done = [];
        $failed = [];
        foreach ($ids as $id) {
            try {
                $done[] = markOne($db, $id, $mark, $actor);
            } catch (Throwable $e) {
                $failed[] = ['id' => $id, 'error' => $e->getMessage()];
                try {
                    $a = loadAsset($db, $id);
                    if ($a) recordMark($db, $a, ['to_mark' => $mark, 'marked_by' => $actor, 'status' => 'failed', 'error' => $e->getMessage()]);
                } catch (Throwable $ignored) {}
            }
        }
        respond(['mark' => $mark, 'done' => $done, 'failed' => $failed]);
    }

    if ($action === 'derive') {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') fail(405, 'POST required');
        $in = jsonBody();
        if (!isUuid($in['id'] ?? null)) fail(400, 'Pick the reference file');
        respond(deriveOne($db, $in['id'], $actor));
    }

    if ($action === 'duplicate') {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') fail(405, 'POST required');
        $in = jsonBody();
        $ids = array_values(array_unique(array_filter($in['ids'] ?? [], 'isUuid')));
        $primary = isUuid($in['primary_id'] ?? null) ? $in['primary_id'] : ($ids[0] ?? null);
        if (count($ids) < 2 || !in_array($primary, $ids, true)) fail(400, 'Select at least two copies of the same file');
        $group = "dup-$primary";
        $primaryAsset = loadAsset($db, $primary);
        $db->beginTransaction();
        foreach ($ids as $id) {
            $a = loadAsset($db, $id);
            if (!$a) continue;
            $db->prepare("INSERT INTO gallery.duplicates (group_key, asset_id, is_primary, marked_by)
                VALUES (:g, CAST(:id AS uuid), :p, :by)
                ON CONFLICT (group_key, asset_id) DO UPDATE SET is_primary = EXCLUDED.is_primary, marked_by = EXCLUDED.marked_by, marked_at = NOW()")
               ->execute([':g' => $group, ':id' => $id, ':p' => $id === $primary ? 'true' : 'false', ':by' => $actor]);
            if ($id !== $primary) {
                recordMark($db, $a, ['to_mark' => 'DUPLICATE', 'to_path' => $a['path'], 'to_file_name' => $a['file_name'],
                    'note' => 'Duplicate of ' . ($primaryAsset['file_name'] ?? $primary), 'marked_by' => $actor]);
            }
        }
        $db->commit();
        respond(['group_key' => $group, 'primary_id' => $primary, 'count' => count($ids)]);
    }

    if ($action === 'history') {
        $id = $_GET['id'] ?? '';
        if (!isUuid($id)) fail(400, 'File id required');
        $st = $db->prepare("SELECT id, asset_id, new_asset_id, from_mark, to_mark, from_file_name, to_file_name,
                from_path, to_path, artwork_code, note, marked_by, marked_at, status, error
            FROM gallery.marks WHERE asset_id = CAST(:a AS uuid) OR new_asset_id = CAST(:b AS uuid)
            ORDER BY marked_at DESC LIMIT 60");
        $st->execute([':a' => $id, ':b' => $id]);
        $marks = $st->fetchAll();

        $st = $db->prepare("SELECT l.parent_asset_id, l.parent_artwork_code, l.child_asset_id, l.child_artwork_code,
                l.created_by, l.created_at, p.file_name AS parent_file_name, c.file_name AS child_file_name
            FROM gallery.links l
            LEFT JOIN public.artwork_vault_assets p ON p.id = l.parent_asset_id
            LEFT JOIN public.artwork_vault_assets c ON c.id = l.child_asset_id
            WHERE l.parent_asset_id = CAST(:a AS uuid) OR l.child_asset_id = CAST(:b AS uuid)
            ORDER BY l.created_at DESC");
        $st->execute([':a' => $id, ':b' => $id]);
        $links = $st->fetchAll();

        $st = $db->prepare("SELECT d.group_key, d.asset_id, d.is_primary, d.marked_by, d.marked_at, a.file_name
            FROM gallery.duplicates d LEFT JOIN public.artwork_vault_assets a ON a.id = d.asset_id
            WHERE d.group_key IN (SELECT group_key FROM gallery.duplicates WHERE asset_id = CAST(:a AS uuid))
            ORDER BY d.is_primary DESC, a.file_name");
        $st->execute([':a' => $id]);
        respond(['marks' => $marks, 'links' => $links, 'duplicates' => $st->fetchAll()]);
    }

    if ($action === 'summary') {
        reapStaleRows($db);
        $ids = array_slice(array_filter(explode(',', $_GET['ids'] ?? ''), 'isUuid'), 0, 300);
        if (!$ids) respond([]);
        $arr = uuidArray($ids);
        $out = [];

        $st = $db->prepare("SELECT DISTINCT ON (COALESCE(new_asset_id, asset_id)) COALESCE(new_asset_id, asset_id) AS id,
                to_mark, marked_by, marked_at
            FROM gallery.marks
            WHERE status = 'done' AND COALESCE(new_asset_id, asset_id) = ANY(CAST(:ids AS uuid[]))
            ORDER BY COALESCE(new_asset_id, asset_id), marked_at DESC");
        $st->execute([':ids' => $arr]);
        foreach ($st->fetchAll() as $r) $out[$r['id']] = ['mark' => $r['to_mark'], 'marked_by' => $r['marked_by'], 'marked_at' => $r['marked_at']];

        $st = $db->prepare("SELECT parent_asset_id AS id, count(*) AS n FROM gallery.links
            WHERE parent_asset_id = ANY(CAST(:ids AS uuid[])) GROUP BY 1");
        $st->execute([':ids' => $arr]);
        foreach ($st->fetchAll() as $r) $out[$r['id']]['children'] = (int)$r['n'];

        $st = $db->prepare("SELECT asset_id AS id, bool_or(is_primary) AS is_primary FROM gallery.duplicates
            WHERE asset_id = ANY(CAST(:ids AS uuid[])) GROUP BY 1");
        $st->execute([':ids' => $arr]);
        foreach ($st->fetchAll() as $r) $out[$r['id']]['duplicate'] = $r['is_primary'] ? 'primary' : 'copy';

        respond($out);
    }

    fail(404, 'Unknown gallery action');
} catch (Throwable $e) {
    if ($db->inTransaction()) $db->rollBack();
    error_log('[gallery] ' . $e->getMessage());
    fail(500, $e->getMessage());
}
