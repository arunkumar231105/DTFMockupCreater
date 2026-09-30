// WebMCP: offers Design Studio's production tools to an AI agent running in the
// browser (navigator.modelContext). The tools act as the signed-in person — their
// studio session — through the same /api endpoints other systems use, so the
// server applies the same checks. As on /mcp, there is no approval tool: the
// agent can prepare work, a person approves it on the Design Jobs page.

const call = async (method, path, body) => {
  const res = await fetch(path, {
    method,
    headers: {
      Authorization: `Bearer ${localStorage.getItem('auth_token') || ''}`,
      'X-DS-Via': 'webmcp',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 202) {
    const e = data.error || {};
    return { content: [{ type: 'text', text: `${e.code || res.status}: ${e.message || 'Request failed'}` }], isError: true };
  }
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
};

const orderProps = {
  order_id: { type: 'string', description: 'CRM / Printshop order id' },
  customer_id: { type: 'string' },
  lead_id: { type: 'string' },
};
const artworkProps = {
  artwork_id: { type: 'string', description: 'ART_… id from analyze_artwork (preferred)' },
  artwork_url: { type: 'string', description: 'Public http(s) URL of a PNG/JPEG' },
};

export const WEBMCP_TOOLS = [
  {
    name: 'analyze_artwork',
    description: 'Store an artwork and measure it with code: pixel size, aspect ratio, alpha status, real vs fake checkerboard background, padding, DPI and warnings. Returns artwork_id.',
    inputSchema: { type: 'object', properties: { ...artworkProps, name: { type: 'string' }, ...orderProps } },
    annotations: { idempotentHint: true },
    execute: (a) => call('POST', '/api/artworks/analyze', a),
  },
  {
    name: 'prepare_artwork',
    description: 'Make a cleaned copy of an artwork: remove_background (none|auto|white|solid|checkerboard|fast|balanced|precision), trim, resample to target_print_width_in. Background removal needs a person\'s review before production.',
    inputSchema: {
      type: 'object', required: ['artwork_id'],
      properties: {
        artwork_id: { type: 'string' },
        remove_background: { type: 'string', enum: ['none', 'auto', 'white', 'solid', 'checkerboard', 'fast', 'balanced', 'precision'] },
        trim: { type: 'boolean' }, target_print_width_in: { type: 'number' }, target_dpi: { type: 'number' }, ...orderProps,
      },
    },
    execute: (a) => call('POST', '/api/artworks/prepare', a),
  },
  {
    name: 'generate_mockup',
    description: 'Render an exact mockup (inch-based). Returns mockup_url, final print size, scale_status and warnings. A person must approve it before it goes to the customer.',
    inputSchema: {
      type: 'object',
      properties: {
        ...artworkProps,
        garment_style: { type: 'string' }, garment_type: { type: 'string' }, garment_size: { type: 'string', description: 'e.g. Adult L, 2XL, Youth M' },
        garment_color: { type: 'string' }, side: { type: 'string', enum: ['front', 'back'] },
        placement: { type: 'string', enum: ['front_center', 'left_chest', 'right_chest', 'pocket', 'back_center', 'back_neck', 'custom'] },
        custom_x_in: { type: 'number' }, custom_y_in: { type: 'number' },
        requested_print_width_in: { type: 'number' }, requested_print_height_in: { type: 'number' },
        max_print_width_in: { type: 'number' }, max_print_height_in: { type: 'number' },
        generate_label: { type: 'boolean' }, ...orderProps,
      },
    },
    annotations: { idempotentHint: true },
    execute: (a) => call('POST', '/api/mockups/generate', a),
  },
  {
    name: 'create_gangsheet',
    description: 'Nest artworks (prefer mockup_job_id items) on DTF film at 300 DPI. Creates a draft; print files are released only after QA approval by a person.',
    inputSchema: {
      type: 'object', required: ['items'],
      properties: {
        items: { type: 'array', items: { type: 'object', properties: {
          mockup_job_id: { type: 'string' }, artwork_id: { type: 'string' }, name: { type: 'string' },
          width_in: { type: 'number' }, height_in: { type: 'number' }, quantity: { type: 'integer' } } } },
        film_width_in: { type: 'number' }, po_number: { type: 'string' }, order_number: { type: 'string' }, ...orderProps,
      },
    },
    execute: (a) => call('POST', '/api/gangsheets/create', a),
  },
  {
    name: 'export_customer_preview',
    description: 'ZIP of agent-approved mockups plus a size report, for the customer. Unapproved mockups are left out.',
    inputSchema: { type: 'object', properties: { order_id: { type: 'string' }, job_ids: { type: 'array', items: { type: 'string' } } } },
    execute: (a) => call('POST', '/api/exports/package', { ...a, output_type: 'customer_preview' }),
  },
  {
    name: 'get_design_job_status',
    description: 'Status, output links, warnings and approval states of a job (MJ_/GJ_/BJ_/EJ_), or all jobs of an order_id.',
    inputSchema: { type: 'object', properties: { job_id: { type: 'string' }, order_id: { type: 'string' } } },
    annotations: { readOnlyHint: true },
    execute: (a) => a.job_id ? call('GET', `/api/jobs/${encodeURIComponent(a.job_id)}`)
      : call('GET', `/api/jobs?order_id=${encodeURIComponent(a.order_id || '')}`),
  },
];

/** Register the tools if the browser offers WebMCP. Returns an unregister function. */
export function registerWebMcpTools() {
  const mc = typeof navigator !== 'undefined' ? navigator.modelContext : null;
  if (!mc) return () => {};
  try {
    if (typeof mc.registerTool === 'function') {
      const handles = WEBMCP_TOOLS.map(t => mc.registerTool(t));
      return () => {
        handles.forEach(h => h?.unregister?.());
        if (typeof mc.unregisterTool === 'function') WEBMCP_TOOLS.forEach(t => { try { mc.unregisterTool(t.name); } catch { /* gone */ } });
      };
    }
    if (typeof mc.provideContext === 'function') {
      mc.provideContext({ tools: WEBMCP_TOOLS });
      return () => { try { mc.clearContext?.(); } catch { /* ignore */ } };
    }
  } catch (e) {
    console.warn('[webmcp] could not register tools', e);
  }
  return () => {};
}
