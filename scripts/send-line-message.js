#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(scriptDirectory, '../src/server.js');
const [chatName, message] = process.argv.slice(2);

if (!chatName || !message) {
  console.error('Usage: node scripts/send-line-message.js <chatName> <message>');
  console.error('Example: node scripts/send-line-message.js "keep筆記" "測試分享"');
  process.exit(1);
}

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