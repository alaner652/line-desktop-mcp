#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(scriptDirectory, '../src/server.js');
const chatName = process.argv[2] || 'keep筆記';
const message = process.argv[3] || '測試分享';

const client = new Client({
  name: 'line-message-script',
  version: '1.0.0',
});

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env: {
    ...process.env,
    LINE_MCP_ALLOW_AUTO_SEND: 'true',
  },
});

try {
  await client.connect(transport);
  const result = await client.callTool({
    name: 'send_message_auto',
    arguments: { chatName, message },
  });

  const responseText = result.content?.find((item) => item.type === 'text')?.text;
  console.log(responseText || JSON.stringify(result, null, 2));
} finally {
  await client.close();
}