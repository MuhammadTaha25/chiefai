import { workflow, node, trigger, sticky, newCredential, expr, languageModel } from '@n8n/workflow-sdk';

const intakeWebhook = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Lead-Gen Intake Webhook',
    parameters: {
      httpMethod: 'POST',
      path: 'lead-gen-intake',
      responseMode: 'responseNode',
    },
    position: [0, 300],
  },
  output: [
    {
      body: {
        client_id: 'ea374081-75c8-4308-a062-e463577901f3',
        job_id: '2a4e034c-b748-4119-be5a-3d4bdc55bc76',
        business_name: 'Infomist',
        what_you_sell: 'AI automation services',
        target_industries: ['Software / SaaS'],
        target_countries: ['United States'],
        contact_titles: ['Founder'],
        company_size: '51–100',
        lead_count: '100',
      },
    },
  ],
});

const geminiModel = languageModel({
  type: '@n8n/n8n-nodes-langchain.lmChatGoogleGemini',
  version: 1.1,
  config: {
    name: 'Gemini Model',
    parameters: { modelName: 'models/gemini-3.6-flash', options: { temperature: 0.2 } },
    credentials: { googlePalmApi: newCredential('Google Gemini') },
    position: [220, 500],
  },
});

const structureLeadCriteria = node({
  type: '@n8n/n8n-nodes-langchain.informationExtractor',
  version: 1.2,
  config: {
    name: 'Structure Lead Criteria',
    parameters: {
      text: expr('{{ JSON.stringify($json.body) }}'),
      schemaType: 'manual',
      inputSchema: JSON.stringify({
        type: 'object',
        properties: {
          country_codes: {
            type: 'array',
            items: { type: 'string' },
            description: 'ISO Alpha-2 country codes (e.g. US, GB, CA, AE, SA, QA, AU, DE, FR, NL, PK, IN) derived from the submitted target countries.',
          },
          job_titles: {
            type: 'array',
            items: { type: 'string' },
            description: 'Cleaned, standard job title strings derived from the submitted contact titles (e.g. "Founder", "CEO").',
          },
          company_size_band: {
            type: 'string',
            description:
              'One Explorium company-size band that best matches the submitted range: 1-10, 11-50, 51-200, 201-500, 501-1000, 1001-5000, 5001-10000, 10001+. Empty string if not specified or "Any size".',
          },
          number_of_results: { type: 'number', description: 'How many leads to search for, from the submitted lead count. Default 30 if unclear.' },
          tool_reasoning: {
            type: 'string',
            description: 'One sentence describing who to search for and why, under 400 characters, e.g. "Find Founders at Software/SaaS companies in the United States for Infomist, which sells AI automation services."',
          },
        },
        required: ['tool_reasoning'],
      }),
      options: {
        systemPromptTemplate:
          'You convert a lead-generation intake form (submitted in plain English, sometimes with typos or free text) into a structured search request for a B2B data API. ' +
          'Map target countries to ISO Alpha-2 codes. Map company size ranges to the closest Explorium band. Keep job titles as clean standard titles. ' +
          'If the client wrote "Not sure" or "Let AI decide" for a field, omit that field rather than guessing randomly. Never invent industries or titles not implied by the input.',
      },
    },
    subnodes: { model: geminiModel },
    position: [220, 300],
  },
  output: [
    {
      country_codes: ['US'],
      job_titles: ['Founder'],
      company_size_band: '51-200',
      number_of_results: 100,
      tool_reasoning: 'Find Founders at Software/SaaS companies in the United States for Infomist, which sells AI automation services.',
    },
  ],
});

const assembleFetchInput = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Assemble Fetch Input',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode:
        "const b = $('Lead-Gen Intake Webhook').first().json.body || {};\n" +
        "const ext = $input.first().json || {};\n" +
        "const filters = {};\n" +
        "if (Array.isArray(ext.country_codes) && ext.country_codes.length) filters.company_country_code = { values: ext.country_codes };\n" +
        "if (Array.isArray(ext.job_titles) && ext.job_titles.length) filters.job_title = { values: ext.job_titles };\n" +
        "if (ext.company_size_band) filters.company_size = { values: [ext.company_size_band] };\n" +
        "const limit = Math.min(Number(ext.number_of_results) || 30, 250);\n" +
        "return [{ json: {\n" +
        "  clientId: b.client_id,\n" +
        "  campaignId: b.job_id,\n" +
        "  fetchToolInput: { entity_type: 'prospects', filters, number_of_results: limit, tool_reasoning: String(ext.tool_reasoning || '').slice(0, 500) },\n" +
        "} }];",
    },
    position: [460, 300],
  },
  output: [
    {
      clientId: 'ea374081-75c8-4308-a062-e463577901f3',
      campaignId: '2a4e034c-b748-4119-be5a-3d4bdc55bc76',
      fetchToolInput: { entity_type: 'prospects', filters: { company_country_code: { values: ['US'] } }, number_of_results: 100, tool_reasoning: 'Find Founders at Software/SaaS companies in the United States for Infomist, which sells AI automation services.' },
    },
  ],
});

const discoverProspects = node({
  type: 'n8n-nodes-base.executeWorkflow',
  version: 1.3,
  config: {
    name: 'Discover Prospects (Vibe)',
    parameters: {
      source: 'database',
      workflowId: { __rl: true, mode: 'id', value: 'NnIWhDN9cBEUygF5', cachedResultName: 'Vibe Prospecting Service' },
      mode: 'once',
      workflowInputs: expr(
        '{{ { "mappingMode": "defineBelow", "value": { "operation": "discover", "fetchToolInput": $json.fetchToolInput, ' +
          '"knownProspectIds": [], "clientId": $json.clientId, "campaignId": $json.campaignId } } }}'
      ),
    },
    position: [700, 300],
  },
  output: [
    {
      status: 'ok',
      operation: 'discover',
      tableName: 'fetch_prospects_1',
      sessionId: 'session_abc123',
      clientId: 'ea374081-75c8-4308-a062-e463577901f3',
      campaignId: '2a4e034c-b748-4119-be5a-3d4bdc55bc76',
      candidates: [{ sourceLeadId: 'p1', fullName: 'Jane Doe', jobTitle: 'Founder', company: 'Example Co', location: 'United States' }],
    },
  ],
});

const enrichProspects = node({
  type: 'n8n-nodes-base.executeWorkflow',
  version: 1.3,
  config: {
    name: 'Enrich Prospects (Vibe)',
    parameters: {
      source: 'database',
      workflowId: { __rl: true, mode: 'id', value: 'NnIWhDN9cBEUygF5', cachedResultName: 'Vibe Prospecting Service' },
      mode: 'once',
      workflowInputs: expr(
        '{{ { "mappingMode": "defineBelow", "value": { "operation": "enrich_table", "tableName": $json.tableName, ' +
          '"sessionId": $json.sessionId, "clientId": $json.clientId, "campaignId": $json.campaignId } } }}'
      ),
    },
    position: [940, 300],
  },
  output: [
    {
      status: 'ok',
      operation: 'enrich_table',
      clientId: 'ea374081-75c8-4308-a062-e463577901f3',
      campaignId: '2a4e034c-b748-4119-be5a-3d4bdc55bc76',
      finalLeadCount: 1,
      leads: [{ sourceLeadId: 'p1', email: 'jane@example.com', fullName: 'Jane Doe', jobTitle: 'Founder', company: 'Example Co', companyDomain: 'example.com', location: 'United States' }],
    },
  ],
});

const splitLeads = node({
  type: 'n8n-nodes-base.splitOut',
  version: 1,
  config: {
    name: 'Split Leads',
    parameters: { fieldToSplitOut: 'leads', include: 'allOtherFields' },
    position: [1180, 300],
  },
  output: [{ sourceLeadId: 'p1', email: 'jane@example.com', fullName: 'Jane Doe', jobTitle: 'Founder', company: 'Example Co', companyDomain: 'example.com', location: 'United States', clientId: 'ea374081-75c8-4308-a062-e463577901f3', campaignId: '2a4e034c-b748-4119-be5a-3d4bdc55bc76' }],
});

const hasEmail = node({
  type: 'n8n-nodes-base.filter',
  version: 2.3,
  config: {
    name: 'Has Email',
    parameters: {
      conditions: {
        combinator: 'and',
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
        conditions: [{ leftValue: expr('{{ $json.email }}'), rightValue: '', operator: { type: 'string', operation: 'notEquals' } }],
      },
    },
    position: [1420, 300],
  },
});

const saveLeadToSupabase = node({
  type: 'n8n-nodes-base.supabase',
  version: 1,
  config: {
    name: 'Save Lead To Supabase',
    parameters: {
      resource: 'row',
      operation: 'create',
      tableId: 'leads',
      dataToSend: 'defineBelow',
      fieldsUi: {
        fieldValues: [
          { fieldId: 'client_id', fieldValue: expr('{{ $json.clientId }}') },
          { fieldId: 'email', fieldValue: expr('{{ $json.email }}') },
          { fieldId: 'name', fieldValue: expr('{{ $json.fullName }}') },
          { fieldId: 'company', fieldValue: expr('{{ $json.company }}') },
          { fieldId: 'job_title', fieldValue: expr('{{ $json.jobTitle }}') },
          { fieldId: 'status', fieldValue: 'new' },
          { fieldId: 'lead_source', fieldValue: 'vibe_prospecting' },
        ],
      },
    },
    credentials: { supabaseApi: newCredential('Supabase') },
    position: [1660, 300],
  },
  output: [{ created_at: '2026-01-01T00:00:00Z' }],
});

const queueForMailing = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Queue Lead For Mailing',
    parameters: {
      resource: 'row',
      operation: 'insert',
      dataTableId: { __rl: true, mode: 'id', value: 'OZbpSgJ4yrcTlyxY', cachedResultName: 'outreach_leads' },
      columns: expr(
        '{{ { "mappingMode": "defineBelow", "value": { ' +
          '"leadId": "VP-" + $json.clientId + "-" + Date.now() + "-" + Math.floor(Math.random()*100000), ' +
          '"email": $json.email, "name": $json.fullName, "company": $json.company, "status": "fresh", ' +
          '"touchCount": 0, "nextTouchAt": $now.toISO(), "clientId": $json.clientId, "campaignId": $json.campaignId, ' +
          '"sourceLeadId": $json.sourceLeadId, "leadSource": "vibe_prospecting", "leadType": "outbound", "intent": "cold", ' +
          '"phone": "", "adId": "", "landingPage": "", "inquiryContext": "", "leadLocation": $json.location, ' +
          '"companyDomain": $json.companyDomain, "jobTitle": $json.jobTitle } } }}'
      ),
    },
    position: [1900, 300],
  },
  output: [{ id: 1, createdAt: '2026-01-01T00:00:00Z' }],
});

const markJobCompleted = node({
  type: 'n8n-nodes-base.supabase',
  version: 1,
  config: {
    name: 'Mark Job Completed',
    parameters: {
      resource: 'row',
      operation: 'update',
      tableId: 'lead_gen_jobs',
      filterType: 'manual',
      filters: {
        conditions: [{ keyName: 'id', condition: 'eq', keyValue: expr("{{ $('Lead-Gen Intake Webhook').item.json.body.job_id }}") }],
      },
      dataToSend: 'defineBelow',
      fieldsUi: {
        fieldValues: [
          { fieldId: 'status', fieldValue: 'completed' },
          { fieldId: 'leads_found', fieldValue: expr("{{ $('Queue Lead For Mailing').all().length }}") },
        ],
      },
    },
    credentials: { supabaseApi: newCredential('Supabase') },
    position: [2140, 300],
    executeOnce: true,
  },
  output: [{ id: 'ea374081-75c8-4308-a062-e463577901f3', status: 'completed', leads_found: 1 }],
});

const respondJobDone = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond Job Done',
    parameters: {
      respondWith: 'json',
      responseBody: expr('{{ { "ok": true, "leads_found": $json.leads_found } }}'),
    },
    position: [2380, 300],
  },
});

const wf = workflow('lead-gen-intake', 'Lead-Gen Intake (Vibe Prospecting)')
  .add(
    sticky(
      '## How this works\n' +
        '1. Infomist\'s /lead-gen form saves criteria to Supabase `lead_gen_jobs`, then POSTs here.\n' +
        '2. "Structure Lead Criteria" — a Gemini-powered LLM step — reads the raw form JSON and extracts a clean, structured ' +
        'search request (ISO country codes, standard job titles, an Explorium company-size band, lead count, and a one-line ' +
        'reasoning string). "Assemble Fetch Input" then deterministically wraps that into the exact filter shape Explorium expects.\n' +
        '3. Calls the existing "Vibe Prospecting Service" workflow twice (discover, then enrich_table for emails) — reuses that ' +
        'workflow\'s already-configured Vibe Prospecting MCP credential (verified working).\n' +
        '4. Every matched lead with an email is saved to Supabase `leads` (so it shows up on the /leads dashboard) AND queued ' +
        'into the `outreach_leads` Data Table with status "fresh" — the same queue "Inbound Ad Lead Intake" uses, so the ' +
        'existing active mailing engine ("Mailgun Outreach + Inbound + 5 Follow-ups") drafts and sends the first email automatically.\n' +
        '5. Updates the Supabase `lead_gen_jobs` row and responds to the form.',
      [intakeWebhook, structureLeadCriteria, geminiModel],
      { color: 3 }
    )
  )
  .add(intakeWebhook)
  .to(
    structureLeadCriteria.to(
      assembleFetchInput.to(
        discoverProspects.to(enrichProspects.to(splitLeads.to(hasEmail)))
      )
    )
  )
  .add(hasEmail)
  .to(saveLeadToSupabase)
  .add(hasEmail)
  .to(queueForMailing.to(markJobCompleted.to(respondJobDone)));

export default wf;
