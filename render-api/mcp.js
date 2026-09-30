// AI tool layer (MCP, Streamable HTTP, stateless) at /mcp. Every tool calls the
// same service function as the HTTP API, with the calling app's own permissions.
// There is deliberately no tool that approves, deletes or overwrites anything:
// approvals stay with people (Design Jobs page, or a system holding "approve").
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { ApiError } from './common.js';
import * as svc from './services.js';
import { one } from './db.js';
import { filesOf, readFile } from './storage.js';

const orderFields = {
  order_id: z.string().max(100).optional().describe('CRM / Printshop order id this work belongs to'),
  customer_id: z.string().max(100).optional(),
  lead_id: z.string().max(100).optional(),
};
const artworkSource = {
  artwork_id: z.string().optional().describe('ART_… id from analyze_artwork (preferred)'),
  artwork_url: z.string().url().optional().describe('Public http(s) URL of a PNG/JPEG'),
  artwork_base64: z.string().optional().describe('PNG/JPEG as base64 or data URL'),
};

const json = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data });
const fail = (e) => ({
  isError: true,
  content: [{ type: 'text', text: e instanceof ApiError ? `${e.code}: ${e.message}${e.extra ? `\n${JSON.stringify(e.extra, null, 2)}` : ''}` : 'Internal error.' }],
});

async function preview(jobId) {
  const f = (await filesOf('job', jobId)).find(x => x.kind === 'mockup');
  if (!f) return null;
  const img = await loadImage(await readFile(f));
  const c = createCanvas(560, 680);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 560, 680);
  ctx.drawImage(img, 0, 0, 560, 680);
  return { type: 'image', data: (await c.encode('png')).toString('base64'), mimeType: 'image/png' };
}

function buildServer(ctx) {
  const server = new McpServer({ name: 'decoinks-design-studio', version: '2.0.0' }, {
    instructions: 'Design Studio production tools. Always analyze_artwork first and use its artwork_id. Mockups use exact inches; read final_print_width_in, scale_status and warnings — never guess sizes from the image. Nothing you make is approved: a person approves mockups before customers see them, and QA approves gang sheets before print files are released. You cannot approve anything; say so if asked.',
  });
  const tool = (name, config, fn) => server.registerTool(name, config, async (args) => {
    try { return await fn(args || {}); } catch (e) { if (!(e instanceof ApiError)) console.error('[mcp]', name, e); return fail(e); }
  });

  tool('get_mockup_options', {
    title: 'Mockup options',
    description: 'Sizes, colours, garment photos and placements (with default and maximum print sizes) that generate_mockup accepts.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => json(await svc.mockupOptions(ctx)));

  tool('analyze_artwork', {
    title: 'Analyze artwork',
    description: 'Store an artwork and measure it with code (not vision): pixel size, aspect ratio, alpha/transparency status, real vs fake checkerboard background, content bounds/padding, DPI metadata and warnings. Returns artwork_id for the other tools. The same file returns the same artwork_id.',
    inputSchema: { ...artworkSource, name: z.string().max(200).optional(), ...orderFields },
    annotations: { readOnlyHint: false, idempotentHint: true },
  }, async (a) => json(await svc.analyzeArtwork(ctx, a)));

  tool('prepare_artwork', {
    title: 'Prepare artwork',
    description: 'Make a cleaned copy of an artwork (the original is kept): remove_background none|auto|white|solid|checkerboard|fast|balanced|precision, trim empty margins, resample to target_print_width_in at target_dpi. Any background removal puts the copy in human review before production.',
    inputSchema: {
      artwork_id: z.string(),
      remove_background: z.enum(['none', 'auto', 'white', 'solid', 'checkerboard', 'fast', 'balanced', 'precision']).optional(),
      trim: z.boolean().optional(),
      target_print_width_in: z.number().min(0.5).max(24).optional(),
      target_dpi: z.number().min(72).max(600).optional(),
      ...orderFields,
    },
    annotations: { idempotentHint: false },
  }, async (a) => json(await svc.prepare(ctx, a)));

  tool('generate_mockup', {
    title: 'Generate exact mockup',
    description: 'Render an exact garment mockup from inch-based sizes. Returns job_id, mockup_url, final_print_width_in/height_in, scale_status and warnings, plus a small preview image. The mockup still needs a person\'s approval before it is sent to the customer.',
    inputSchema: {
      ...artworkSource,
      garment_style: z.string().max(80).optional().describe('e.g. "Gildan 5000", "Hoodie"'),
      garment_type: z.string().max(40).optional().describe('T-Shirt (default), Hoodie, Tank Top, V-Neck …'),
      garment_fit: z.enum(['Men', 'Women', 'Kids']).optional(),
      garment_size: z.string().max(20).optional().describe('e.g. "Adult L", "2XL", "Youth M" (default L)'),
      garment_color: z.string().max(30).optional().describe('Name (Black, Navy, Sport Grey …) or hex (default Black)'),
      side: z.enum(['front', 'back']).optional(),
      placement: z.enum(['front_center', 'left_chest', 'right_chest', 'pocket', 'back_center', 'back_neck', 'custom']).optional(),
      custom_x_in: z.number().optional(), custom_y_in: z.number().optional(),
      requested_print_width_in: z.number().min(0.25).max(30).optional(),
      requested_print_height_in: z.number().min(0.25).max(40).optional(),
      max_print_width_in: z.number().min(0.25).max(30).optional(),
      max_print_height_in: z.number().min(0.25).max(40).optional(),
      generate_label: z.boolean().optional().describe('Print garment, size, placement and final print size on the image'),
      background: z.string().max(20).optional().describe('"transparent" (default) or a colour'),
      ...orderFields,
    },
    annotations: { idempotentHint: true },
  }, async (a) => {
    const result = await svc.generateMockup(ctx, a);
    const img = result.status === 'ready' ? await preview(result.job_id) : null;
    const out = json(result);
    if (img) out.content.push(img);
    return out;
  });

  tool('create_gangsheet', {
    title: 'Create draft gang sheet',
    description: 'Nest artworks on DTF film (default 22" wide, sheets up to 108") at 300 DPI. Prefer mockup_job_id items so print sizes match the approved mockup. Returns a job (usually queued — poll get_design_job_status). The full-resolution print file is only released after a person approves it in QA.',
    inputSchema: {
      items: z.array(z.object({
        mockup_job_id: z.string().optional(),
        artwork_id: z.string().optional(),
        artwork_url: z.string().url().optional(),
        name: z.string().max(80).optional(),
        width_in: z.number().min(0.1).max(24).optional(),
        height_in: z.number().min(0.1).max(200).optional(),
        quantity: z.number().int().min(1).max(500).optional(),
      })).min(1).max(25),
      film_width_in: z.number().min(10).max(24).optional(),
      max_length_in: z.number().min(12).max(200).optional(),
      h_gap_in: z.number().min(0).max(5).optional(), v_gap_in: z.number().min(0).max(5).optional(),
      include_header: z.boolean().optional(), po_number: z.string().max(40).optional(), order_number: z.string().max(40).optional(),
      order_link: z.string().max(500).optional(),
      ...orderFields,
    },
  }, async (a) => json(await svc.createGangsheet(ctx, a)));

  tool('export_customer_preview', {
    title: 'Export customer preview',
    description: 'Package agent-approved mockups (images + size report CSV) as a ZIP link for the customer. Mockups no person has approved yet are left out; if none are approved this fails.',
    inputSchema: { order_id: z.string().max(100).optional(), job_ids: z.array(z.string()).max(200).optional() },
  }, async (a) => json(await svc.exportPackage(ctx, { ...a, output_type: 'customer_preview' })));

  tool('get_design_job_status', {
    title: 'Design job status',
    description: 'Status, outputs (fresh links), warnings and approval states of a mockup (MJ_), gang sheet (GJ_), batch (BJ_) or export (EJ_) job. Pass order_id instead to list that order\'s jobs.',
    inputSchema: { job_id: z.string().optional(), order_id: z.string().optional() },
    annotations: { readOnlyHint: true },
  }, async (a) => {
    if (a.job_id) return json(await svc.jobStatus(ctx, a.job_id));
    if (a.order_id) return json(await svc.jobsList(ctx, { order_id: a.order_id }));
    throw new ApiError(400, 'invalid_request', 'Send job_id or order_id.');
  });

  return server;
}

export async function handleMcp(req, res, ctx) {
  if (req.method !== 'POST') {
    res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Use POST (stateless Streamable HTTP).' }, id: null });
    return;
  }
  const server = buildServer({ ...ctx, via: 'mcp' });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

export { one };
