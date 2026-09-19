<?php
// ── Gang sheet → Nextcloud ───────────────────────────────────────────────────
// Writes a finished gang sheet straight into the customer's own vault folder:
//
//   Leads 2.0/<customer folder>/Gangsheets/AW-<CLIENT>-<NNNN>-GS<VV>.png
//
// The path is not guessed — it is derived from where that customer's existing
// artwork already lives, so a gang sheet lands beside the files it was built
// from. Naming follows the same AW-<CLIENT>-<NNNN>-<STAGE><VV> convention the
// PrintShop studio save uses (artwork-studio.service.js), so both routes into
// the vault produce files a designer can read the same way.
//
// Nothing is ever overwritten: the PUT carries If-None-Match:*, so a name that
// is already taken comes back 412 and we move to the next version rather than
// clobbering someone else's sheet. That also makes the write safe while the
// Nextcloud watcher has yet to index the previous save.

header('Content-Type: application/json');
header('Cache-Control: no-store');
require_once __DIR__ . '/auth-helpers.php';

$user = requireAuth();
$db = getDB();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405); echo json_encode(['error' => 'POST required']); exit;
}

function fail($status, $message) { http_response_code($status); echo json_encode(['error' => $message]); exit; }
function isUuid($value) { return is_string($value) && preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i', $value); }

// ── Nextcloud WebDAV ────────────────────────────────────────────────────────
function ncConfig() {
    $url = rtrim(trim(getenv('NEXTCLOUD_URL') ?: ''), '/');
    $user = trim(getenv('NEXTCLOUD_USER') ?: '');
    $pass = trim(getenv('NEXTCLOUD_APP_PASSWORD') ?: '');
    if (!$url || !$user || !$pass) fail(500, 'Nextcloud is not configured on this server');
    return ['dav' => $url . '/remote.php/dav/files/' . rawurlencode($user), 'auth' => $user . ':' . $pass];
}

// Encode each segment but keep the slashes: "Leads 2.0/a b.png" → "Leads%202.0/a%20b.png".
function davUrl($cfg, $relPath) {
    $parts = array_map('rawurlencode', array_filter(explode('/', trim($relPath, '/')), 'strlen'));
    return $cfg['dav'] . (count($parts) ? '/' . implode('/', $parts) : '');
}

// This Nextcloud is reachable but not always prompt — a cold PROPFIND can sit
// well past ten seconds — so the connect budget is generous and a dropped
// connection is retried rather than surfaced as a failed save. Retrying a PUT is
// safe here because every PUT carries If-None-Match:*, so a write that actually
// landed comes back 412 on the retry instead of being duplicated.
function davRequest($cfg, $method, $relPath, $body = null, $headers = []) {
    $attempts = 3;
    for ($attempt = 1; ; $attempt++) {
        $curl = curl_init(davUrl($cfg, $relPath));
        curl_setopt_array($curl, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_USERPWD => $cfg['auth'],
            CURLOPT_HTTPAUTH => CURLAUTH_BASIC,
            CURLOPT_CONNECTTIMEOUT => 30,
            CURLOPT_TIMEOUT => 300,
            CURLOPT_HTTPHEADER => $headers,
        ]);
        if ($body !== null) curl_setopt($curl, CURLOPT_POSTFIELDS, $body);
        $response = curl_exec($curl);
        $status = curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
        $error = curl_error($curl);
        curl_close($curl);

        if ($response !== false && $status < 500) return ['status' => $status, 'body' => $response];
        if ($attempt >= $attempts) {
            fail(502, $response === false
                ? 'Nextcloud is unreachable: ' . $error
                : "Nextcloud returned {$status} for {$method} {$relPath}");
        }
        error_log("[gangsheet-save] {$method} {$relPath} attempt {$attempt} failed (" . ($error ?: $status) . '), retrying');
        usleep(500000 * $attempt);
    }
}

// MKCOL is per level and 405 simply means "already there".
function ensureFolder($cfg, $relPath) {
    $current = '';
    foreach (array_filter(explode('/', trim($relPath, '/')), 'strlen') as $part) {
        $current = $current === '' ? $part : $current . '/' . $part;
        $result = davRequest($cfg, 'MKCOL', $current);
        if (!in_array($result['status'], [201, 405], true)) {
            fail(502, "Could not create folder \"{$current}\" in Nextcloud ({$result['status']})");
        }
    }
}

// ── Which customer, and therefore which folder ──────────────────────────────
$orderId     = $_POST['order_id'] ?? '';
$customerId  = $_POST['customer_id'] ?? '';
$assetId     = $_POST['asset_id'] ?? '';
$customerName = trim($_POST['customer_name'] ?? '');
$existingCode = strtoupper(trim($_POST['artwork_code'] ?? ''));

if (!isset($_FILES['file']) || $_FILES['file']['error'] !== UPLOAD_ERR_OK) {
    $code = $_FILES['file']['error'] ?? 'missing';
    fail(400, $code === UPLOAD_ERR_INI_SIZE || $code === UPLOAD_ERR_FORM_SIZE
        ? 'The gang sheet is larger than this server accepts'
        : 'Gang sheet image is required (upload error: ' . $code . ')');
}

// An order identifies its customer; everything else is a direct hint.
if (isUuid($orderId) && !isUuid($customerId)) {
    $stmt = $db->prepare("SELECT o.customer_id, COALESCE(c.name, o.contact_name, o.shipping_name) AS name
                          FROM public.orders o LEFT JOIN public.customers c ON c.id = o.customer_id
                          WHERE o.id = ? AND o.deleted_at IS NULL");
    $stmt->execute([$orderId]);
    if ($row = $stmt->fetch()) {
        $customerId = $row['customer_id'] ?: '';
        if ($customerName === '') $customerName = (string)$row['name'];
    }
}

// The customer folder is everything above the first stage folder in a path
// ("Leads 2.0/260707_Victor_Spates/Artworks/x.png" → "Leads 2.0/260707_Victor_Spates").
// It is read back from the vault index rather than composed, so a customer whose
// folder was renamed still gets their sheets in the right place.
$STAGE_DIRS = "^(references?|refs?|artworks?|working|versions?|mockups?|sent|outgoing|gang-?sheets?|finals?|final_files|production|combos?|documents?)$";

function customerBaseFolder($db, $stageDirs, $assetId, $customerId, $customerName) {
    $sql = "SELECT base, SUM(files)::int AS files FROM (
              SELECT CASE WHEN idx > 0 THEN array_to_string(parts[1:idx-1], '/')
                          ELSE array_to_string(parts[1:GREATEST(array_length(parts,1)-1,1)], '/') END AS base,
                     COUNT(*) AS files
              FROM (
                SELECT parts, COALESCE((SELECT MIN(i) FROM generate_subscripts(parts,1) i
                                        WHERE i > 1 AND parts[i] ~* ?), 0) AS idx
                FROM (SELECT string_to_array(a.path, '/') AS parts
                      FROM public.artwork_vault_assets a
                      WHERE a.source = 'nextcloud' AND (%s)) s
              ) t GROUP BY 1
            ) g WHERE base <> '' GROUP BY base
            ORDER BY (base LIKE 'Leads 2.0/%%') DESC, files DESC LIMIT 1";

    // Most precise hint first: the exact asset, then the linked customer, then
    // the customer's name against the folder it is spelled into.
    $attempts = [];
    if (isUuid($assetId))    $attempts[] = ['a.id = ?::uuid', [$assetId]];
    if (isUuid($customerId)) $attempts[] = ['a.customer_id = ?::uuid', [$customerId]];
    if ($customerName !== '') {
        // Customer folders are named "<date>_<First>_<Last>", so match the name part.
        $slug = preg_replace('/\s+/', '_', trim($customerName));
        $attempts[] = ["a.path ILIKE ? OR a.path ILIKE ?", ["%/{$slug}/%", "%_{$slug}/%"]];
    }

    foreach ($attempts as [$where, $params]) {
        $stmt = $db->prepare(sprintf($sql, $where));
        $stmt->execute(array_merge([$stageDirs], $params));
        if ($row = $stmt->fetch()) return $row['base'];
    }
    return null;
}

$base = customerBaseFolder($db, $STAGE_DIRS, $assetId, $customerId, $customerName);
if (!$base) {
    fail(404, $customerName !== ''
        ? "No Nextcloud folder is on file for \"{$customerName}\" — open one of their artworks in the Vault once, then save again"
        : 'Select a customer before saving the gang sheet');
}

// Stage folders are spelled inconsistently across the vault ("Gangsheets",
// "Gang Sheets", "gangsheet"), so reuse whichever one this customer already has
// instead of creating a second folder next to it.
$stmt = $db->prepare("SELECT split_part(substr(parent_path, length(?) + 2), '/', 1) AS folder, COUNT(*)::int AS files
                      FROM public.artwork_vault_assets
                      WHERE source = 'nextcloud' AND strpos(parent_path, ? || '/') = 1
                        AND split_part(substr(parent_path, length(?) + 2), '/', 1) ~* '^gang-?[ _]?sheets?$'
                      GROUP BY 1 ORDER BY files DESC LIMIT 1");
$stmt->execute([$base, $base, $base]);
$stageRow = $stmt->fetch();
$folder = $base . '/' . ($stageRow['folder'] ?? 'Gangsheets');

// ── AW-<CLIENT>-<NNNN> ──────────────────────────────────────────────────────
// The client segment is assigned by the design team, so adopt the one this
// customer's existing files already carry rather than minting a competing code.
function resolveClientCode($db, $base, $customerId, $customerName) {
    $stmt = $db->prepare("SELECT split_part(artwork_code, '-', 2) AS code, COUNT(*)::int AS files
                          FROM public.artwork_vault_assets
                          WHERE source = 'nextcloud' AND artwork_code IS NOT NULL AND artwork_code <> ''
                            AND (strpos(path, ? || '/') = 1 OR (?::uuid IS NOT NULL AND customer_id = ?::uuid))
                          GROUP BY 1 ORDER BY files DESC LIMIT 1");
    $uuid = isUuid($customerId) ? $customerId : null;
    $stmt->execute([$base, $uuid, $uuid]);
    if ($row = $stmt->fetch()) { if (!empty($row['code'])) return strtoupper($row['code']); }

    // No coded file at all: derive one from the name and check it is free.
    $source = $customerName !== '' ? $customerName : basename($base);
    $letters = substr(preg_replace('/[^A-Z]/', '', strtoupper($source)), 0, 3);
    $letters = str_pad($letters ?: 'GEN', 3, 'X');
    $taken = $db->prepare("SELECT DISTINCT upper(split_part(artwork_code, '-', 2)) AS code
                           FROM public.artwork_vault_assets WHERE artwork_code LIKE ?");
    $taken->execute(["AW-{$letters}%"]);
    $used = array_column($taken->fetchAll(), 'code');
    for ($n = 1; $n < 100; $n++) {
        $candidate = $letters . str_pad($n, 2, '0', STR_PAD_LEFT);
        if (!in_array($candidate, $used, true)) return $candidate;
    }
    fail(409, "No free client code remains for {$letters}");
}

// The piece number identifies the design, not the stage, so one is only minted
// for a gang sheet that has none yet — the next free number across every stage.
function nextPieceNumber($db, $clientCode) {
    $stmt = $db->prepare("SELECT COALESCE(MAX(NULLIF(split_part(artwork_code, '-', 3), '')::int), 0) AS highest
                          FROM public.artwork_vault_assets
                          WHERE artwork_code LIKE ? AND split_part(artwork_code, '-', 3) ~ '^[0-9]{4}$'");
    $stmt->execute(["AW-{$clientCode}-%"]);
    return str_pad((int)$stmt->fetch()['highest'] + 1, 4, '0', STR_PAD_LEFT);
}

// The next version for this design at this stage. Numbering never reuses: the
// highest ever recorded wins, so two saves can never point at the same name.
function nextVersionNumber($db, $code, $kindCode) {
    $prefix = preg_quote($code . '-' . $kindCode, '/');
    $prefix = str_replace('/', '\/', $prefix);
    $stmt = $db->prepare("SELECT COALESCE(MAX(COALESCE(NULLIF(substring(file_name from ?), '')::int, 1)), 0) AS highest
                          FROM public.artwork_vault_assets
                          WHERE source = 'nextcloud' AND file_name ~ ?");
    $stmt->execute(["^{$prefix}([0-9]+)", "^{$prefix}[0-9]*(-[0-9.]+x[0-9.]+)?\\."]);
    return (int)$stmt->fetch()['highest'] + 1;
}

// A multi-sheet gang sheet is saved one request per sheet; the client passes the
// code back so every sheet of the same job keeps one piece number and only the
// version moves (…-GS01, …-GS02, …).
if (preg_match('/^AW-[A-Z0-9]+-\d{4}$/', $existingCode)) {
    $code = $existingCode;
} else {
    $clientCode = resolveClientCode($db, $base, $customerId, $customerName);
    $code = 'AW-' . $clientCode . '-' . nextPieceNumber($db, $clientCode);
}

$mime = $_FILES['file']['type'] ?: 'image/png';
$ext = strtolower(pathinfo($_FILES['file']['name'], PATHINFO_EXTENSION));
if (!preg_match('/^[a-z0-9]{1,8}$/', $ext)) $ext = ['image/jpeg' => 'jpg', 'application/pdf' => 'pdf'][$mime] ?? 'png';

$bytes = file_get_contents($_FILES['file']['tmp_name']);
if ($bytes === false || $bytes === '') fail(400, 'Gang sheet image could not be read');

$cfg = ncConfig();
ensureFolder($cfg, $folder);

// The sheet's printed size goes into the name — "22x4" = 22" wide, 4" long — the way
// the Download button has always named it, so production sees the size at a glance.
$sheetSize = trim((string)($_POST['sheet_size'] ?? ''));
if (!preg_match('/^\d{1,3}(\.\d{1,2})?x\d{1,4}(\.\d{1,2})?$/', $sheetSize)) $sheetSize = '';

// With the size in the name, two sheets of one job no longer collide on the same
// filename, so "taken, try the next version" alone cannot keep versions unique —
// and the vault index lags a few seconds behind a save. Count what is already in
// the folder as well.
function folderHighestVersion($cfg, $folder, $code, $kindCode) {
    $result = davRequest($cfg, 'PROPFIND', $folder, null, ['Depth: 1']);
    if ($result['status'] !== 207) return 0;
    preg_match_all('/' . preg_quote($code . '-' . $kindCode, '/') . '(\d+)/i', $result['body'], $m);
    return $m[1] ? max(array_map('intval', $m[1])) : 0;
}

// Claim the name atomically. If another save took it in between, Nextcloud
// refuses the write with 412 and we move to the next version.
$version = max(nextVersionNumber($db, $code, 'GS'), folderHighestVersion($cfg, $folder, $code, 'GS') + 1);
$saved = null;
for ($attempt = 0; $attempt < 50; $attempt++, $version++) {
    $fileName = sprintf('%s-GS%02d%s.%s', $code, $version, $sheetSize !== '' ? "-{$sheetSize}" : '', $ext);
    $path = $folder . '/' . $fileName;
    $result = davRequest($cfg, 'PUT', $path, $bytes, [
        'Content-Type: ' . $mime,
        'Content-Length: ' . strlen($bytes),
        'If-None-Match: *',
    ]);
    if ($result['status'] === 412) continue;   // taken — try the next version
    if (!in_array($result['status'], [200, 201, 204], true)) {
        fail(502, "Nextcloud rejected the upload ({$result['status']})");
    }
    $saved = ['file_name' => $fileName, 'path' => $path];
    break;
}
if (!$saved) fail(409, "Could not allocate a gang sheet filename for {$code}");

error_log(sprintf('[gangsheet-save] %s saved %s (%d bytes)', $user['username'] ?? '?', $saved['path'], strlen($bytes)));

echo json_encode([
    'success' => true,
    'file_name' => $saved['file_name'],
    'path' => $saved['path'],
    'folder' => $folder,
    'artwork_code' => $code,          // sheet 2+ passes this back so the job stays one piece
    'version' => $version,
]);
