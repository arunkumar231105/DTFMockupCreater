<?php
// ═══════════════════════════════════════════════════════════════════════════════
// API APPS — create the key/secret pairs other systems use to call the Design
// Studio API (render-api/): artwork analysis/prep, mockups, gang sheets, export
// packages and — only if granted — recording human approvals. Nothing here grants
// access to the vault, orders, customers or users.
//
// The secret is returned once, at creation or rotation; only its SHA-256 is kept.
// ═══════════════════════════════════════════════════════════════════════════════

header('Content-Type: application/json');
header('Cache-Control: no-store');

require_once __DIR__ . '/db.php';
require_once __DIR__ . '/auth-helpers.php';

const API_APP_SCOPES = ['artwork', 'mockup', 'gangsheet', 'export', 'approve'];
const API_APP_DEFAULT_SCOPES = ['artwork', 'mockup', 'gangsheet', 'export'];

$user = requireAuth();
$canManage = $user['role'] === 'superadmin' || in_array('apiapps', $user['page_access'] ?? [], true);
if (!$canManage) { http_response_code(403); echo json_encode(['error' => 'You do not have access to API Apps']); exit; }

$db = getDB();
$method = $_SERVER['REQUEST_METHOD'];
$action = $_GET['action'] ?? '';
$input = json_decode(file_get_contents('php://input') ?: '{}', true) ?: [];

function newCredentials() {
    $key = 'dsk_' . bin2hex(random_bytes(16));
    $secret = 'dss_' . bin2hex(random_bytes(32));
    return [$key, $secret, hash('sha256', $secret), substr($secret, -4)];
}

function cleanScopes($raw) {
    $scopes = array_values(array_intersect(API_APP_SCOPES, is_array($raw) ? $raw : []));
    if (!$scopes) { http_response_code(400); echo json_encode(['error' => 'Pick at least one permission']); exit; }
    return $scopes;
}

function pgArray(array $values) {
    return '{' . implode(',', $values) . '}';
}

function loadApp($db, $id) {
    $stmt = $db->prepare("SELECT id FROM api_apps WHERE id = ? AND deleted_at IS NULL");
    $stmt->execute([(int)$id]);
    if (!$stmt->fetch()) { http_response_code(404); echo json_encode(['error' => 'App not found']); exit; }
    return (int)$id;
}

if ($method === 'GET') {
    $rows = $db->query("
        SELECT a.id, a.name, a.api_key, a.secret_hint, array_to_json(a.scopes) AS scopes, a.is_active,
               a.created_at, a.secret_rotated_at, a.last_used_at, a.request_count,
               COALESCE(NULLIF(u.full_name, ''), u.username) AS created_by_name,
               (SELECT COUNT(*) FROM api_request_log l WHERE l.app_id = a.id AND l.created_at > NOW() - INTERVAL '24 hours') AS requests_24h,
               (SELECT COUNT(*) FROM api_request_log l WHERE l.app_id = a.id AND l.status >= 400 AND l.created_at > NOW() - INTERVAL '24 hours') AS errors_24h
        FROM api_apps a
        LEFT JOIN users u ON u.id = a.created_by
        WHERE a.deleted_at IS NULL
        ORDER BY a.created_at DESC
    ")->fetchAll();
    foreach ($rows as &$r) {
        $r['scopes'] = json_decode($r['scopes'], true) ?: [];
        $r['is_active'] = (bool)$r['is_active'];
    }
    echo json_encode(['apps' => $rows, 'scopes' => API_APP_SCOPES, 'default_scopes' => API_APP_DEFAULT_SCOPES]);
    exit;
}

if ($method !== 'POST') { http_response_code(405); echo json_encode(['error' => 'Method not allowed']); exit; }

if ($action === 'create') {
    $name = trim((string)($input['name'] ?? ''));
    if ($name === '' || mb_strlen($name) > 120) { http_response_code(400); echo json_encode(['error' => 'App name is required (max 120 characters)']); exit; }
    $scopes = cleanScopes($input['scopes'] ?? API_APP_DEFAULT_SCOPES);
    [$key, $secret, $hash, $hint] = newCredentials();
    $stmt = $db->prepare("INSERT INTO api_apps (name, api_key, secret_hash, secret_hint, scopes, created_by) VALUES (?, ?, ?, ?, ?::text[], ?) RETURNING id");
    $stmt->execute([$name, $key, $hash, $hint, pgArray($scopes), $user['id']]);
    echo json_encode(['success' => true, 'id' => (int)$stmt->fetch()['id'], 'name' => $name, 'api_key' => $key, 'api_secret' => $secret, 'scopes' => $scopes]);
    exit;
}

if ($action === 'rotate') {
    $id = loadApp($db, $input['id'] ?? 0);
    [, $secret, $hash, $hint] = newCredentials();
    $db->prepare("UPDATE api_apps SET secret_hash = ?, secret_hint = ?, secret_rotated_at = NOW() WHERE id = ?")->execute([$hash, $hint, $id]);
    $key = $db->prepare("SELECT api_key, name FROM api_apps WHERE id = ?");
    $key->execute([$id]);
    $row = $key->fetch();
    echo json_encode(['success' => true, 'id' => $id, 'name' => $row['name'], 'api_key' => $row['api_key'], 'api_secret' => $secret]);
    exit;
}

if ($action === 'update') {
    $id = loadApp($db, $input['id'] ?? 0);
    if (array_key_exists('is_active', $input)) {
        $db->prepare("UPDATE api_apps SET is_active = ? WHERE id = ?")->execute([$input['is_active'] ? 'true' : 'false', $id]);
    }
    if (array_key_exists('scopes', $input)) {
        $db->prepare("UPDATE api_apps SET scopes = ?::text[] WHERE id = ?")->execute([pgArray(cleanScopes($input['scopes'])), $id]);
    }
    if (array_key_exists('name', $input)) {
        $name = trim((string)$input['name']);
        if ($name === '' || mb_strlen($name) > 120) { http_response_code(400); echo json_encode(['error' => 'App name is required (max 120 characters)']); exit; }
        $db->prepare("UPDATE api_apps SET name = ? WHERE id = ?")->execute([$name, $id]);
    }
    echo json_encode(['success' => true]);
    exit;
}

if ($action === 'delete') {
    $id = loadApp($db, $input['id'] ?? 0);
    // Soft delete keeps the request log; the key stops working immediately.
    $db->prepare("UPDATE api_apps SET deleted_at = NOW(), is_active = FALSE WHERE id = ?")->execute([$id]);
    echo json_encode(['success' => true]);
    exit;
}

http_response_code(400);
echo json_encode(['error' => 'Unknown action']);
