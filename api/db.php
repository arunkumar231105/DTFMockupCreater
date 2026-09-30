<?php
// Central Decoinks PostgreSQL connection. DTF tables live in their own schema,
// so they cannot collide with Decoinks, Technocas CRM, or BlankTex tables.
$databaseUrl = getenv('DATABASE_URL') ?: '';
$dbSchema = getenv('DB_SCHEMA') ?: 'dtf';

function getDB() {
    global $databaseUrl, $dbSchema;
    static $pdo = null;
    if ($pdo !== null) return $pdo;

    try {
        if (!$databaseUrl) throw new RuntimeException('DATABASE_URL is not configured');
        $parts = parse_url($databaseUrl);
        if (!$parts || !isset($parts['host'], $parts['path'])) throw new RuntimeException('DATABASE_URL is invalid');

        $host = $parts['host'];
        $port = $parts['port'] ?? 5432;
        $name = ltrim($parts['path'], '/');
        $user = urldecode($parts['user'] ?? 'postgres');
        $pass = urldecode($parts['pass'] ?? '');
        $pdo = new PDO("pgsql:host={$host};port={$port};dbname={$name}", $user, $pass, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ]);
        if (!preg_match('/^[a-z_][a-z0-9_]*$/', $dbSchema)) throw new RuntimeException('DB_SCHEMA is invalid');
        $pdo->exec("SET search_path TO {$dbSchema}, public");
        return $pdo;
    } catch (Throwable $e) {
        http_response_code(500);
        echo json_encode(['error' => 'Database connection failed']);
        error_log('[database] ' . $e->getMessage());
        exit;
    }
}

// Additive and idempotent: startup never drops or truncates existing data.
function initDatabase() {
    $db = getDB();
    $db->exec("CREATE TABLE IF NOT EXISTS users (
        id BIGSERIAL PRIMARY KEY,
        username VARCHAR(100) NOT NULL UNIQUE,
        email VARCHAR(255) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        full_name VARCHAR(255) DEFAULT '',
        role VARCHAR(20) NOT NULL DEFAULT 'viewer'
            CHECK (role IN ('superadmin', 'admin', 'editor', 'viewer')),
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        page_access JSONB DEFAULT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_login TIMESTAMPTZ NULL
    )");

    $db->exec("CREATE TABLE IF NOT EXISTS sessions (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token VARCHAR(128) NOT NULL UNIQUE,
        expires_at TIMESTAMPTZ NOT NULL,
        ip_address VARCHAR(45) DEFAULT '',
        user_agent TEXT DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )");
    $db->exec("CREATE INDEX IF NOT EXISTS ix_dtf_sessions_user ON sessions(user_id)");
    $db->exec("CREATE INDEX IF NOT EXISTS ix_dtf_sessions_expiry ON sessions(expires_at)");

    $db->exec("CREATE TABLE IF NOT EXISTS gang_sheets (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        order_id UUID NOT NULL UNIQUE REFERENCES public.orders(id) ON DELETE CASCADE,
        customer_id UUID NULL REFERENCES public.customers(id) ON DELETE SET NULL,
        created_by BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','ready','exported')),
        sheet_width NUMERIC(6,2) NOT NULL DEFAULT 22,
        total_height NUMERIC(8,2) NOT NULL DEFAULT 0,
        total_sheets INTEGER NOT NULL DEFAULT 1,
        total_artworks INTEGER NOT NULL DEFAULT 0,
        total_quantity INTEGER NOT NULL DEFAULT 0,
        estimated_price NUMERIC(12,2) NOT NULL DEFAULT 0,
        settings JSONB NOT NULL DEFAULT '{}'::jsonb,
        layout JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )");
    $db->exec("CREATE TABLE IF NOT EXISTS gang_sheet_artworks (
        id BIGSERIAL PRIMARY KEY,
        gang_sheet_id UUID NOT NULL REFERENCES gang_sheets(id) ON DELETE CASCADE,
        order_item_id UUID NULL REFERENCES public.order_items_dtf(id) ON DELETE SET NULL,
        artwork_id UUID NULL REFERENCES public.artworks(id) ON DELETE SET NULL,
        artwork_no VARCHAR(100),
        filename VARCHAR(255) NOT NULL,
        image_url TEXT,
        width_inches NUMERIC(7,2) NOT NULL,
        height_inches NUMERIC(7,2) NOT NULL,
        quantity INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )");
    $db->exec("CREATE INDEX IF NOT EXISTS ix_dtf_gang_sheet_artworks_sheet ON gang_sheet_artworks(gang_sheet_id)");

    // Developer API: apps other systems use for artworks, mockups, gang sheets.
    // Only the SHA-256 of a secret is kept — the secret itself is shown once.
    $db->exec("CREATE TABLE IF NOT EXISTS api_apps (
        id BIGSERIAL PRIMARY KEY,
        name VARCHAR(120) NOT NULL,
        api_key VARCHAR(64) NOT NULL UNIQUE,
        secret_hash CHAR(64) NOT NULL,
        secret_hint VARCHAR(12) NOT NULL DEFAULT '',
        scopes TEXT[] NOT NULL DEFAULT ARRAY['artwork','mockup','gangsheet','export']::text[],
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_by BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        secret_rotated_at TIMESTAMPTZ NULL,
        last_used_at TIMESTAMPTZ NULL,
        request_count BIGINT NOT NULL DEFAULT 0,
        deleted_at TIMESTAMPTZ NULL
    )");
    $db->exec("CREATE TABLE IF NOT EXISTS api_request_log (
        id BIGSERIAL PRIMARY KEY,
        app_id BIGINT NOT NULL REFERENCES api_apps(id) ON DELETE CASCADE,
        endpoint VARCHAR(60) NOT NULL,
        status INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        detail TEXT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )");
    $db->exec("CREATE INDEX IF NOT EXISTS ix_dtf_api_request_log_app ON api_request_log(app_id, created_at DESC)");

    $stmt = $db->query("SELECT COUNT(*) AS cnt FROM users WHERE role = 'superadmin'");
    if ((int)$stmt->fetch()['cnt'] === 0) {
        $hash = password_hash('admin123', PASSWORD_BCRYPT);
        $allPages = json_encode(['vault','bgremover','qa','orders','garments','gangsheet','gscalc','gsoptimize','contrast','ailab','users','mockupv2']);
        $db->prepare("INSERT INTO users (username, email, password_hash, full_name, role, page_access) VALUES (?, ?, ?, ?, 'superadmin', ?::jsonb)")
           ->execute(['admin', 'admin@printshop.local', $hash, 'Super Admin', $allPages]);
    }
}

try { initDatabase(); } catch (Throwable $e) { error_log('[database-init] ' . $e->getMessage()); }
