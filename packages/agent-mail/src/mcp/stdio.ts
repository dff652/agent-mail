#!/usr/bin/env node
import { AgentMailError } from "../errors.js";
import { runMcpStdio } from "./server.js";

runMcpStdio().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(err instanceof AgentMailError ? err.exitCode : 1);
});
