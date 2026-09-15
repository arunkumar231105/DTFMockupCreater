<?php
// Same-origin bridge between Design Studio and PrintShop's signed artwork API.
// Browsers never cross the Authentik boundary; every read/write is still
// validated by PrintShop against a short-lived HS256 token minted here.
//
// Two token scopes:
//   vault  — read the artwork index and its thumbnails (list, facets, revision,
//            thumb, handoff). Minted once per request, server-side.
//   asset  — read/replace the bytes of ONE asset. Only ever handed out for the
//            file a designer actually opened, via ?action=handoff.
//
// The vault scope is minted here rather than per row: the previous version
// signed one JWT for every one of the 5 800 rows on every poll.

$backend = rtrim(getenv('PRINTSHOP_INTERNAL_API') ?: 'http://decoinks_backend:8000/api', '/');
$action = $_GET['action'] ?? '';
$token = $_GET['token'] ?? ($_POST['token'] ?? '');

function base64UrlEncode($value) {
    return rtrim(strtr(base64_encode($value), '+/', '-_'), '=');
}

function signToken(array $claims) {
    $secret = getenv('PRINTSHOP_JWT_SECRET') ?: '';
    if (!$secret) throw new RuntimeException('JWT secret is not configured');
    $now = time();
    $header = base64UrlEncode(json_encode(['alg' => 'HS256', 'typ' => 'JWT']));
    $payload = base64UrlEncode(json_encode($claims + [
        'user_id' => null,
        'iat' => $now,
        'exp' => $now + 7200,
        'aud' => 'decoinks-design-studio',
        'iss' => 'decoinks-printshop',
    ]));
    return $header . '.' . $payload . '.' . base64UrlEncode(hash_hmac('sha256', $header . '.' . $payload, $secret, true));
}

function createArtworkToken($assetId) {
    return signToken(['purpose' => 'design-studio-artwork', 'asset_id' => $assetId]);
}

function createVaultToken() {
    return signToken(['purpose' => 'design-studio-vault']);
}

function jsonError($status, $message, $detail = null) {
    http_response_code($status);
    header('Content-Type: application/json');
    echo json_encode(array_filter([
        'success' => false,
        'message' => $message,
        'detail' => $detail,
    ], fn($v) => $v !== null));
    exit;
}

// Forward a GET to PrintShop with a freshly minted vault token. `$binary`
// streams the upstream body and content type through untouched (thumbnails).
function proxyVaultGet($backend, $path, array $drop = [], $binary = false) {
    $query = $_GET;
    foreach (array_merge(['action'], $drop) as $key) unset($query[$key]);
    try {
        $query['token'] = createVaultToken();
    } catch (RuntimeException $e) {
        jsonError(500, $e->getMessage());
    }

    $headers = [];
    $request = [];
    // Pass the browser's cache validator through so an unchanged thumbnail can
    // come back as a bodyless 304 instead of being re-sent.
    if ($binary && !empty($_SERVER['HTTP_IF_NONE_MATCH'])) {
        $request[] = 'If-None-Match: ' . $_SERVER['HTTP_IF_NONE_MATCH'];
    }

    $curl = curl_init($backend . $path . '?' . http_build_query($query));
    curl_setopt_array($curl, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_TIMEOUT => 60,
        CURLOPT_HTTPHEADER => $request,
        CURLOPT_ENCODING => '',
        CURLOPT_HEADERFUNCTION => function ($curl, $line) use (&$headers) {
            $parts = explode(':', $line, 2);
            if (count($parts) === 2) $headers[strtolower(trim($parts[0]))] = trim($parts[1]);
            return strlen($line);
        },
    ]);
    $body = curl_exec($curl);
    $status = curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
    $error = curl_error($curl);
    curl_close($curl);

    if ($body === false) jsonError(502, 'PrintShop artwork service is unavailable', $error);

    http_response_code($status ?: 502);
    if ($binary) {
        if (!empty($headers['etag'])) header('ETag: ' . $headers['etag']);
        header('Cache-Control: private, max-age=604800, immutable');
        if ($status === 304) exit;                       // nothing to send
        header('Content-Type: ' . ($headers['content-type'] ?? 'image/webp'));
    } else {
        header('Content-Type: application/json');
        header('Cache-Control: private, no-store');
    }
    echo $body;
    exit;
}

// ── Vault-scope endpoints ───────────────────────────────────────────────────
if ($action === 'vault')    proxyVaultGet($backend, '/artworks/studio/vault');
if ($action === 'facets') {
    // Show each customer the way the CRM shows its leads: the CRM's own name and
    // lead number (LD-######), newest lead first. PrintShop's leads are copies
    // of CRM leads numbered "CRM-fb-<psid>"; the CRM keys the same lead as
    // "fb:<psid>". Anything that can't be matched keeps what PrintShop sent,
    // and if the lookup fails for any reason the response goes out untouched.
    ob_start(function ($body) {
        if (http_response_code() !== 200) return $body;
        try {
            return enrichCustomersFromCrm($body);
        } catch (Throwable $e) {
            error_log('[vault facets] CRM names skipped: ' . $e->getMessage());
            return $body;
        }
    });
    proxyVaultGet($backend, '/artworks/studio/vault/facets');
}

function enrichCustomersFromCrm($body) {
    $payload = json_decode($body, true);
    $customers = $payload['data']['customers'] ?? null;
    if (!is_array($customers) || !$customers) return $body;

    $keys = [];
    foreach ($customers as $c) {
        if (preg_match('/^[cl]:[0-9a-f-]{36}$/i', $c['key'] ?? '')) $keys[] = $c['key'];
    }
    $crm = [];
    if ($keys) {
        $url = parse_url(getenv('DATABASE_URL') ?: '');
        if (!$url || empty($url['host'])) return $body;
        $pdo = new PDO(
            sprintf('pgsql:host=%s;port=%d;dbname=%s', $url['host'], $url['port'] ?? 5432, ltrim($url['path'] ?? '', '/')),
            urldecode($url['user'] ?? ''), urldecode($url['pass'] ?? ''),
            [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC, PDO::ATTR_TIMEOUT => 5]
        );
        $stmt = $pdo->prepare(
            "SELECT DISTINCT ON (k.key) k.key, x.legacy_id, x.created_at,
                    COALESCE(NULLIF(x.extra->>'name', ''), NULLIF(cv.extra->>'name', ''), NULLIF(cu.full_name, '')) AS name
               FROM unnest(?::text[]) AS k(key)
               LEFT JOIN public.customers pc
                      ON pc.id = CASE WHEN k.key LIKE 'c:%' THEN substr(k.key, 3)::uuid END
               JOIN public.leads pl
                      ON pl.id = COALESCE(pc.lead_id, CASE WHEN k.key LIKE 'l:%' THEN substr(k.key, 3)::uuid END)
               JOIN app.leads x
                      ON pl.lead_number LIKE 'CRM-%'
                     AND x.legacy_id = split_part(pl.lead_number, '-', 2) || ':' || split_part(pl.lead_number, '-', 3)
               LEFT JOIN app.conversations cv ON cv.legacy_id = x.legacy_id
               LEFT JOIN app.customers cu ON cu.customer_id = x.customer_id
              ORDER BY k.key, x.created_at DESC"
        );
        $stmt->execute(['{' . implode(',', $keys) . '}']);
        foreach ($stmt->fetchAll() as $row) $crm[$row['key']] = $row;
    }

    foreach ($customers as &$c) {
        $hit = $crm[$c['key'] ?? ''] ?? null;
        if (!$hit) continue;
        // Same number the CRM Leads page prints: LD- + last six digits of its id.
        $digits = preg_replace('/\D/', '', $hit['legacy_id']);
        $c['lead_no'] = 'LD-' . (substr($digits, -6) ?: '000000');
        if (!empty($hit['name'])) $c['name'] = $hit['name'];
        $c['crm_created_at'] = $hit['created_at'];
    }
    unset($c);

    // Newest CRM lead first, like the Leads page; unmatched folders after, by name.
    usort($customers, function ($a, $b) {
        $ta = $a['crm_created_at'] ?? null; $tb = $b['crm_created_at'] ?? null;
        if ($ta && $tb) return strcmp($tb, $ta);
        if ($ta || $tb) return $ta ? -1 : 1;
        return strcasecmp($a['name'] ?? '', $b['name'] ?? '');
    });
    $payload['data']['customers'] = $customers;
    return json_encode($payload);
}
if ($action === 'revision') proxyVaultGet($backend, '/artworks/studio/vault/revision');
if ($action === 'thumb')    proxyVaultGet($backend, '/artworks/studio/thumb', ['v'], true);
if ($action === 'handoff')  proxyVaultGet($backend, '/artworks/studio/handoff');
if ($action === 'pieces')   proxyVaultGet($backend, '/artworks/studio/vault/pieces'); // designs an upload can attach to

// ── Upload to vault (new file) ──────────────────────────────────────────────
// Forwards the file to PrintShop, which writes it into the selected customer's
// Nextcloud folder — the type (REF/SRC → references, WRK → Artworks, FNL/FNLA →
// final_files) picks the sub-folder — names it to the AW-<CLIENT>-<NNNN>-<TYPE>
// standard and indexes it. The old build saved to a local disk that never
// reached Nextcloud; everything real now happens server-side over WebDAV.
if ($action === 'upload') {
    header('Content-Type: application/json');
    header('Cache-Control: private, no-store');

    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        jsonError(405, 'POST required');
    }
    if (!isset($_FILES['file']) || $_FILES['file']['error'] !== UPLOAD_ERR_OK) {
        jsonError(400, 'File is required (error code: ' . ($_FILES['file']['error'] ?? 'missing') . ')');
    }
    if (empty($_POST['entity_key'])) {
        jsonError(400, 'Customer (entity_key) is required');
    }

    // entity_key is the vault's own key ("c:<uuid>", "l:<uuid>", "p:<root>/<folder>"),
    // so its colon and slash must survive — only strip control characters.
    $entityKey = preg_replace('/[\x00-\x1F]/', '', $_POST['entity_key']);
    $lifecycleCode = preg_replace('/[^A-Z]/', '', strtoupper($_POST['lifecycle_code'] ?? 'SRC'));
    // Which design this file belongs to. WRK/FNL/FNLA inherit that design's
    // AW-<CLIENT>-<NNNN> code so only the type suffix changes.
    $attachTo = preg_replace('/[^a-zA-Z0-9\-]/', '', $_POST['attach_to'] ?? '');

    try {
        $vaultToken = createVaultToken();
    } catch (RuntimeException $e) {
        jsonError(500, $e->getMessage());
    }

    $ch = curl_init($backend . '/artworks/studio/vault/upload');
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => [
            'token' => $vaultToken,
            'entity_key' => $entityKey,
            'lifecycle_code' => $lifecycleCode,
            'attach_to' => $attachTo,
            'file' => new CURLFile(
                $_FILES['file']['tmp_name'],
                $_FILES['file']['type'] ?: 'application/octet-stream',
                $_FILES['file']['name'] ?: 'artwork'
            ),
        ],
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_TIMEOUT => 120,
    ]);
    $body = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $error = curl_error($ch);
    curl_close($ch);

    if ($body === false) {
        jsonError(502, 'PrintShop artwork service is unavailable', $error);
    }
    http_response_code($status ?: 502);
    echo $body;
    exit;
}

// ── Move selection to Trash ─────────────────────────────────────────────────
// The vault's multi-select trash. Mints a vault-scope token (same scope the grid
// reads with) and forwards the selected asset ids to PrintShop, which MOVEs each
// file out of Leads 2.0/PO into the Nextcloud Trash bin and drops its index row.
if ($action === 'trash') {
    header('Content-Type: application/json');
    header('Cache-Control: private, no-store');
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        jsonError(405, 'POST required');
    }
    $input = json_decode(file_get_contents('php://input'), true);
    $ids = is_array($input['ids'] ?? null) ? $input['ids'] : [];
    if (!$ids) {
        jsonError(400, 'No files were selected to trash');
    }
    try {
        $vaultToken = createVaultToken();
    } catch (RuntimeException $e) {
        jsonError(500, $e->getMessage());
    }
    $ch = curl_init($backend . '/artworks/studio/vault/trash');
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST => true,
        CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
        CURLOPT_POSTFIELDS => json_encode(['token' => $vaultToken, 'ids' => array_values($ids)]),
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_TIMEOUT => 120,
    ]);
    $body = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $error = curl_error($ch);
    curl_close($ch);
    if ($body === false) {
        jsonError(502, 'PrintShop artwork service is unavailable', $error);
    }
    http_response_code($status ?: 502);
    echo $body;
    exit;
}

if ($action === 'latest') {
    require_once __DIR__ . '/db.php';
    $row = getDB()->query("SELECT asset_id,file_name,version_no,last_opened_at
        FROM design_studio_vault_items ORDER BY last_opened_at DESC LIMIT 1")->fetch();
    header('Content-Type: application/json');
    header('Cache-Control: private, no-store');
    echo json_encode(['success' => true, 'data' => $row ? [
        'asset_id' => $row['asset_id'],
        'file_name' => $row['file_name'],
        'version_no' => (int)$row['version_no'],
        'token' => createArtworkToken($row['asset_id']),
    ] : null]);
    exit;
}

// ── Asset-scope endpoints ───────────────────────────────────────────────────
// `content` accepts an asset id + vault token as well, so a card can download
// its own file without the caller round-tripping through ?action=handoff first.
if ($action === 'content' && !$token && !empty($_GET['id'])) {
    try {
        $token = createArtworkToken($_GET['id']);
    } catch (RuntimeException $e) {
        jsonError(500, $e->getMessage());
    }
}

if (!$token || !in_array($action, ['asset', 'content', 'save'], true)) {
    jsonError(400, 'Invalid artwork request');
}

$curl = curl_init();
$headers = [];

if ($action === 'save') {
    if (!isset($_FILES['file']) || $_FILES['file']['error'] !== UPLOAD_ERR_OK) {
        jsonError(400, 'Edited artwork file is required');
    }
    curl_setopt_array($curl, [
        CURLOPT_URL => $backend . '/artworks/studio/save',
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => [
            'token' => $token,
            // Which studio tool is saving: WRK (editor), MU (mockup), GS (gang sheet).
            'kind' => $_POST['kind'] ?? ($_GET['kind'] ?? 'WRK'),
            'file' => new CURLFile(
                $_FILES['file']['tmp_name'],
                $_FILES['file']['type'] ?: 'image/png',
                $_FILES['file']['name'] ?: 'artwork.png'
            ),
        ],
    ]);
} else {
    $endpoint = $action === 'asset' ? 'asset' : 'content';
    curl_setopt($curl, CURLOPT_URL, $backend . '/artworks/studio/' . $endpoint . '?token=' . rawurlencode($token));
}

curl_setopt_array($curl, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_FOLLOWLOCATION => false,
    CURLOPT_CONNECTTIMEOUT => 10,
    CURLOPT_TIMEOUT => 120,
    CURLOPT_HEADERFUNCTION => function ($curl, $line) use (&$headers) {
        $length = strlen($line);
        $parts = explode(':', $line, 2);
        if (count($parts) === 2) $headers[strtolower(trim($parts[0]))] = trim($parts[1]);
        return $length;
    },
]);

$body = curl_exec($curl);
$status = curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
$error = curl_error($curl);
curl_close($curl);

if ($body === false) {
    jsonError(502, 'PrintShop artwork service is unavailable', $error);
}

http_response_code($status ?: 502);
header('Content-Type: ' . ($headers['content-type'] ?? ($action === 'content' ? 'application/octet-stream' : 'application/json')));
header('Cache-Control: private, no-store');

if ($action === 'asset' && $status >= 200 && $status < 300) {
    $payload = json_decode($body, true);
    $asset = $payload['data'] ?? null;
    if (!empty($asset['id']) && !empty($asset['file_name'])) {
        require_once __DIR__ . '/db.php';
        $statement = getDB()->prepare("INSERT INTO design_studio_vault_items
            (asset_id,file_name,version_no,last_opened_at) VALUES (?::uuid,?,?,NOW())
            ON CONFLICT (asset_id) DO UPDATE SET
              file_name=EXCLUDED.file_name,version_no=EXCLUDED.version_no,last_opened_at=NOW()");
        $statement->execute([$asset['id'], $asset['file_name'], (int)($asset['version_no'] ?? 0)]);
    }
}

echo $body;
