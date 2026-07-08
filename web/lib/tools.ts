// Minimal tool registry to define the agent action space (MVP)
// These are thin, JSON-schema-like descriptors the orchestrator/LLM can reference.

export const tools = [
  {
    name: 'visualize_generate',
    description: 'Text or image prompt -> N image candidates for selection',
    schema: {
      type: 'object',
      required: ['prompt'],
      properties: {
        prompt: { type: 'string' },
        n: { type: 'integer', minimum: 1, maximum: 6 },
        style: { enum: ['figurine', 'mechanical', 'organic'] },
      },
    },
  },
  {
    name: 'list_angles_for_active_concept',
    description: 'Return angles for the active/selected concept (labels + image ids)',
    schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_active_concept',
    description: 'Return which concept image (id and 1-based index) the current mesh comes from',
    schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'compare_mesh_to_concepts',
    description: 'Best-effort: map current mesh to the latest candidate set (uses provenance first)',
    schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'context_refresh',
    description: 'Return a compact snapshot of the current order (images, STL, metrics, quote)',
    schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'attachment_promote_concept',
    description: 'Turn uploaded attachments into concept candidates without edits',
    schema: {
      type: 'object',
      required: ['assetIds'],
      properties: {
        assetIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 6 },
      },
    },
  },
  {
    name: 'attachment_edit',
    description: 'Run the edit provider on an attachment using the supplied prompt',
    schema: {
      type: 'object',
      required: ['assetId', 'prompt'],
      properties: {
        assetId: { type: 'string' },
        prompt: { type: 'string' },
        n: { type: 'integer', minimum: 1, maximum: 4 },
        format: { enum: ['jpeg', 'png'] },
      },
    },
  },
  {
    name: 'attachment_generate_angles',
    description: 'Generate additional camera angles for an attachment',
    schema: {
      type: 'object',
      required: ['assetId'],
      properties: {
        assetId: { type: 'string' },
        angles: {
          type: 'array',
          items: { enum: ['front', 'back', 'left', 'right', 'top', 'bottom'] },
          minItems: 1,
          maxItems: 5,
        },
        prompt: { type: 'string' },
      },
    },
  },
  {
    name: 'visualize_select',
    description: 'User selected images to move to materialization',
    schema: {
      type: 'object',
      required: ['imageIds'],
      properties: {
        imageIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 6 },
      },
    },
  },
  {
    name: 'materialize_i23d',
    description: 'Convert selected images to a 3D mesh',
    schema: {
      type: 'object',
      // Accept either imageIds or imageUrls; the server-side adapter
      // resolves IDs to URLs and handles mirroring. Neither field is
      // strictly required so the agent can choose the most convenient.
      properties: {
        imageIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 6 },
        imageUrls: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'concept_edit',
    description: 'Edit the currently selected concept image to new variants',
    schema: {
      type: 'object',
      required: ['prompt'],
      properties: {
        imageId: { type: 'string' },
        prompt: { type: 'string' },
        n: { type: 'integer', minimum: 1, maximum: 2 },
        format: { enum: ['jpeg', 'png'] },
      },
    },
  },
  {
    name: 'repair_and_validate',
    description: 'Repair raw mesh -> printable STL; return checks + URL',
    schema: {
      type: 'object',
      required: ['meshUrl'],
      properties: { meshUrl: { type: 'string', format: 'uri' } },
    },
  },
  {
    name: 'fabricate_mesh',
    description: 'Repair, validate, and slice the current concept into a print-ready quote',
    schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'slice_and_quote',
    description: 'Slice STL with fixed profile -> minutes, grams, price + 3MF',
    schema: {
      type: 'object',
      // stlUrl is optional; server will use latest repaired STL when absent
      properties: { stlUrl: { type: 'string', format: 'uri' } },
    },
  },
  {
    name: 'dispatch_print',
    description: 'Phase-1: return bambu-connect deep link for operator',
    schema: {
      type: 'object',
      required: ['threeMfUrl', 'orderId'],
      properties: {
        threeMfUrl: { type: 'string', format: 'uri' },
        orderId: { type: 'string' },
      },
    },
  },
  {
    name: 'viewer_focus',
    description: 'Tell the center viewer what to display',
    schema: {
      type: 'object',
      required: ['kind', 'url'],
      properties: { kind: { enum: ['stl', 'glb', 'gltf', 'obj', 'toolpath'] }, url: { type: 'string', format: 'uri' } },
    },
  },
] as const

export type ToolName = typeof tools[number]['name']
