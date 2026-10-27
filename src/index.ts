#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { TwoGisClient } from './client.js';
import { FileSessionStore } from './session.js';
import { registerTools } from './tools.js';

const env = process.env;

const client = new TwoGisClient({
  store: new FileSessionStore(),
  apiKey: env.TWOGIS_API_KEY,
  login: env.TWOGIS_LOGIN,
  password: env.TWOGIS_PASSWORD,
  refreshToken: env.TWOGIS_REFRESH_TOKEN,
  locale: env.TWOGIS_LOCALE,
});

const server = new McpServer({ name: '2gis-business', version: '0.1.0' });
registerTools(server, client);

await server.connect(new StdioServerTransport());
